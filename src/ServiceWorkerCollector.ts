/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from './logger.js';
import type {
  Browser,
  CDPSession,
  Protocol,
} from './third_party/index.js';

export interface ServiceWorkerConsoleMessage {
  type: string;
  text: string;
  args: Protocol.Runtime.RemoteObject[];
  timestamp: number;
  stackTrace?: Protocol.Runtime.StackTrace;
  executionContextId?: number;
}

export interface ServiceWorkerException {
  text: string;
  lineNumber: number;
  columnNumber: number;
  url?: string;
  stackTrace?: Protocol.Runtime.StackTrace;
  exception?: Protocol.Runtime.RemoteObject;
  timestamp: number;
}

export interface ServiceWorkerContext {
  targetId: string;
  sessionId: string;
  url: string;
  extensionId?: string;
  extensionName?: string;
  registrationId?: string;
  versionId?: string;
  runningStatus: string;
  status: string;
  type: 'extension_service_worker' | 'pwa_service_worker' | 'other';
}

export type ServiceWorkerLogEntry = 
  | { kind: 'console'; message: ServiceWorkerConsoleMessage }
  | { kind: 'exception'; exception: ServiceWorkerException };

interface ServiceWorkerData {
  context: ServiceWorkerContext;
  logs: ServiceWorkerLogEntry[];
  session: CDPSession;
}

function createIdGenerator() {
  let i = 1;
  return () => {
    if (i === Number.MAX_SAFE_INTEGER) {
      i = 0;
    }
    return i++;
  };
}

export const serviceWorkerLogIdSymbol = Symbol('serviceWorkerLogId');
type WithSymbolId<T> = T & {
  [serviceWorkerLogIdSymbol]?: number;
};

const MAX_LOG_ENTRIES = 3000;

/**
 * Collects console messages from service workers (including extension service workers).
 *
 * This uses CDP's Target domain to discover and attach to service worker targets,
 * then enables Runtime domain to capture console messages.
 */
export class ServiceWorkerCollector {
  #browser: Browser;
  #browserSession?: CDPSession;
  // Raw CDP connection for accessing per-target sessions via _sessions map.
  // CDPSession.connection() returns the parent Connection which maintains
  // a Map<sessionId, CDPSession> of all flattened sessions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #connection?: any;
  #serviceWorkerDomainEnabled = false;
  #serviceWorkers = new Map<string, ServiceWorkerData>(); // targetId -> data
  #idGenerator = createIdGenerator();
  #disposed = false;

  constructor(browser: Browser) {
    this.#browser = browser;
  }

  async init(): Promise<void> {
    try {
      // Create a browser-level CDP session and store the raw connection.
      // The raw connection maintains a _sessions Map<sessionId, CDPSession>
      // which we need to retrieve per-target sessions during auto-attach.
      this.#browserSession = await this.#browser.target().createCDPSession();
      this.#connection = this.#browserSession.connection();

      // ServiceWorker.enable is not available at browser level in all Chrome
      // configurations (e.g., pipe mode). It's non-critical — we rely on the
      // Target domain for SW discovery. When available it provides richer
      // metadata (registrationId, versionId, runningStatus updates).
      try {
        await this.#browserSession.send('ServiceWorker.enable');
        this.#serviceWorkerDomainEnabled = true;
        logger('ServiceWorkerCollector: ServiceWorker domain enabled');
      } catch {
        logger('ServiceWorkerCollector: ServiceWorker domain unavailable (expected with pipe transport)');
      }

      // Enable target discovery
      await this.#browserSession.send('Target.setDiscoverTargets', {
        discover: true,
      });

