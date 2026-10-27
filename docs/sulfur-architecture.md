# Sulfur: native shell, JavaScript services, shared IDE page

Sulfur owns this repository. Phosphorus owns mesh discovery, authentication,
remote execution transport, merged-home placement, agents, models and Forgejo.
They can develop and release independently against the version 1 wire protocol.

```
src-tauri/       Tauri window, native dialogs, safe close, updater and process lifecycle
server/          Bun HTTP/WebSocket services, files, collaboration, terminals,
                 Git, SQLite, language servers and extension conversion/execution
assets/          theme tokens and conversion mappings retained from the Go version
web/src/sulfur/  the existing IDE, usable standalone or embedded in Phosphorus
web/src/host/    the written frontend host contract
scripts/         Bun preparation, builds, packaging, notices and release utilities
```

The Tauri window still loads `http://127.0.0.1:47615/sulfur/`. The native shell
starts a packaged Bun sidecar and waits for its ready message. It places the
sidecar and its children in a process group/job, and terminates them on exit.
Window close and OS quit first reach the IDE's existing unsaved-changes flow.
The original app identifier and OS profile paths preserve browser storage.

The page reaches host state and services only through `#host`, with exports
listed in `web/src/host/contract.js`. Standalone binds it to `sulfur/host.js`;
Phosphorus binds it to its own `host/desktop.js`. Themes and terminal registries
remain single instances per page. The original editor, file browser, shared-files
view, source control, tasks, language clients, models and webview implementations
remain the same frontend modules. `web/tests/host-boundary.test.mjs` checks this seam.

The Bun service answers the original local HTTP/socket APIs. A remembered mesh
is an additional `/api/mesh/` reverse proxy; remote requests keep their paths,
query strings, cookies, bodies and binary socket frames. It never silently
substitutes a local file for an unavailable remote one. Provider capabilities
are registered in `server/mesh.js`; only Phosphorus is implemented today.

Collaboration uses the frontend's UTF-16 OT operations on the server as well.
Per-session queues serialize edits, saves and disk observations. File writes
from agents retain incremental typing and presence. Disk conflicts retain both
versions and require the existing resolution flow. Terminals use Bun's native
PTY support, including ConPTY on Windows, with bounded replay and reconnect grace.
SQLite streams result rows in two persistent worker processes with a query timeout.

Open VSX declarative conversion retains themes, icons, grammars, snippets and
native language servers. Browser code is bundled when the user converts it and
runs in the existing sandbox. Node-only extensions can run in a separate local
Bun process with package resolution and Node APIs. Both use the same VS Code API
bridge, command/event messages and webview implementation. Native extensions have
the user's OS permissions; the extension's existing trust prompt still applies.
Bun/Node compatibility does not supply every VS Code API or native addon ABI.

Colors come from `assets/themes.json`. `scripts/themes.js` retains the original
merge order, selectors and CSS token names. Bun builds hash/split/minify assets
and precompress text files; the server streams files instead of buffering them.

Development commands, verification coverage and outstanding native acceptance
checks are in [tauri-js.md](tauri-js.md).
