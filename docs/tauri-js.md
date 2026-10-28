# Tauri migration and developer acceptance

The migration replaced Sulfur's Go application and Go build tools with Tauri 2.
Sulfur's local service is a Rust crate (`src-tauri/service`) running inside the
Tauri process: one executable, no sidecar and no second runtime. The page and
the Node extension host remain JavaScript, and Bun 1.4.4 runs the web build and
the repository's scripts. The original Go checkout and Phosphorus working tree
are separate and were not modified by the migration.

## Running and building

Install Rust 1.90 or newer, Bun 1.4.4, Node 22+ for the frontend and extension
host tests, and [the native Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
Packaged users need no Bun, Go or Node installation for the IDE itself. Converted
Node extensions run on the Node.js (or Bun) found on PATH, and language servers
retain their existing prerequisites; Node-based language servers still use Node.
The macOS app targets macOS 13 or newer.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run check
# The developer runs these; agents must not run builds in this repository:
bun run dev
bun run build
```

The user-run build first creates hashed/minified/split web assets in `dist/`,
plus the bundled Node extension host. Cargo then builds the app: the service's
build script compresses each text asset of `dist/` into the binary once
(source maps, `.gz` copies and unused font formats are left out), so the
installed app has no resource folder for the page. Tauri packages the one
executable with its license files. Build for each native architecture; the
release workflow builds Apple Silicon macOS (Intel Macs are no longer built) and
separate x64/arm64 Linux jobs. Developer builds
omit signed updater artifacts so no production signing key is needed. The
manual release configuration enables them with the existing keys. Build outputs
are ignored. `packaging/sulfur/build.sh` forwards to Tauri. The existing frontend
dependency pins and grammar patches are preserved.

`bun run dev` opens the Tauri window; debug builds serve `dist/` from disk, so
a rebuilt page needs only a reload. `bun run start` runs the service headless
(`sulfur -headless`), serving the local APIs and a developer-built `dist/` at
`http://127.0.0.1:47615/sulfur/`. The app retains `-headless`, `-addr`,
`-config` and `-dist`, as single- or double-dash options, and handles the helper
commands before any window opens. The default config file remains the OS config
directory's `Sulfur/sulfur.json`.

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
in its own executable. No Go source/module remains here. Go consumers must pin
the last compatible Go revision until they adopt the service protocol; linking a
mesh does not require changing that mesh's implementation.

Only Phosphorus is a shipped mesh provider. `PROVIDERS` in
`src-tauri/service/src/mesh.rs` lists the mesh kinds and their capabilities. The
[mesh protocol](mesh-protocol.md) records the comparison with Tailscale/Headscale,
NetBird, ZeroTier, Nebula, Zed, VS Code Remote and DevPod, including what an
actual adapter still needs.

## Extension compatibility

Declarative conversion retains themes/includes/plists, icons/fonts, language
configurations, TextMate grammars, snippets, keybindings and extracted native LSP
servers. Existing browser packages remain sandboxed. New browser conversions
join package-local CommonJS/ESM dependencies into one file and leave `vscode` to
the existing bridge. That happens only on the user's Convert action, and package
code is read, never run.

Node-only extensions resolve their packaged dependencies and Node APIs in a
separate process on the Node.js (or Bun) found on PATH, running Sulfur's bundled
extension host. Their VS Code API, command/event, sidebar and webview messages
reuse the existing frontend bridge. Binary/structured values survive the
socket/stdin transport. Native filesystem paths are supplied on Windows and
POSIX. Disabling the extension closes its process. Package install scripts are
not executed during conversion. The existing trust decision applies; native
extension code has the user's OS filesystem/process permissions.

This expands JS compatibility without claiming the complete VS Code extension
API. Debug adapters and other unsupported services remain reported. Native addon
ABIs, specific packages, browser asset loaders and VS Code-only integrations need
package testing. A native extension requiring a remote workspace is rejected
until an authenticated extension host exists on that machine; local paths never
substitute for remote ones. Existing hosted browser builds remain available.

## Verification

`bun run test` runs three suites:

- The service's Rust tests (`cargo test -p sulfur-service`) exercise real
  filesystem operations, native PTY output (ConPTY on Windows), tasks and their
  exit codes, Git staging/commits/diffs, SQLite deadlines/authorizer/rollback/
  triggers, LSP framing and document gates, UTF-16 OT including split surrogate
  pairs, Open VSX conversion fixtures and reference minisign signatures. An
  end-to-end test runs the service on its own loopback port and checks that
  requests are held to its page, the mesh is passed through, and files,
  terminals and tasks work over the wire.
- `tests/` runs the Node extension host under Node: a real extension process
  activates an extension using Node filesystem APIs, a CommonJS dependency, an
  ES module and binary VS Code filesystem RPC. The Tauri configuration is checked
  against the pinned Tauri schema.
- `web/tests` is the original frontend suite.

The Rust tests compile the service crate; nothing else is built. Dependency
installation uses `--ignore-scripts`. No performance benchmark claim or complete
native parity claim follows from the unit checks alone.

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
   caching and compressed embedded assets are in place; their end-to-end gains
   still need measurements.

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
into `THIRD_PARTY_LICENSES.txt` without compiling anything. Native distributions
include `LICENSE` and `THIRD_PARTY_LICENSES.txt`.
