<p align="center"><img src="packaging/sulfur/icon.svg" alt="" width="140"></p>

<h2 align="center">Sulfur</h2>

<p align="center"><b>A code editor that lives on every machine at once.</b></p>

Open any file on any machine and edit it live, together. Build with each machine's own
compilers. Run it as its own desktop app or in the browser, on a mesh or fully offline.

- **Feels like VS Code**: palette, completion, extensions from Open VSX, themes
- **Live collaboration** on every file
- **Language servers** for ten languages, installed per machine
- **Builds, runs, git and SQLite** on whichever machine the project lives on
- **Self-updating** apps for macOS and Windows; a .deb for Linux

## Meshes

Sulfur always works on this computer, with no mesh at all. Link a mesh and its machines join
this one.

- **[Phosphorus](https://github.com/pmghartman/phosphorus)** gives everything: every host's
  files and the merged home, live sessions, terminals, toolchains and language servers, plus its
  people, Claude Code and opencode agents, models and Forgejo. Every Phosphorus host also
  serves Sulfur itself, at `/sulfur/` and in the desktop's Sulfur window.
- **Overlay networks** (Tailscale, Headscale, NetBird, ZeroTier, Nebula) are next: their peers
  as machines, reached over SSH.

[`docs/mesh-protocol.md`](docs/mesh-protocol.md) covers the boundary in full: what a mesh gives,
what Sulfur brings itself (`hostkit`), and how a new kind of mesh is added.

## Layout

```
cmd/sulfur/     the desktop app: its server for this computer, its window, its updates,
                and the linked mesh (mesh.go)
hostkit/        Sulfur's work on a host, for any mesh's hosts: toolchains, language servers,
                builds and runs, git, SQLite, Open VSX (public: Phosphorus imports it)
internal/       this computer's files, live sessions, sockets, themes and the page's build
web/            the page: src/sulfur/ the editor, src/host/contract.js its boundary with
                whatever hosts it, tests/ its tests
packaging/      installers for every OS
docs/           the editor, extensions, language servers, meshes
```

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
