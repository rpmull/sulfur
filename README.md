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


## Building

Go 1.26. No node needed for the build. After generating the page, link
`web/node_modules` to `.vendor/node_modules` and run `node --test web/tests/*.test.mjs`
for the page's tests. On Windows, use a directory junction instead of a symlink.

```sh
go generate ./internal/web    # the page, from pinned npm tarballs
go run ./cmd/sulfur           # the app
go test ./...
```

`packaging/sulfur/build.sh` makes this OS's installer.

## License

Apache 2.0, see [`LICENSE`](LICENSE). Bundled software keeps its own license; full texts are in [`THIRD_PARTY_LICENSES.txt`](THIRD_PARTY_LICENSES.txt).
