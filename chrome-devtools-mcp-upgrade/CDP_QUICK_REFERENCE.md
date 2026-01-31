# CDP Quick Reference: Service Worker Console Access

## Discovery Flow

```
1. ServiceWorker.enable()
   └─> ServiceWorker.workerVersionUpdated event
       └─> version.targetId (if running)

2. Target.setDiscoverTargets({ discover: true })
   └─> Target.targetCreated events
       └─> targetInfo.type === 'service_worker'
```

## Attachment Flow

```
Target.attachToTarget({ targetId, flatten: true })
  └─> returns { sessionId }
      └─> All subsequent commands use this sessionId

Runtime.enable(null, sessionId)
  └─> Runtime.consoleAPICalled events include sessionId
```

## Key CDP Commands

### Browser Session (no sessionId)

```javascript
// Discover all targets
await cdp.send('Target.setDiscoverTargets', { discover: true });

// Track service workers
await cdp.send('ServiceWorker.enable');

// List all available targets
const { targetInfos } = await cdp.send('Target.getTargets');
```

### Per-Target Session (with sessionId)

```javascript
// Attach to service worker
const { sessionId } = await cdp.send('Target.attachToTarget', {
  targetId: 'SW_TARGET_ID',
  flatten: true
});

// Enable console tracking on that session
await cdp.send('Runtime.enable', {}, sessionId);

// Evaluate in SW context
const result = await cdp.send('Runtime.evaluate', {
  expression: 'chrome.runtime.id'
}, sessionId);
```

## Event Patterns

### Service Worker Lifecycle

```javascript
cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
  versions.forEach(v => {
    // v.registrationId, v.versionId, v.targetId
    // v.runningStatus: 'stopped' | 'starting' | 'running' | 'stopping'
    // v.status: 'new' | 'installing' | 'installed' | 'activating' | 'activated' | 'redundant'
  });
});
```

### Console Messages (per session)

```javascript
cdp.on('Runtime.consoleAPICalled', (params, sessionId) => {
  // params.type: 'log' | 'debug' | 'info' | 'error' | 'warning' | ...
  // params.args: RemoteObject[] - the logged values
  // params.executionContextId
  // params.timestamp
  // params.stackTrace (optional)
  
  // sessionId tells us which context this came from!
});
```

### Exceptions (per session)

```javascript
cdp.on('Runtime.exceptionThrown', (params, sessionId) => {
  // params.exceptionDetails.text
  // params.exceptionDetails.lineNumber
  // params.exceptionDetails.columnNumber
  // params.exceptionDetails.scriptId
  // params.exceptionDetails.url
  // params.exceptionDetails.exception - the error object
});
```

## Target Types Reference

| Type | Description |
|------|-------------|
| `page` | Normal web page |
| `iframe` | Frame within a page |
| `service_worker` | Service worker (PWA or extension) |
| `shared_worker` | Shared worker |
| `worker` | Dedicated worker |
| `background_page` | Extension background (MV2) |
| `other` | Other contexts |

## Extension-Specific

For extensions, the service worker's URL looks like:
```
chrome-extension://EXTENSION_ID/service-worker.js
```

You can extract `EXTENSION_ID` from the URL to correlate with the extension.

## Useful Target Filtering

```javascript
// Filter to only extension-related targets
await cdp.send('Target.setDiscoverTargets', {
  discover: true,
  filter: [
    { type: 'service_worker' },
    { type: 'background_page' }
  ]
});

// Or filter after the fact
const { targetInfos } = await cdp.send('Target.getTargets');
const extensionTargets = targetInfos.filter(t => 
  t.url.startsWith('chrome-extension://')
);
```

## Auto-Attach Pattern

For automatically attaching to new service workers:

```javascript
await cdp.send('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: 'service_worker' }]
});

cdp.on('Target.attachedToTarget', async ({ sessionId, targetInfo }) => {
  // New SW attached, enable console
  await cdp.send('Runtime.enable', {}, sessionId);
});
```
