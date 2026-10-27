<p align="center"><img src="packaging/sulfur/icon.svg" alt="" width="140"></p>

<h2 align="center">Sulfur</h2>

<p align="center"><b>A code editor for distributed systems</b></p>

Enables collaborative file work across mesh-connected devices. Build with each machine's own
compilers. Runs as its own desktop app or in the browser, on a mesh or fully offline.

- **Feels like VS Code**: palette, completion, extensions from Open VSX, themes
- **Live collaboration** on every file
- **Language servers** native support for ten languages
- **Builds, runs, git and SQLite** on any host machine
- **Self-updating** apps for macOS and Windows; a .deb for Linux

## Meshes

Sulfur, while working as a fully offline IDE, can link a mesh and have its machines appear in the editor for remote work.

- **[Phosphorus](https://github.com/pmghartman/phosphorus)** gives everything: every host's
  files and the merged home, live sessions, terminals, toolchains and language servers, plus its
  people, Claude Code and opencode agents, models and Forgejo. Every Phosphorus host also
  serves Sulfur itself, at `/sulfur/` and in the desktop's Sulfur window.
- **Overlay networks** (Tailscale, Headscale, NetBird, ZeroTier, Nebula) are next: their peers
  as machines, reached over SSH.

[`docs/mesh-protocol.md`](docs/mesh-protocol.md) covers how meshes of different kinds are added and supported by Sulfur.


## Development (`tauri-js`)

Sulfur's desktop shell is Tauri 2. The IDE services, package conversion, language
server management and extension host run in Bun/JavaScript. Packaged apps include
the Bun runtime; users do not install Go, Bun or Node to run the editor. Individual
language servers retain their documented toolchain prerequisites.

Install Bun **1.4.4**, Rust **1.90+**, Node **22+** for the existing frontend tests,
and [Tauri's native prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test                 # service/extension and existing frontend tests; no build
bun run check                # syntax, configuration and dependency boundary checks
bun run dev                  # developer-run: web build, JS service and Tauri window
bun run build                # developer-run: this OS's native installer and sidecar
```

`bun run build:web` produces a separately hostable page in `dist/`.
`bun run start` serves that page and the local APIs at `127.0.0.1:47615`.
All build commands above are for the developer to run; repository instructions
prohibit agents from running builds.

See [migration and acceptance testing](docs/tauri-js.md),
[architecture](docs/sulfur-architecture.md), and the
[mesh protocol](docs/mesh-protocol.md). The `tauri-js` branch is independently
reviewable; existing Phosphorus Go consumers should remain pinned to the last
compatible Go revision until they adopt the service protocol. Linking meshes
continues to use the same HTTP and WebSocket APIs across either implementation.

## License

Apache 2.0, see [`LICENSE`](LICENSE). Bundled software keeps its own license; full texts are in [`THIRD_PARTY_LICENSES.txt`](THIRD_PARTY_LICENSES.txt).
