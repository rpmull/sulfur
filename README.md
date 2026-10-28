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


## Development

Sulfur is one Tauri 2 executable. Its local service (files, live editing,
terminals, tasks, Git, SQLite, language servers and Open VSX conversion) is the
Rust crate in `src-tauri/service`, running inside the app process, with the web
page compressed into the binary. Users do not install Go, Bun or Node to run the
editor. Converted Node extensions run on the Node.js (or Bun) found on PATH, and
individual language servers keep their documented toolchain prerequisites.

Install Rust **1.90+**, Bun **1.4.4** for the web build and scripts, Node **22+**
for the frontend and extension host tests, and
[Tauri's native prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test                 # Rust service tests, extension host and frontend tests
bun run check                # syntax, configuration and dependency boundary checks
bun run dev                  # developer-run: the Tauri window, serving dist/ from disk
bun run build                # developer-run: web build, then this OS's native installer
```

`bun run build:web` produces a separately hostable page in `dist/`.
`bun run start` runs the service headless, serving that page and the local APIs
at `127.0.0.1:47615`.
All build commands above are for the developer to run; repository instructions
prohibit agents from running builds.

See [migration and acceptance testing](docs/tauri-js.md),
[architecture](docs/sulfur-architecture.md), and the
[mesh protocol](docs/mesh-protocol.md). Existing Phosphorus Go consumers should
remain pinned to the last compatible Go revision until they adopt the service
protocol. Linking meshes continues to use the same HTTP and WebSocket APIs across
either implementation.

## License

Apache 2.0, see [`LICENSE`](LICENSE). Bundled software keeps its own license; full texts are in [`THIRD_PARTY_LICENSES.txt`](THIRD_PARTY_LICENSES.txt).