      // Set up auto-attach for service workers
      await this.#browserSession.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [
          { type: 'service_worker' },
        ],
      });

      // Listen for target events
      this.#browserSession.on('Target.targetCreated', this.#onTargetCreated);
      this.#browserSession.on('Target.targetDestroyed', this.#onTargetDestroyed);
      this.#browserSession.on('Target.attachedToTarget', this.#onAttachedToTarget);
      this.#browserSession.on('Target.detachedFromTarget', this.#onDetachedFromTarget);

      // Listen for service worker metadata updates (only available when
      // ServiceWorker domain is enabled)
      if (this.#serviceWorkerDomainEnabled) {
        this.#browserSession.on('ServiceWorker.workerVersionUpdated', this.#onWorkerVersionUpdated);
        this.#browserSession.on('ServiceWorker.workerErrorReported', this.#onWorkerErrorReported);
      }

      // Discover existing targets
      const { targetInfos } = await this.#browserSession.send('Target.getTargets');
      for (const targetInfo of targetInfos) {
        if (targetInfo.type === 'service_worker') {
          await this.#attachToTarget(targetInfo.targetId, targetInfo);
        }
      }

      logger('ServiceWorkerCollector: Initialized successfully');
    } catch (error) {
      logger('ServiceWorkerCollector: Error during initialization', error);
    }
  }

  dispose(): void {
    this.#disposed = true;

    if (this.#browserSession) {
      this.#browserSession.off('Target.targetCreated', this.#onTargetCreated);
      this.#browserSession.off('Target.targetDestroyed', this.#onTargetDestroyed);
      this.#browserSession.off('Target.attachedToTarget', this.#onAttachedToTarget);
      this.#browserSession.off('Target.detachedFromTarget', this.#onDetachedFromTarget);

      if (this.#serviceWorkerDomainEnabled) {
        this.#browserSession.off('ServiceWorker.workerVersionUpdated', this.#onWorkerVersionUpdated);
        this.#browserSession.off('ServiceWorker.workerErrorReported', this.#onWorkerErrorReported);
      }

      // Detach from all service workers
      for (const [_targetId, data] of this.#serviceWorkers) {
        try {
          data.session.removeAllListeners();
        } catch {
          // Ignore errors during cleanup
        }
      }

      this.#serviceWorkers.clear();
    }

    this.#connection = undefined;
  }

  #onTargetCreated = async (event: Protocol.Target.TargetCreatedEvent): Promise<void> => {
    if (this.#disposed) return;
    
    const { targetInfo } = event;
    if (targetInfo.type === 'service_worker') {
      logger('ServiceWorkerCollector: Target created', targetInfo.targetId, targetInfo.url);
      await this.#attachToTarget(targetInfo.targetId, targetInfo);
    }
  };

  #onTargetDestroyed = (event: Protocol.Target.TargetDestroyedEvent): void => {
    if (this.#disposed) return;
    
    const { targetId } = event;
    if (this.#serviceWorkers.has(targetId)) {
      logger('ServiceWorkerCollector: Target destroyed', targetId);
      const data = this.#serviceWorkers.get(targetId);
      if (data) {
        data.session.removeAllListeners();
      }
      this.#serviceWorkers.delete(targetId);
    }
  };

  #onAttachedToTarget = async (event: Protocol.Target.AttachedToTargetEvent): Promise<void> => {
    if (this.#disposed) return;
    
    const { sessionId, targetInfo } = event;
    if (targetInfo.type === 'service_worker') {
      logger('ServiceWorkerCollector: Auto-attached to target', targetInfo.targetId);
      await this.#setupSession(targetInfo.targetId, sessionId, targetInfo);
    }
  };

  #onDetachedFromTarget = (event: Protocol.Target.DetachedFromTargetEvent): void => {
    if (this.#disposed) return;
    
    const { targetId } = event;
    if (targetId && this.#serviceWorkers.has(targetId)) {
      logger('ServiceWorkerCollector: Detached from target', targetId);
      const data = this.#serviceWorkers.get(targetId);
      if (data) {
        data.session.removeAllListeners();
      }
      this.#serviceWorkers.delete(targetId);
    }
  };

  #onWorkerVersionUpdated = (event: Protocol.ServiceWorker.WorkerVersionUpdatedEvent): void => {
    if (this.#disposed) return;
    
    // Update metadata for service workers
    for (const version of event.versions) {
      if (version.targetId) {
        const data = this.#serviceWorkers.get(version.targetId);
        if (data) {
          data.context.registrationId = version.registrationId;
          data.context.versionId = version.versionId;
          data.context.runningStatus = version.runningStatus;
          data.context.status = version.status;
        }
      }
    }
  };

  #onWorkerErrorReported = (event: Protocol.ServiceWorker.WorkerErrorReportedEvent): void => {
    if (this.#disposed) return;
    
    // Try to associate error with a service worker
    const { errorMessage } = event;
    logger('ServiceWorkerCollector: Worker error reported', errorMessage);
    
    // Find the SW by registration/version ID if possible
    for (const data of this.#serviceWorkers.values()) {
      if (data.context.registrationId === errorMessage.registrationId) {
        this.#appendLog(data, {
          kind: 'exception',
          exception: {
            text: errorMessage.errorMessage,
            lineNumber: errorMessage.lineNumber,
            columnNumber: errorMessage.columnNumber,
            url: errorMessage.sourceURL,
            timestamp: Date.now(),
          },
        });
        break;
      }
    }
  };

  async #attachToTarget(targetId: string, targetInfo: Protocol.Target.TargetInfo): Promise<void> {
    if (this.#disposed || this.#serviceWorkers.has(targetId)) return;
    
    try {
      if (!this.#browserSession) return;
      
      // Attach to the service worker target
      const { sessionId } = await this.#browserSession.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      
      await this.#setupSession(targetId, sessionId, targetInfo);
    } catch (error) {
      logger('ServiceWorkerCollector: Error attaching to target', targetId, error);
    }
  }

  async #setupSession(
    targetId: string,
    sessionId: string,
    targetInfo: Protocol.Target.TargetInfo
  ): Promise<void> {
    if (this.#disposed || !this.#browserSession) return;
    if (this.#serviceWorkers.has(targetId)) return;

    try {
      // Get the CDPSession for this target from the connection's internal
      // sessions map. When Target.setAutoAttach uses flatten: true, Puppeteer
      // creates a CDPSession for each attached target in this map.
      const session = this.#connection?._sessions?.get(sessionId);
      if (!session) {
        logger('ServiceWorkerCollector: Could not get session for', sessionId);
        return;
      }

      // Parse extension info from URL
      const extensionMatch = targetInfo.url.match(/^chrome-extension:\/\/([a-p]{32})\//);

      const extensionId = extensionMatch?.[1];
      
      const context: ServiceWorkerContext = {
        targetId,
        sessionId,
        url: targetInfo.url,
        extensionId,
        runningStatus: 'running',
        status: 'activated',
        type: extensionId ? 'extension_service_worker' : 
              targetInfo.url.startsWith('http') ? 'pwa_service_worker' : 'other',
      };

      const data: ServiceWorkerData = {
        context,
        logs: [],
        session,
      };

      this.#serviceWorkers.set(targetId, data);

      // Enable Runtime to capture console messages
      await session.send('Runtime.enable');
      
      // Listen for console API calls
      session.on('Runtime.consoleAPICalled', (params: Protocol.Runtime.ConsoleAPICalledEvent) => {
        this.#onConsoleAPICalled(targetId, params);
      });

      // Listen for exceptions
      session.on('Runtime.exceptionThrown', (params: Protocol.Runtime.ExceptionThrownEvent) => {
        this.#onExceptionThrown(targetId, params);
      });

      logger('ServiceWorkerCollector: Session set up for', targetId, targetInfo.url);
    } catch (error) {
      logger('ServiceWorkerCollector: Error setting up session', targetId, error);
    }
  }

  #appendLog(data: ServiceWorkerData, logEntry: WithSymbolId<ServiceWorkerLogEntry>): void {
    logEntry[serviceWorkerLogIdSymbol] = this.#idGenerator();
    data.logs.push(logEntry);
    if (data.logs.length > MAX_LOG_ENTRIES) {
      data.logs.splice(0, data.logs.length - MAX_LOG_ENTRIES);
    }
  }

  #onConsoleAPICalled(targetId: string, params: Protocol.Runtime.ConsoleAPICalledEvent): void {
    if (this.#disposed) return;

    const data = this.#serviceWorkers.get(targetId);
    if (!data) return;

    // Convert args to text representation
    const textParts = params.args.map(arg => {
      if (arg.value !== undefined) {
        return String(arg.value);
      }
      if (arg.description) {
        return arg.description;
      }
      if (arg.unserializableValue) {
        return arg.unserializableValue;
      }
      return arg.type;
    });

    this.#appendLog(data, {
      kind: 'console',
      message: {
        type: params.type,
        text: textParts.join(' '),
        args: params.args,
        timestamp: params.timestamp,
        stackTrace: params.stackTrace,
        executionContextId: params.executionContextId,
      },
    });
  }

  #onExceptionThrown(targetId: string, params: Protocol.Runtime.ExceptionThrownEvent): void {
    if (this.#disposed) return;

    const data = this.#serviceWorkers.get(targetId);
    if (!data) return;

    const { exceptionDetails } = params;
    this.#appendLog(data, {
      kind: 'exception',
      exception: {
        text: exceptionDetails.text,
        lineNumber: exceptionDetails.lineNumber,
        columnNumber: exceptionDetails.columnNumber,
        url: exceptionDetails.url,
        stackTrace: exceptionDetails.stackTrace,
        exception: exceptionDetails.exception,
        timestamp: params.timestamp,
      },
    });
  }

  /**
   * Get all service worker contexts (for listing available contexts)
   */
  getContexts(): ServiceWorkerContext[] {
    return Array.from(this.#serviceWorkers.values()).map(data => data.context);
  }

  /**
   * Get contexts filtered by extension ID
   */
  getContextsByExtensionId(extensionId: string): ServiceWorkerContext[] {
    return this.getContexts().filter(ctx => ctx.extensionId === extensionId);
  }

  /**
   * Get console logs for all service workers
   */
  getAllLogs(): Array<WithSymbolId<ServiceWorkerLogEntry> & { context: ServiceWorkerContext }> {
    const allLogs: Array<WithSymbolId<ServiceWorkerLogEntry> & { context: ServiceWorkerContext }> = [];
    
    for (const data of this.#serviceWorkers.values()) {
      for (const log of data.logs) {
        allLogs.push({
          ...log,
          context: data.context,
        });
      }
    }
    
    // Sort by timestamp
    allLogs.sort((a, b) => {
      const tsA = a.kind === 'console' ? a.message.timestamp : a.exception.timestamp;
      const tsB = b.kind === 'console' ? b.message.timestamp : b.exception.timestamp;
      return tsA - tsB;
    });
    
    return allLogs;
  }

  /**
   * Get console logs for a specific extension
   */
  getLogsByExtensionId(extensionId: string): Array<WithSymbolId<ServiceWorkerLogEntry> & { context: ServiceWorkerContext }> {
    return this.getAllLogs().filter(log => log.context.extensionId === extensionId);
  }

  /**
   * Get console logs for a specific target
   */
  getLogsByTargetId(targetId: string): ServiceWorkerLogEntry[] {
    const data = this.#serviceWorkers.get(targetId);
    return data?.logs ?? [];
  }

  /**
   * Get a log entry by its stable ID
   */
  getLogById(stableId: number): (ServiceWorkerLogEntry & { context: ServiceWorkerContext }) | undefined {
    for (const data of this.#serviceWorkers.values()) {
      for (const log of data.logs) {
        if ((log as WithSymbolId<ServiceWorkerLogEntry>)[serviceWorkerLogIdSymbol] === stableId) {
          return {
            ...log,
            context: data.context,
          };
        }
      }
    }
    return undefined;
  }

  /**
   * Get the stable ID for a log entry
   */
  getIdForLog(log: ServiceWorkerLogEntry): number {
    return (log as WithSymbolId<ServiceWorkerLogEntry>)[serviceWorkerLogIdSymbol] ?? -1;
  }

  /**
   * Clear logs for a specific target or all targets
   */
  clearLogs(targetId?: string): void {
    if (targetId) {
      const data = this.#serviceWorkers.get(targetId);
      if (data) {
        data.logs = [];
      }
    } else {
      for (const data of this.#serviceWorkers.values()) {
        data.logs = [];
      }
    }
  }
}
