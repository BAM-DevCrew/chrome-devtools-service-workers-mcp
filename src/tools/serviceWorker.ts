/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ServiceWorkerContext,
  ServiceWorkerLogEntry,
} from '../ServiceWorkerCollector.js';
import {zod} from '../third_party/index.js';
import {paginate} from '../utils/pagination.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

const SW_MESSAGE_TYPES: [string, ...string[]] = [
  'log',
  'debug',
  'info',
  'error',
  'warn',
  'dir',
  'dirxml',
  'table',
  'trace',
  'clear',
  'assert',
  'count',
  'timeEnd',
];

function formatContext(ctx: ServiceWorkerContext): string {
  const parts = [
    `targetId=${ctx.targetId}`,
    `[${ctx.type}]`,
    ctx.url,
  ];
  if (ctx.extensionId) {
    parts.push(`(extensionId: ${ctx.extensionId})`);
  }
  parts.push(`${ctx.runningStatus}/${ctx.status}`);
  return parts.join(' ');
}

function formatLogEntry(
  log: ServiceWorkerLogEntry & {context: ServiceWorkerContext},
  stableId: number,
): string {
  if (log.kind === 'console') {
    const extensionTag = log.context.extensionId
      ? ` [ext:${log.context.extensionId}]`
      : '';
    return `msgid=${stableId} [${log.message.type}]${extensionTag} ${log.message.text}`;
  }
  const extensionTag = log.context.extensionId
    ? ` [ext:${log.context.extensionId}]`
    : '';
  return `msgid=${stableId} [exception]${extensionTag} ${log.exception.text}`;
}

function formatLogEntryDetailed(
  log: ServiceWorkerLogEntry & {context: ServiceWorkerContext},
  stableId: number,
): string {
  const lines: string[] = [];
  lines.push(`ID: ${stableId}`);
  lines.push(`Source: ${log.context.url}`);
  if (log.context.extensionId) {
    lines.push(`Extension: ${log.context.extensionId}`);
  }

  if (log.kind === 'console') {
    lines.push(`Type: ${log.message.type}`);
    lines.push(`Message: ${log.message.text}`);
    if (log.message.args.length > 0) {
      lines.push('### Arguments');
      for (let i = 0; i < log.message.args.length; i++) {
        const arg = log.message.args[i];
        let value: string;
        if (arg.value !== undefined) {
          value = JSON.stringify(arg.value);
        } else if (arg.description) {
          value = arg.description;
        } else if (arg.unserializableValue) {
          value = arg.unserializableValue;
        } else {
          value = `(${arg.type})`;
        }
        lines.push(`Arg #${i}: ${value}`);
      }
    }
    if (log.message.stackTrace) {
      lines.push('### Stack trace');
      for (const frame of log.message.stackTrace.callFrames) {
        lines.push(
          `  at ${frame.functionName || '(anonymous)'} (${frame.url}:${frame.lineNumber}:${frame.columnNumber})`,
        );
      }
    }
  } else {
    lines.push(`Type: exception`);
    lines.push(`Message: ${log.exception.text}`);
    if (log.exception.url) {
      lines.push(
        `Location: ${log.exception.url}:${log.exception.lineNumber}:${log.exception.columnNumber}`,
      );
    }
    if (log.exception.stackTrace) {
      lines.push('### Stack trace');
      for (const frame of log.exception.stackTrace.callFrames) {
        lines.push(
          `  at ${frame.functionName || '(anonymous)'} (${frame.url}:${frame.lineNumber}:${frame.columnNumber})`,
        );
      }
    }
  }

  return lines.join('\n');
}

export const listServiceWorkerContexts = defineTool({
  name: 'list_service_worker_contexts',
  description:
    'List all discovered service worker contexts, including extension service workers and PWA service workers.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    extensionId: zod
      .string()
      .optional()
      .describe(
        'Filter to only show service workers for a specific extension ID.',
      ),
  },
  handler: async (request, response, context) => {
    const contexts = request.params.extensionId
      ? context.getServiceWorkerContextsByExtensionId(
          request.params.extensionId,
        )
      : context.getServiceWorkerContexts();

    if (contexts.length === 0) {
      response.appendResponseLine('No service worker contexts found.');
      return;
    }

    response.appendResponseLine(`Found ${contexts.length} service worker(s):`);
    for (const ctx of contexts) {
      response.appendResponseLine(formatContext(ctx));
    }
  },
});

