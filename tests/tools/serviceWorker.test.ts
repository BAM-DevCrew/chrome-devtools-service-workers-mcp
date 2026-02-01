/**
 * @license
 * Copyright 2025 BAM-DevCrew
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import type {
  ServiceWorkerContext,
  ServiceWorkerLogEntry,
} from '../../src/ServiceWorkerCollector.js';
import {
  listServiceWorkerContexts,
  listServiceWorkerConsoleMessages,
  getServiceWorkerConsoleMessage,
  clearServiceWorkerConsole,
} from '../../src/tools/serviceWorker.js';
import {withMcpContext} from '../utils.js';

function makeContext(
  overrides: Partial<ServiceWorkerContext> = {},
): ServiceWorkerContext {
  return {
    targetId: 'target-1',
    sessionId: 'session-1',
    url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaapp/service_worker.js',
    extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaapp',
    runningStatus: 'running',
    status: 'activated',
    type: 'extension_service_worker',
    ...overrides,
  };
}

function makeConsoleLog(
  overrides: Partial<{
    type: string;
    text: string;
    timestamp: number;
    context: ServiceWorkerContext;
  }> = {},
): ServiceWorkerLogEntry & {context: ServiceWorkerContext} {
  return {
    kind: 'console',
    message: {
      type: overrides.type ?? 'log',
      text: overrides.text ?? 'test message',
      args: [],
      timestamp: overrides.timestamp ?? 1000,
    },
    context: overrides.context ?? makeContext(),
  };
}

function makeExceptionLog(
  overrides: Partial<{
    text: string;
    timestamp: number;
    context: ServiceWorkerContext;
  }> = {},
): ServiceWorkerLogEntry & {context: ServiceWorkerContext} {
  return {
    kind: 'exception',
    exception: {
      text: overrides.text ?? 'Uncaught Error: test',
      lineNumber: 10,
      columnNumber: 5,
      url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaapp/service_worker.js',
      timestamp: overrides.timestamp ?? 2000,
    },
    context: overrides.context ?? makeContext(),
  };
}

describe('serviceWorker', () => {
  describe('list_service_worker_contexts', () => {
    it('shows message when no contexts found', async () => {
      await withMcpContext(async (response, context) => {
        sinon.stub(context, 'getServiceWorkerContexts').returns([]);

        await listServiceWorkerContexts.handler(
          {params: {}},
          response,
          context,
        );

        assert.ok(
          response.responseLines[0].includes('No service worker contexts'),
        );
      });
    });

    it('lists discovered contexts', async () => {
      await withMcpContext(async (response, context) => {
        const ctx1 = makeContext();
        const ctx2 = makeContext({
          targetId: 'target-2',
          sessionId: 'session-2',
          url: 'https://example.com/sw.js',
          extensionId: undefined,
          type: 'pwa_service_worker',
        });
        sinon.stub(context, 'getServiceWorkerContexts').returns([ctx1, ctx2]);

        await listServiceWorkerContexts.handler(
          {params: {}},
          response,
          context,
        );

        const lines = response.responseLines;
        assert.ok(lines[0].includes('Found 2 service worker(s)'));
        assert.ok(lines[1].includes('target-1'));
        assert.ok(lines[1].includes('extension_service_worker'));
        assert.ok(lines[2].includes('target-2'));
        assert.ok(lines[2].includes('pwa_service_worker'));
      });
    });

    it('filters by extension ID', async () => {
      await withMcpContext(async (response, context) => {
        const ctx = makeContext();
        sinon
          .stub(context, 'getServiceWorkerContextsByExtensionId')
          .withArgs('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaapp')
          .returns([ctx]);

        await listServiceWorkerContexts.handler(
          {params: {extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaapp'}},
          response,
          context,
        );

        const lines = response.responseLines;
        assert.ok(lines[0].includes('Found 1 service worker(s)'));
      });
    });
  });

  describe('list_service_worker_console_messages', () => {
    it('shows message when no logs found', async () => {
      await withMcpContext(async (response, context) => {
        sinon.stub(context, 'getServiceWorkerLogs').returns([]);

        await listServiceWorkerConsoleMessages.handler(
          {params: {}},
          response,
          context,
        );

        assert.ok(
          response.responseLines[0].includes(
            'no service worker console messages',
          ),
        );
      });
    });

    it('lists console messages with stable IDs', async () => {
      await withMcpContext(async (response, context) => {
        const log1 = makeConsoleLog({text: 'hello world'});
        const log2 = makeConsoleLog({type: 'error', text: 'something broke'});

        sinon.stub(context, 'getServiceWorkerLogs').returns([log1, log2]);
        const stableIdStub = sinon.stub(
          context,
          'getServiceWorkerLogStableId',
        );
        stableIdStub.withArgs(log1).returns(1);
        stableIdStub.withArgs(log2).returns(2);

        await listServiceWorkerConsoleMessages.handler(
          {params: {}},
          response,
          context,
        );

        const lines = response.responseLines;
        assert.ok(lines[1].includes('msgid=1'));
        assert.ok(lines[1].includes('[log]'));
        assert.ok(lines[1].includes('hello world'));
        assert.ok(lines[2].includes('msgid=2'));
        assert.ok(lines[2].includes('[error]'));
        assert.ok(lines[2].includes('something broke'));
      });
    });

    it('filters by extension ID', async () => {
      await withMcpContext(async (response, context) => {
        const log = makeConsoleLog({text: 'ext message'});

        sinon
          .stub(context, 'getServiceWorkerLogsByExtensionId')
          .withArgs('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaapp')
          .returns([log]);
        sinon.stub(context, 'getServiceWorkerLogStableId').returns(1);

        await listServiceWorkerConsoleMessages.handler(
          {
            params: {extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaapp'},
          },
          response,
          context,
        );

        const lines = response.responseLines;
        assert.ok(lines[1].includes('ext message'));
      });
    });

    it('filters by message type', async () => {
      await withMcpContext(async (response, context) => {
        const logMsg = makeConsoleLog({type: 'log', text: 'info'});
        const errorMsg = makeConsoleLog({type: 'error', text: 'failure'});
        const exceptionMsg = makeExceptionLog({text: 'crash'});

        sinon
          .stub(context, 'getServiceWorkerLogs')
          .returns([logMsg, errorMsg, exceptionMsg]);
        const stableIdStub = sinon.stub(
          context,
          'getServiceWorkerLogStableId',
        );
        stableIdStub.returns(1);

        await listServiceWorkerConsoleMessages.handler(
          {params: {types: ['error']}},
          response,
          context,
        );

        const lines = response.responseLines;
        // Should show count line + only the error and exception entries
        assert.ok(lines[0].includes('Showing 1-2 of 2'));
      });
    });

    it('paginates results', async () => {
      await withMcpContext(async (response, context) => {
        const logs = Array.from({length: 5}, (_, i) =>
          makeConsoleLog({text: `message ${i}`, timestamp: i}),
        );

        sinon.stub(context, 'getServiceWorkerLogs').returns(logs);
        sinon.stub(context, 'getServiceWorkerLogStableId').returns(1);

        await listServiceWorkerConsoleMessages.handler(
          {params: {pageSize: 2, pageIdx: 0}},
          response,
          context,
        );

        const lines = response.responseLines;
        assert.ok(lines[0].includes('Showing 1-2 of 5'));
        assert.ok(lines[0].includes('Page 1 of 3'));
        assert.ok(lines[1].includes('Next page: 1'));
      });
    });

    it('includes exception entries', async () => {
      await withMcpContext(async (response, context) => {
        const log = makeExceptionLog({text: 'Uncaught TypeError'});

        sinon.stub(context, 'getServiceWorkerLogs').returns([log]);
        sinon.stub(context, 'getServiceWorkerLogStableId').returns(42);

        await listServiceWorkerConsoleMessages.handler(
          {params: {}},
          response,
          context,
        );

        const lines = response.responseLines;
        assert.ok(lines[1].includes('msgid=42'));
        assert.ok(lines[1].includes('[exception]'));
        assert.ok(lines[1].includes('Uncaught TypeError'));
      });
    });
  });

  describe('get_service_worker_console_message', () => {
    it('returns detailed console message', async () => {
      await withMcpContext(async (response, context) => {
        const log = makeConsoleLog({text: 'detailed test'});

        sinon.stub(context, 'getServiceWorkerLogById').withArgs(5).returns(log);

        await getServiceWorkerConsoleMessage.handler(
          {params: {msgid: 5}},
          response,
          context,
        );

        const text = response.responseLines.join('\n');
        assert.ok(text.includes('ID: 5'));
        assert.ok(text.includes('Type: log'));
        assert.ok(text.includes('Message: detailed test'));
        assert.ok(text.includes('Source:'));
      });
    });

    it('returns detailed exception message', async () => {
      await withMcpContext(async (response, context) => {
        const log = makeExceptionLog({text: 'Runtime error'});

        sinon.stub(context, 'getServiceWorkerLogById').withArgs(7).returns(log);

        await getServiceWorkerConsoleMessage.handler(
          {params: {msgid: 7}},
          response,
          context,
        );

        const text = response.responseLines.join('\n');
        assert.ok(text.includes('ID: 7'));
        assert.ok(text.includes('Type: exception'));
        assert.ok(text.includes('Message: Runtime error'));
        assert.ok(text.includes('Location:'));
      });
    });

    it('includes extension ID in detailed output', async () => {
      await withMcpContext(async (response, context) => {
        const log = makeConsoleLog({text: 'ext log'});

        sinon.stub(context, 'getServiceWorkerLogById').withArgs(1).returns(log);

        await getServiceWorkerConsoleMessage.handler(
          {params: {msgid: 1}},
          response,
          context,
        );

        const text = response.responseLines.join('\n');
        assert.ok(
          text.includes('Extension: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaapp'),
        );
      });
    });

    it('throws when message not found', async () => {
      await withMcpContext(async (response, context) => {
        sinon.stub(context, 'getServiceWorkerLogById').returns(undefined);

        await assert.rejects(
          () =>
            getServiceWorkerConsoleMessage.handler(
              {params: {msgid: 999}},
              response,
              context,
            ),
          (error: Error) => {
            assert.ok(error.message.includes('999'));
            assert.ok(error.message.includes('not found'));
            return true;
          },
        );
      });
    });
  });

  describe('clear_service_worker_console', () => {
    it('clears all service worker logs', async () => {
      await withMcpContext(async (response, context) => {
        const clearStub = sinon.stub(context, 'clearServiceWorkerLogs');

        await clearServiceWorkerConsole.handler(
          {params: {}},
          response,
          context,
        );

        assert.ok(clearStub.calledOnce);
        assert.strictEqual(clearStub.firstCall.args[0], undefined);
        assert.ok(response.responseLines[0].includes('cleared'));
      });
    });

    it('clears logs for specific target', async () => {
      await withMcpContext(async (response, context) => {
        const clearStub = sinon.stub(context, 'clearServiceWorkerLogs');

        await clearServiceWorkerConsole.handler(
          {params: {targetId: 'target-1'}},
          response,
          context,
        );

        assert.ok(clearStub.calledOnceWithExactly('target-1'));
      });
    });
  });
});
