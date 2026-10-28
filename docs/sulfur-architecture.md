# Sulfur: native shell, in-process service, shared IDE page

Sulfur owns this repository. Phosphorus owns mesh discovery, authentication,
remote execution transport, merged-home placement, agents, models and Forgejo.
They can develop and release independently against the version 1 wire protocol.

```
src-tauri/       Tauri window, native dialogs, safe close and updater
src-tauri/service/  the local service as a Rust crate: HTTP/WebSocket APIs, files,
                 collaboration, terminals, Git, SQLite, language servers, Open VSX
                 conversion, updates and the mesh proxy
server/          the Node extension host script and the language server IPC bridge
assets/          theme tokens and conversion mappings retained from the Go version
web/src/sulfur/  the existing IDE, usable standalone or embedded in Phosphorus
web/src/host/    the written frontend host contract
scripts/         Bun preparation, web build, notices and release utilities
```

The service runs inside the Tauri process. At startup it binds
`127.0.0.1:47615` (or another loopback port when that one is taken by something
other than Sulfur) before the window asks it for `/sulfur/`; a second launch
that finds Sulfur already serving opens its window on that service instead.
There is no sidecar or ready handshake. Window close and OS quit first reach
the IDE's existing unsaved-changes flow, then the service saves every open file
and ends every shell before the process exits. The original app identifier and
OS profile paths preserve browser storage. `sulfur -headless` runs the same
service without a window.

The page reaches host state and services only through `#host`, with exports
listed in `web/src/host/contract.js`. Standalone binds it to `sulfur/host.js`;
Phosphorus binds it to its own `host/desktop.js`. Themes and terminal registries
remain single instances per page. The original editor, file browser, shared-files
view, source control, tasks, language clients, models and webview implementations
remain the same frontend modules. `web/tests/host-boundary.test.mjs` checks this seam.

The service answers the original local HTTP/socket APIs, and only to its own
page: every request's Host and Origin must be its loopback origin. A remembered
mesh is an additional `/api/mesh/` reverse proxy; remote requests keep their
paths, query strings, cookies, bodies and binary socket frames. It never silently
substitutes a local file for an unavailable remote one. Mesh kinds and their
capabilities are listed in `src-tauri/service/src/mesh.rs`; only Phosphorus is
implemented today.

Collaboration uses the frontend's UTF-16 OT operations in the service as well,
including a surrogate pair split between two operations. Per-session queues
serialize edits, saves and disk observations. File writes from agents retain
incremental typing and presence. Disk conflicts retain both versions and require
the existing resolution flow. Terminals are native PTYs (ConPTY on Windows)
with bounded replay and reconnect grace. Commands and terminals use the login
shell's PATH, so an app started from Finder or a desktop launcher finds the same
tools a terminal does. SQLite runs on bundled SQLite with a ten-second deadline
that interrupts the statement inside SQLite, plus length, SQL-size and column
limits.

Open VSX declarative conversion retains themes, icons, grammars, snippets and
native language servers. Browser code is bundled when the user converts it and
runs in the existing sandbox. Node-only extensions run in a separate local
process on the Node.js (or Bun) found on PATH, with package resolution and Node
APIs. Both use the same VS Code API bridge, command/event messages and webview
implementation. Native extensions have the user's OS permissions; the extension's
existing trust prompt still applies. Node compatibility does not supply every
VS Code API or native addon ABI.

Colors come from `assets/themes.json`. `scripts/themes.js` retains the original
merge order, selectors and CSS token names. The Bun web build hashes, splits and
minifies assets; the service's build script then compresses each text asset into
the binary once, and the service serves it as stored. Files are streamed instead
of buffered.

Development commands, verification coverage and outstanding native acceptance
checks are in [tauri-js.md](tauri-js.md).
