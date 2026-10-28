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

Sulfur separates peer discovery from IDE services. The page and services are
JavaScript; Phosphorus remains free to implement its side in Go. A mesh adapter
normalizes its peers and exposes the version 1 file/session/tool APIs. A working
SSH port alone is not sufficient to advertise those capabilities.

## The three seams

### 1. The page: `web/src/host/contract.js`

Sulfur imports its frontend host only as `#host`. Standalone binds that name to
`web/src/sulfur/host.js`; the Phosphorus desktop binds it to its own host module.
The contract includes live account/host state, files, settings, theme and terminal
registries. Each page has one instance of stateful modules. Changes are additive
and must be implemented in both hosts before either starts using a new export.
The existing frontend boundary tests enforce this from Sulfur's side.

### 2. Host services and helper commands

| service | JavaScript owner | version 1 boundary |
|---------|------------------|--------------------|
| files/tree/search/upload | `server/files.js` | `/api/files/<host>/<operation>` |
| live edit/disk conflicts | `server/collab.js` | `/api/code/<host>` socket |
| terminals and reconnect | `server/processes.js` | `/api/term/<host>` socket |
| toolchains, tasks, Git | `server/processes.js` | `/api/sulfur/toolchains`, `/run`, `/git` |
| language management/LSP | `server/languages.js` | `/api/sulfur/languages` socket |
| SQLite | `server/sqlite.js` | `/api/sulfur/sqlite` |
| Open VSX | `server/registry.js`, `server/vsix.js` | `/api/sulfur/vsx/*` |

`server/main.js sulfur-language <base64-request>` accepts the same request fields
and newline JSON messages, and `server/main.js sulfur-sqlite` accepts its JSON
request on stdin. Packaged `sulfur-service` accepts these commands directly.
Phosphorus can keep invoking `phosphorus sulfur-language` and
`phosphorus sulfur-sqlite` on its own hosts: those remote helpers belong to that
mesh and do not need to switch implementations for the IDE to connect.

The former Go `hostkit` source is absent from this repository. Existing Go importers
must pin the last compatible Go revision (or retain that implementation in their
own codebase) until they move to the service/CLI protocol. Do not replace a Go
module pin with this JS branch and expect Go imports to resolve. The separate
checkout used by the Phosphorus extraction is unchanged by this migration.

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
| `toolchains`, `runs`, `languages`, `git`, `sqlite`, `vsx` | `/api/sulfur/*` | this computer, by the Bun service | every host, by its mesh service/helper |
| `people` | sharing a file, `/api/me/vault` | — | the mesh's people |
| `agents` | `/api/code/*` | — | Claude Code and opencode on any host |
| `models` | `/api/model/v1/*` | — | chat and inline suggestions |
| `forgejo` | `/api/sulfur/forgejo` | — | the mesh's Forgejo |

Sulfur's server reports the linked mesh's kind and capabilities in `/api/sidecar/info` as
`mesh: { kind, version: 1, caps }`. `server/mesh.js` defines and registers providers. Only `phosphorus` is implemented
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

A provider registers `{kind, version: 1, caps, normalize, reach}` through
`registerMeshProvider` in `server/mesh.js`. Normalization returns the HTTP gateway
for that provider; reachability is checked before the endpoint is remembered.
The gateway translates its network discovery, authentication and host transport
into the version 1 APIs under `/api/mesh/`.

- **Phosphorus** is built in. Sulfur proxies to its existing server, which owns
  authentication and remote services. No Phosphorus server deployment is changed.
- **Overlay networks** need a gateway/adapter that reads network-specific peer
  state, authenticates SSH or another transport, and implements file, session,
  terminal and tool services. Tailscale, Headscale, NetBird, ZeroTier and Nebula
  integrations are designs, not shipped providers. They must not advertise
  merged `home`, `people`, `agents`, `models` or `forgejo` without implementing them.

A future native extension host on a remote workspace also needs an explicit,
authenticated host service. The local Bun extension process rejects remote
workspace locations rather than reading similarly named local paths.
