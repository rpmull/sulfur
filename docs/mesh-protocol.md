# Sulfur and the meshes it works on

Sulfur is an editor for every machine you have. It always works on this computer, with no
mesh at all. A **mesh** adds more machines, plus whatever else that mesh can give. This file
covers three things: the boundary Sulfur keeps with the meshes it works on, why the boundary
sits where it does, and how a new kind of mesh is added.

Phosphorus is the first mesh, and the richest. Sulfur's boundary with it is exact: the
Phosphorus desktop's Sulfur window, `/sulfur/` on every Phosphorus host and Sulfur's own app
linked to a Phosphorus mesh all behave the same as before Sulfur had its own repository.

## How other projects draw this line

Remote-capable editors and mesh networks split the work the same way.

| project | what the mesh or remote side gives | what the editor brings itself |
|---------|------------------------------------|-------------------------------|
| [Zed remote development](https://zed.dev/docs/remote-development) | an SSH connection | `zed-remote-server`, version-matched to the editor and installed on the remote. It runs language servers, tasks, terminals and file operations; the UI stays local |
| [VS Code Remote](https://code.visualstudio.com/docs/remote/remote-overview) | an SSH connection or tunnel | the VS Code Server on the remote |
| [DevPod providers](https://devpod.sh/docs/developing-providers/quickstart) | a `provider.yaml` saying how to run a command in the environment | its own agent binary, run through that command |
| [Tailscale](https://tailscale.com/docs/reference/tailscale-cli) / [Headscale](https://headscale.net/stable/) | Tailscale clients expose `tailscale status --json`; Headscale supplies an alternative control server | the IDE still needs its own file and execution services |
| [NetBird](https://docs.netbird.io/get-started/cli) | `netbird status --json`: machine-readable peer and connection status | the IDE's file and execution services |
| [ZeroTier](https://docs.zerotier.com/api-service/) | the local service API on `localhost:9993` with `authtoken.secret`: known peers and networks | the IDE's file and execution services |
| [Nebula](https://nebula.defined.net/docs/guides/host-discovery/) | `static_host_map` and lighthouses: peers by Nebula IP | nothing |

The design inference is to separate peer discovery and reachability from IDE services.
These projects do not share a universal peer or filesystem API. Tailscale warns that its
JSON status format may change; ZeroTier's known peers are not a complete authorized-machine
directory; Nebula discovery is not a machine inventory. Each adapter must normalize its
network's state, supply authentication, and establish which hosts actually have IDE services.
An SSH port alone does not provide files, live sessions, language servers or shared homes.

Sulfur draws the line the same way:

- **Sulfur owns its host-side half: `hostkit`.** Toolchain probes, language servers, builds and
  runs, git, SQLite and Open VSX conversion are Sulfur's code. That holds whether the code runs
  inside Sulfur's own server for this computer, inside a Phosphorus host for the mesh, or as a
  `sulfur-language` / `sulfur-sqlite` helper on a remote host.
- **The mesh owns finding and reaching hosts.** `hostkit` never resolves a host name and never
  holds a password. It takes a `hostkit.Login`: who the user is there, and a `Dial` that returns
  an SSH client already logged in. Phosphorus dials with its tailnet addresses and the user's
  saved logins. An overlay mesh dials its peer's address with the user's SSH keys or agent.
- **Everything else is a capability a mesh may or may not give.** Phosphorus gives all of them.
  A bare overlay mesh gives hosts, plus whatever Sulfur can build over SSH.

## The three seams

### 1. The page: `web/src/host/contract.js`

Sulfur's code reaches whatever hosts its page only through `'#host'`, and only through the
names in `contract.js`. The build binds `'#host'` per page:

| page | `'#host'` is | where |
|------|--------------|-------|
| Sulfur's app, and `/sulfur/` on a Phosphorus host | `web/src/sulfur/host.js` | this repository |
| the Phosphorus desktop's Sulfur window | `web/src/host/desktop.js` | Phosphorus's repository |

The contract includes the page's theme (`setPalette`, `PALETTES`, …) and its terminals
(`startTerminal`, `taskTerminal`, `termsRetheme`). Each page has one instance of each. Inside
the desktop, Sulfur's window wears the desktop's theme, and its terminals are rethemed along
with the desktop's.

`web/tests/host-boundary.test.mjs` holds Sulfur to the contract from this side: `host.js`
exports every name, and Sulfur's code reaches its host through nothing else. Phosphorus's test
of the same name holds `desktop.js` to it from the other side.

### 2. The host: `hostkit`

| call | what it does on a host |
|------|------------------------|
| `Probe(host, login, fresh)` | its compilers, runtimes and build tools (`/api/sulfur/toolchains`) |
| `Start(host, login, task, out)` | a build or run in a pty, streamed (`/api/sulfur/run`) |
| `LanguageSocket(ws, host, login)` | a language server session, or installing one (`/api/sulfur/languages`) |
| `GitRemote(host, login, dir, args, …)` | git in a folder, for Source Control (`/api/sulfur/git`) |
| `SQLiteRemote(ctx, host, login, req)` | a query on a database file (`/api/sulfur/sqlite`) |
| `VSXServe(w, r)` | Open VSX search and Convert & Install (`/api/sulfur/vsx/*`) |
| `LanguageMain`, `SQLiteMain` | the helpers run on the host itself, as `<Helper> sulfur-language` and `<Helper> sulfur-sqlite` |

`hostkit.Login.Helper` selects the trusted command prefix per connection. It defaults to
`sulfur`. Phosphorus explicitly passes `Helper: "phosphorus"`, so existing hosts still run
the exact same helper commands. Helper selection never comes from a page request and is
not global mutable state. `Login.Scope` can distinguish probe caches for meshes with the
same host and user names. An adapter owns SSH key verification and credential storage;
`Dial` returns its authenticated client, which hostkit closes after the operation.

A host's helper may be older or newer than the Sulfur asking. Requests to it only ever gain
fields; a field is never renamed or given a new meaning.

### 3. The API: what Sulfur's page calls

A mesh is reached under `/api/mesh/` on Sulfur's own server. On a Phosphorus host's
`/sulfur/` page, the same calls go to that host directly. Sulfur's server answers this
computer's part itself, so it works offline.

| capability | calls | Sulfur's own server, offline | Phosphorus |
|------------|-------|------------------------------|------------|
| `hosts` | `/api/me`, `/api/state` (socket), `/api/login`, `/api/logout` | this computer | every host, its facts and shares |
| `files` | `/api/files/<host>/<op>` | this computer's home and drives | every host's shares |
| `home` | the merged home (`files` on the `home` share across hosts) | this computer's home | one home across hosts |
| `sessions` | `/api/code/<host>?share=…&path=…` (socket), alongside `/api/files/…` | this computer | every host, edited together |
| `terminals` | `/api/term/` (socket) | this computer | every host |
| `toolchains`, `runs`, `languages`, `git`, `sqlite`, `vsx` | `/api/sulfur/*` | this computer, by `hostkit` | every host, by `hostkit` over SSH |
| `people` | sharing a file, `/api/me/vault` | — | the mesh's people |
| `agents` | `/api/code/*` | — | Claude Code and opencode on any host |
| `models` | `/api/model/v1/*` | — | chat and inline suggestions |
| `forgejo` | `/api/sulfur/forgejo` | — | the mesh's Forgejo |

Sulfur's server reports the linked mesh's kind and capabilities in `/api/sidecar/info` as
`mesh: { kind, version: 1, caps }`. `internal/mesh` defines the adapter contract;
`cmd/sulfur/mesh.go` registers the implemented providers. Only `phosphorus` is implemented
today. The overlay integrations below are extension designs, not working providers.

### State and compatibility

New adapters publish normalized state at `/api/state`:

```json
{
  "self": { "host": "workstation" },
  "peers": [{ "name": "workstation", "online": true }, { "name": "builder", "online": true }],
  "hosts": {
    "builder": {
      "platform": "linux", "shell": "sh",
      "files": { "shares": [{ "id": "home", "label": "/home", "home": true, "perms": "rwd" }] }
    }
  }
}
```

Names are stable API host identifiers. Share IDs, permissions and root labels retain their
meaning across reconnects. Never translate a disconnected remote path to a local file.
Phosphorus keeps sending its existing `tailnet` array with `phosphorus: true`; Sulfur's
`web/src/sulfur/mesh.js` accepts both state formats. Existing HTTP paths, JSON fields,
WebSocket frames, session cookies, local settings keys and extension messages are unchanged.

Missing mesh metadata means legacy Phosphorus, with its full existing feature set. An
explicit `caps` list is authoritative. Agent and model requests and Forgejo commands consult
it; a new provider must not claim a service it has not implemented. New providers translate
their own authentication and discovery into the documented API behind `/api/mesh/`.

The `home` capability includes Phosphorus's merged home semantics: the user's folder and
`shared/`, listing across all holders, and writes routed to the file's holder. Normal file
shares and collaboration use the existing host API and permissions. A provider offering
only per-host files must not pretend to provide Phosphorus-style people or sharing.

Keep version 1 changes additive. Both old and new hosts must understand the existing helper
requests and file/session messages. An incompatible future protocol needs an explicit new
version and migration, never an implicit reinterpretation of a field. Sulfur and Phosphorus
can release independently once Phosphorus pins a published compatible Sulfur version.

## Adding a kind of mesh

A kind is an `internal/mesh.Kind`: its capabilities, `Normalize(endpoint)`, `Reach(endpoint)`
and `Handler(endpoint)`. The endpoint is provider-owned; only the Phosphorus adapter requires
an HTTP URL. The handler answers its machines' calls under `/api/mesh/`.

- **`phosphorus`** (built in): the handler is a reverse proxy to the Phosphorus server, which
  answers every call above itself.
- **An overlay mesh** (Tailscale, Headscale, NetBird, ZeroTier, Nebula) is the next kind. Its
  handler is Sulfur's own:
  - it reads the peers from the mesh's own status (`tailscale status --json`,
    `netbird status --json`, ZeroTier's known peers and network membership, or a configured
    Nebula host inventory) for `hosts`;
  - it answers `files`, `terminals` and `/api/sulfur/*` over SSH, with a `hostkit.Login` whose
    `Dial` reaches the peer's mesh address with the user's SSH agent or keys;
  - it runs `sulfur sulfur-language` and `sulfur sulfur-sqlite` as the helpers, uploading a
    compatible helper to the host the first time it is needed. Helper deployment is future
    adapter work; no automatic upload or installation is implemented in this extraction.

  It must implement file and session services too before advertising them. `hostkit` provides
  the IDE tools, not an SSH filesystem or a collaboration server. `people`, `agents`, `models`
  and `forgejo` stay out of its capabilities unless that provider supplies those services.

Phosphorus's kind keeps working unchanged while other kinds are added. Its handler is the
proxy, so nothing a new kind does reaches it.
