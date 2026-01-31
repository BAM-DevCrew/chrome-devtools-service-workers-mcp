# Chrome DevTools MCP: Service Worker Console Access Upgrade

## Executive Summary

The chrome-devtools-mcp server currently lacks access to **service worker console output**, making it inadequate for browser extension development. This document outlines the technical approach to add service worker debugging capabilities.

## The Problem

When developing Chrome extensions like BAM, the service worker (background.js/service-worker.js) is where most of the core logic runs. Currently:

- `list_console_messages` only captures console output from **page contexts**
- Service worker logs are invisible to Claude
- Extension background script errors are undetectable
- This makes the MCP server **useless for extension development**

## Related GitHub Issues

| Issue | Title | Status |
|-------|-------|--------|
| [#96](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/96) | **Support for browser extension development and debugging** | **CONFIRMED** - Assigned to @sebastianbenz |
| [#316](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/316) | Allow switching execution context to Dedicated Workers | Open |
| [#265](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/265) | Add a flag for loading extensions | Open |
| [puppeteer#1215](https://github.com/puppeteer/puppeteer/issues/1215) | Support extensions execution contexts | Open since 2017 |

## Technical Architecture

### How Chrome Targets Work

Chrome DevTools Protocol (CDP) treats different execution contexts as **Targets**:
- Pages → `type: "page"`
- iframes → `type: "iframe"`  
- Service Workers → `type: "service_worker"`
- Shared Workers → `type: "shared_worker"`
- Extension background → `type: "background_page"` or `type: "service_worker"`

Each target has a unique `targetId` and can be attached to via `Target.attachToTarget`.

### Key CDP Domains

1. **ServiceWorker Domain** (Experimental)
   - `ServiceWorker.enable()` - Start tracking service workers
   - `ServiceWorker.workerVersionUpdated` event - Notifies when SW changes
   - `ServiceWorkerVersion.targetId` - **KEY**: Contains the target ID for attachment

2. **Target Domain**
   - `Target.setDiscoverTargets({discover: true})` - Enable target discovery
   - `Target.attachToTarget({targetId, flatten: true})` - Attach to get a session
   - `Target.targetCreated` / `Target.targetInfoChanged` events

3. **Runtime Domain** (per-session)
   - `Runtime.enable()` - Enable console events for this session
   - `Runtime.consoleAPICalled` - Console log events
   - `Runtime.exceptionThrown` - Exception events

4. **Extensions Domain** (Experimental)
   - `Extensions.loadUnpacked({path})` - Install extension
   - `Extensions.uninstall({id})` - Remove extension
   - Requires `--enable-unsafe-extension-debugging` flag

## Implementation Strategy

### Phase 1: Service Worker Target Discovery

```typescript
// Pseudo-code for discovering SW targets

async function discoverServiceWorkerTargets() {
  // Enable service worker tracking
  await cdp.send('ServiceWorker.enable');
  
  // Listen for SW updates
  cdp.on('ServiceWorker.workerVersionUpdated', (event) => {
    for (const version of event.versions) {
      if (version.runningStatus === 'running' && version.targetId) {
        // Found a running service worker with targetId
        registerServiceWorkerTarget(version);
      }
    }
  });
  
  // Also use Target discovery for extension SWs
  await cdp.send('Target.setDiscoverTargets', {
    discover: true,
    filter: [
      { type: 'service_worker' },
      { type: 'background_page' }
    ]
  });
}
```

### Phase 2: Attach to Service Worker Session

```typescript
async function attachToServiceWorker(targetId: string) {
  // Attach and get a session for this target
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true  // Use flat sessions (recommended)
  });
  
  // Enable Runtime on the SW session to capture console
  await cdp.send('Runtime.enable', null, sessionId);
  
  // Store session for later use
  serviceWorkerSessions.set(targetId, sessionId);
  
  return sessionId;
}
```

### Phase 3: Capture Console Messages per Session

```typescript
// Messages arrive per-session
cdp.on('Runtime.consoleAPICalled', (event, sessionId) => {
  const context = sessionContextMap.get(sessionId);
  
  consoleMessages.push({
    ...event,
    context: context.type, // 'page' | 'service_worker' | 'extension'
    contextId: context.id,
    contextName: context.name
  });
});
```

### Phase 4: Update MCP Tools

#### Modified: `list_pages`
Add extension contexts to the list:

```typescript
interface PageInfo {
  pageIdx: number;
  url: string;
  title: string;
  type: 'page' | 'service_worker' | 'extension_popup' | 'extension_sidepanel';
  extensionId?: string;  // NEW: if this is an extension context
  targetId: string;       // NEW: for direct attachment
}
```

#### Modified: `list_console_messages`
Add context filter parameter:

```typescript
interface ListConsoleMessagesParams {
  // Existing
  includePreservedMessages?: boolean;
  pageIdx?: number;
  pageSize?: number;
  types?: string[];
  
  // NEW
  context?: 'all' | 'page' | 'service_worker' | 'extension';
  extensionId?: string;  // Filter to specific extension
}
```

#### New: `list_extension_contexts`

```typescript
interface ExtensionContext {
  extensionId: string;
  extensionName: string;
  contextType: 'service_worker' | 'popup' | 'sidepanel' | 'options' | 'content_script';
  targetId: string;
  url: string;
  runningStatus: string;
}
```

#### New: `select_extension_context`

```typescript
// Switch console capture focus to an extension context
interface SelectExtensionContextParams {
  extensionId: string;
  contextType?: string; // defaults to 'service_worker'
}
```

## Chrome Launch Flags

The MCP server needs additional flags for extension debugging:

```json
{
  "args": [
    "--load-extension=/path/to/extension",
    "--disable-extensions-except=/path/to/extension",
    "--enable-unsafe-extension-debugging"  // Required for Extensions.loadUnpacked
  ]
}
```

Or for connecting to an existing browser with remote debugging:

```bash
google-chrome --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug \
  --load-extension=/path/to/BAM
```

## Session Management Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser Target (root)                     │
│                         sessionId: ""                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────┐  ┌──────────────────────────────┐    │
│  │   Page Target    │  │   Service Worker Target      │    │
│  │  sessionId: "A"  │  │     sessionId: "B"           │    │
│  │                  │  │                              │    │
│  │ Runtime.enable() │  │ Runtime.enable()             │    │
│  │ Console events   │  │ Console events for SW        │    │
│  └──────────────────┘  └──────────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │          Extension Background (SW) Target            │  │
│  │                   sessionId: "C"                      │  │
│  │                                                       │  │
│  │ Runtime.enable() → captures extension console.log()  │  │
│  │ Runtime.consoleAPICalled events                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Options

### Option A: Fork and Modify chrome-devtools-mcp

**Pros:**
- Full control over implementation
- Can add exactly what BAM needs
- Immediate availability

**Cons:**
- Maintenance burden
- Miss upstream improvements
- Need to track Chrome CDP changes

### Option B: Contribute to Upstream

**Pros:**
- Benefits the community
- Maintained by Google team
- Follows existing patterns

**Cons:**
- Slower - PR review process
- May not match BAM priorities exactly
- Issue #96 is "confirmed" but not actively worked

### Option C: Build Separate MCP Server

**Pros:**
- Purpose-built for extension dev
- No legacy constraints
- Can be minimal/focused

**Cons:**
- Duplicates effort
- Doesn't leverage existing tooling

### Recommendation: **Option A with upstream contribution**

1. Fork chrome-devtools-mcp
2. Implement SW console access for BAM
3. PR the changes upstream
4. Maintain fork until merged

## File Structure for Implementation

```
src/
├── tools/
│   ├── console.ts          # MODIFY: Add context filtering
│   ├── pages.ts            # MODIFY: Add extension contexts
│   ├── extensions.ts       # NEW: Extension management tools
│   └── service-worker.ts   # NEW: SW-specific tools
├── sessions/
│   ├── session-manager.ts  # NEW: Track multiple CDP sessions
│   └── context-tracker.ts  # NEW: Map sessions to contexts
└── types/
    └── extension-types.ts  # NEW: Extension/SW type definitions
```

## Testing Strategy

1. **Unit Tests**: Mock CDP responses for SW discovery
2. **Integration Tests**: Load test extension, verify console capture
3. **BAM-specific Tests**: Install BAM extension, trigger actions, verify logs

## Timeline Estimate

| Phase | Effort | Description |
|-------|--------|-------------|
| 1 | 2-3 days | SW target discovery + attachment |
| 2 | 1-2 days | Console message routing per-session |
| 3 | 1-2 days | Update existing tools with context param |
| 4 | 1 day | New extension listing tools |
| 5 | 1-2 days | Testing + documentation |

**Total: ~1-2 weeks**

## References

- [CDP Target Domain](https://chromedevtools.github.io/devtools-protocol/tot/Target/)
- [CDP ServiceWorker Domain](https://chromedevtools.github.io/devtools-protocol/tot/ServiceWorker/)
- [CDP Runtime Domain](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/)
- [CDP Extensions Domain](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/)
- [Getting Started with CDP](https://github.com/aslushnikov/getting-started-with-cdp)
- [chrome-devtools-mcp Issue #96](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/96)
