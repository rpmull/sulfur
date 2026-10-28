# Tauri migration and developer acceptance

The migration replaced Sulfur's Go application and Go build tools with Tauri 2,
Bun 1.4.4 and JavaScript. Rust is limited to native window/dialog/update lifecycle
and forwarding legacy executable helper commands. The service and extension
compatibility work live in JavaScript. The original Go checkout and Phosphorus
working tree are separate and were not modified by it.

## Running and building

Install Bun 1.4.4, Rust 1.90 or newer, Node 22+ for the existing frontend tests,
and [the native Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
Packaged users need no Bun, Go or Node installation for the IDE itself. Language
servers retain their existing prerequisites; Node-based language servers still
use Node. Bun's runtime sets the platform floor (including macOS 13+).

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run check
# The developer runs these; agents must not run builds in this repository:
bun run dev
bun run build
```

The user-run build first creates hashed/minified/split web assets with compressed
text copies, then compiles the JS service and its SQLite process helper into a sidecar.
Tauri packages the sidecar and resources with the native shell. Build for each
native architecture; the release workflow uses separate Intel/ARM macOS and Linux
jobs. Developer builds omit signed updater artifacts so no production signing key is needed.
The manual release configuration enables them with the existing keys. Build outputs are ignored. `packaging/sulfur/build.sh` forwards to Tauri.
The existing frontend dependency pins and grammar patches are preserved.

`bun run start` serves the local APIs and a developer-built `dist/` at
`http://127.0.0.1:47615/sulfur/`. The packaged app retains `-headless`, `-addr` and
`-config`; the shell forwards helper/headless commands before desktop startup.
The service accepts both single- and double-dash address/config options.
The default config file remains the OS config directory's `Sulfur/sulfur.json`.

## Compatibility boundaries

| behavior | retained boundary |
|----------|-------------------|
| original editor and UI | existing `web/src/sulfur` and shared JS modules |
| embedded Phosphorus IDE | `#host` exports in `web/src/host/contract.js` |
| Phosphorus meshes | original `/api/*` paths behind `/api/mesh/`, cookies, JSON and socket frames |
| shared files | Phosphorus merged-home holders, placement, sharing and permissions remain mesh-owned |
| files | listing/link/empty metadata, bounded trees/search, BOM/CRLF, binary reads, chunk uploads |
| collaborative edits | shared UTF-16 OT, rebasing, cursors, animated agent writes, autosave and disk conflicts |
| execution | native PTYs, replay/reconnect, tasks, toolchains and Git |
| languages | existing ten server installers and request protocol, IPC/stdin framing, virtual-document gate |
| SQLite | explicit creation, readonly queries, transactional batches/triggers, authorizer, row/byte/preview limits and deadlines |
| settings/profile | original keys, config location, `dev.phosphorus.sulfur` identifier and WebView data paths |
| updates | existing minisign public key and `sulfur-<platform>-<arch>.json` feed names |

Phosphorus may keep its existing remote helper implementation, including
`phosphorus sulfur-language` and `phosphorus sulfur-sqlite`. Sulfur also retains
`sulfur sulfur-language <base64 request>` and `sulfur sulfur-sqlite` (JSON stdin)
through its packaged shell, with direct equivalents on `sulfur-service` or
`bun server/main.js`. No Go source/module remains here. Go consumers must pin the
last compatible Go revision until they adopt the service protocol; linking a
mesh does not require changing that mesh's implementation.

Only Phosphorus is a shipped mesh provider. `server/mesh.js` has a capability-based
registration seam for other providers. The [mesh protocol](mesh-protocol.md)
records the comparison with Tailscale/Headscale, NetBird, ZeroTier, Nebula, Zed,
VS Code Remote and DevPod, including what an actual adapter still needs.

## Extension compatibility

Declarative conversion retains themes/includes/plists, icons/fonts, language
configurations, TextMate grammars, snippets, keybindings and extracted native LSP
servers. Existing browser packages remain sandboxed. New browser conversions
bundle package-local CommonJS/ESM dependencies and externalize `vscode` to the
existing bridge. Runtime bundling occurs only on the user's Convert action.

Node-only extensions can now resolve their packaged dependencies and Node APIs in
a separate Bun process. Their VS Code API, command/event, sidebar and webview
messages reuse the existing frontend bridge. Binary/structured values survive
the socket/stdin transport. Native filesystem paths are supplied on Windows and
POSIX. Disabling the extension closes its process. Package install scripts are
not executed during conversion. The existing trust decision applies; native
extension code has the user's OS filesystem/process permissions.

This expands JS compatibility without claiming the complete VS Code extension
API. Debug adapters and other unsupported services remain reported. Native addon
ABIs, specific packages, browser asset loaders and VS Code-only integrations need
package testing. A native extension requiring a remote workspace is rejected
until an authenticated extension host exists on that machine; local paths never
substitute for remote ones. Existing hosted browser builds remain available.

## Verification performed without builds

The service/extension tests exercise real filesystem operations, native Windows
PTY output, Git staging/commits/diffs, SQLite workers/authorizer/rollback/triggers,
LSP framing/document gates, mesh HTTP and WebSocket proxying (including shared-home
paths/cookies), concurrent edits, disk conflicts, legacy conversion fixtures and
reference minisign signatures. A real Bun extension process activates an extension
using Node filesystem APIs, a CommonJS dependency, an ES module and binary VS Code
filesystem RPC. Configuration is checked against the pinned Tauri schema. The
original frontend suite remains in `web/tests`.

Dependency installation uses `--ignore-scripts`. Rust verification here is source
formatting and locked dependency metadata, not compilation. No web, sidecar,
native app or installer build has been run by the agent. Browser-extension bundling
is authored but intentionally not executed as a build during verification.
Headless update requests stage a verified package for manual installation; automatic
installation currently runs through the Tauri shell in desktop sessions.
No performance benchmark claim or complete native parity claim follows from the
unit checks alone. In particular, Node's SQLite interface does not expose the old
native `sqlite3_limit` allocation setting; its SQL-size, column-count, output,
preview and timeout guards are retained, but a single giant native allocation
needs separate resource testing.

## Native acceptance after the developer builds

Before releasing, exercise Windows, Linux and both Mac architectures:

1. Open the app over an existing profile. Verify remembered mesh links, credentials,
   appearance, layouts, drafts, settings and extensions. Check dialogs, external
   links, dragging, minimize/maximize, multiple launches and unsaved close/OS quit.
2. Link the current Phosphorus mesh. Browse the merged home and shared files across
   holders, open/edit/share files, reconnect live sessions/terminals and exercise
   models, agents, Forgejo, Git, SQLite, task execution and each language server.
   Disconnect the mesh and confirm local work continues and remote paths stay remote.
3. Install representative Open VSX themes/icons/grammars/snippets, browser and Node
   extensions, including webviews and native addons. Verify errors are reported,
   dependencies resolve, binary files survive RPC and processes stop on disable/exit.
4. Test both a fresh installer and upgrade from the last Go app. NSIS retains the
   original per-user installation directory and legacy `/RESTART` option. Test
   signed update installation/restart and preserved profiles on every target.
5. Measure cold/warm startup, idle memory, large tree/search and transfer behavior,
   terminal throughput, concurrent editing, SQLite cancellation/allocations and
   extension activation against the Go app. Streaming, bounded concurrency,
   caching, worker reuse, minification/compression and compiled bytecode are in
   place; their end-to-end gains still need measurements.

These checks require native builds and target hosts, and are intentionally left
to the developer under `AGENTS.md`.

## Signing, notices and release

The manual-only release workflow runs on five native targets. Pushing
does not build an app or publish a release. Its version is `1.0.<commit count>` of
the dispatched commit, so a rerun of one commit releases the same version.

Update signing is required and free: secret `UPDATE_SIGNING_KEY` and variable (or
secret) `UPDATE_PUBKEY` are a minisign pair, such as the private key and `.pub` file from
`bun tauri signer generate -w ~/.tauri/sulfur.key`; set `UPDATE_SIGNING_PASSWORD`
when the key has one. **Keep the public key once published**, since installed apps
trust only it. Both old public-key input formats are normalized for Tauri.

Code signing is optional. Without Trusted Signing/PFX variables, `packaging/winsign.sh`
leaves Windows installers unsigned (SmartScreen warns on first run) unless
`WINDOWS_SIGNING_REQUIRED=1`. Without Tauri's Apple variables the macOS app is
ad-hoc signed and not notarized: users allow it once, under System Settings → Privacy &
Security → Open Anyway. Signed installers and signature files are
published on the numbered release; `update` holds the compatible JSON manifests.
`PHOSPHORUS_FEED_TOKEN` optionally mirrors those manifests to `LEGACY_FEED_REPO`.

`bun run licenses` gathers locked Rust metadata and installed npm license texts
without compiling anything, plus Bun's pinned license/component notice. The
[official Bun license](https://bun.com/docs/project/license) explains its statically
linked components and relinking steps. This repository supplies the application
source and JS build inputs: build a modified Bun runtime from its pinned source
and use it to rerun `scripts/package-sidecar.js` to replace/relink the runtime.
Native distributions include `LICENSE` and `THIRD_PARTY_LICENSES.txt`.