export const listServiceWorkerConsoleMessages = defineTool({
  name: 'list_service_worker_console_messages',
  description:
    'List console messages from service workers. Can filter by extension ID and message type.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    extensionId: zod
      .string()
      .optional()
      .describe(
        'Filter messages to a specific extension by its ID.',
      ),
    types: zod
      .array(zod.enum(SW_MESSAGE_TYPES))
      .optional()
      .describe(
        'Filter messages to only return messages of the specified types. When omitted, returns all messages.',
      ),
    pageSize: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum number of messages to return. When omitted, returns all messages.',
      ),
    pageIdx: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Page number to return (0-based). When omitted, returns the first page.',
      ),
  },
  handler: async (request, response, context) => {
    let logs = request.params.extensionId
      ? context.getServiceWorkerLogsByExtensionId(request.params.extensionId)
      : context.getServiceWorkerLogs();

    if (request.params.types?.length) {
      const typeSet = new Set(request.params.types);
      logs = logs.filter(log => {
        if (log.kind === 'console') {
          return typeSet.has(log.message.type);
        }
        return typeSet.has('error');
      });
    }

    if (logs.length === 0) {
      response.appendResponseLine(
        '<no service worker console messages found>',
      );
      return;
    }

    const hasPagination =
      request.params.pageSize !== undefined ||
      request.params.pageIdx !== undefined;
    const paginationResult = paginate(
      logs,
      hasPagination
        ? {
            pageSize: request.params.pageSize,
            pageIdx: request.params.pageIdx,
          }
        : undefined,
    );

    if (paginationResult.invalidPage) {
      response.appendResponseLine(
        'Invalid page number provided. Showing first page.',
      );
    }

    const {startIndex, endIndex, currentPage, totalPages} = paginationResult;
    response.appendResponseLine(
      `Showing ${startIndex + 1}-${endIndex} of ${logs.length} (Page ${currentPage + 1} of ${totalPages}).`,
    );
    if (hasPagination) {
      if (paginationResult.hasNextPage) {
        response.appendResponseLine(`Next page: ${currentPage + 1}`);
      }
      if (paginationResult.hasPreviousPage) {
        response.appendResponseLine(`Previous page: ${currentPage - 1}`);
      }
    }

    for (const log of paginationResult.items) {
      const stableId = context.getServiceWorkerLogStableId(log);
      response.appendResponseLine(formatLogEntry(log, stableId));
    }
  },
});

export const getServiceWorkerConsoleMessage = defineTool({
  name: 'get_service_worker_console_message',
  description: `Gets a service worker console message by its ID. You can get all messages by calling ${listServiceWorkerConsoleMessages.name}.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    msgid: zod
      .number()
      .describe(
        'The msgid of a service worker console message from the listed messages.',
      ),
  },
  handler: async (request, response, context) => {
    const log = context.getServiceWorkerLogById(request.params.msgid);
    if (!log) {
      throw new Error(
        `Service worker console message with ID ${request.params.msgid} not found.`,
      );
    }
    response.appendResponseLine(
      formatLogEntryDetailed(log, request.params.msgid),
    );
  },
});

export const clearServiceWorkerConsole = defineTool({
  name: 'clear_service_worker_console',
  description:
    'Clears collected service worker console messages. Can clear for a specific target or all targets.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    targetId: zod
      .string()
      .optional()
      .describe(
        'Target ID of a specific service worker to clear logs for. When omitted, clears all service worker logs.',
      ),
  },
  handler: async (request, response, context) => {
    context.clearServiceWorkerLogs(request.params.targetId);
    response.appendResponseLine('Service worker console messages cleared.');
  },
});
