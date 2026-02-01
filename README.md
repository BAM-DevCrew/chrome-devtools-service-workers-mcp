# MAXerviker DevTools MCP

Browser DevTools MCP server with service worker console access.

`maxerviker-devtools-mcp` gives AI coding agents direct visibility into Chrome browser internals, including **extension service worker console output** — something the upstream project does not support.

Built for [BAM PROTECT](https://github.com/BAM-DevCrew) extension development. No telemetry. No data collection.

## What's different from chrome-devtools-mcp

- **Service worker console capture** — see `console.log`, `console.error`, exceptions, and all runtime output from extension service workers and PWA service workers in real time
- **Extensions enabled by default** — Chrome launches with extension support, not `--disable-extensions`
- **No automation detection** — `navigator.webdriver` stays `false` so sites behave normally during extension testing
- **No Google telemetry** — all Clearcut usage statistics collection has been removed

## Service worker tools

| Tool | Description |
|------|-------------|
| `list_service_worker_contexts` | List active service worker targets with extension ID, URL, and status |
| `list_service_worker_console_messages` | List captured console output with filtering by extension, message type, and pagination |
| `get_service_worker_console_message` | Detailed view of a single message by stable ID |
| `clear_service_worker_console` | Clear captured logs, optionally scoped to a specific target |

All existing chrome-devtools-mcp tools (page navigation, screenshots, network inspection, DOM queries, emulation, etc.) remain fully functional.

## Setup

### Claude Code (CLI)

```bash
claude mcp add chrome-devtools node /path/to/maxerviker-devtools-mcp/build/src/index.js
```

### Claude Desktop

Add to `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "node",
      "args": ["/path/to/maxerviker-devtools-mcp/build/src/index.js"]
    }
  }
}
```

### VSCodium / VS Code

Add to `claude-code.mcpServers` in settings:

```json
"chrome-devtools": {
  "command": "node",
  "args": ["/path/to/maxerviker-devtools-mcp/build/src/index.js"]
}
```

## Building

Requires Node 22.12.0+ (or Node 20.19.0+).

```bash
npm install
npm run build
npm test
```

## Origin

Forked from [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) by Google LLC under Apache License 2.0. See [NOTICE](./NOTICE) for changes. Original license and copyright notices are preserved per Apache-2.0 requirements.

## License

Apache-2.0 — see [LICENSE](./LICENSE)
