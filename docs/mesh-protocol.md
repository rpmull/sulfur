# Sulfur and the meshes it works on

Sulfur is an editor for every machine you have. It always works on this computer, with no
mesh at all. A **mesh** adds more machines, plus whatever else that mesh can give. This file
covers three things: the boundary Sulfur keeps with the meshes it works on, why the boundary
sits where it does, and how a new kind of mesh is added.

Phosphorus is the first mesh, and the richest. Sulfur's boundary with it is exact: the
Phosphorus desktop's Sulfur window, `/sulfur/` on every Phosphorus host and Sulfur's own app
linked to a Phosphorus mesh all behave the same as before Sulfur had its own repository.

A Phosphorus host serves `/sulfur/` from the release's `sulfur-web.tar.gz`, installed onto
the mesh by its apps page. The page takes a file to open from its url
(`/sulfur/?host=H&share=S&path=P`, the home's files with `share=home`), and the desktop's
window holding it sends later ones as a same-origin `{ t: 'sulfur-open', host, share, path }`
message. On a Phosphorus mesh the editor's chat asks the model gateway as `agent-sulfur` and
its inline completions as `agent-sulfur-fast`: the Sulfur agent of Phosphorus's agents app,
listed there while the mesh has Sulfur installed, its models assigned like Tavern's.

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

| service | owner in `src-tauri/service/src` | version 1 boundary |
|---------|----------------------------------|--------------------|
| files/tree/search/upload | `files.rs` | `/api/files/<host>/<operation>` |
| live edit/disk conflicts | `collab.rs`, `ot.rs` | `/api/code/<host>` socket |
| terminals and reconnect | `processes.rs` | `/api/term/<host>` socket |
| toolchains, tasks, Git | `processes.rs` | `/api/sulfur/toolchains`, `/run`, `/git` |
| language management/LSP | `languages.rs` | `/api/sulfur/languages` socket |
| SQLite | `sqlite.rs` | `/api/sulfur/sqlite` |
| Open VSX | `registry.rs`, `vsix.rs`, `bundle.rs` | `/api/sulfur/vsx/*` |

`sulfur sulfur-language <base64-request>` accepts the same request fields and
newline JSON messages, and `sulfur sulfur-sqlite` accepts its JSON request on
stdin. Both run from the app's own executable before any window opens.
Phosphorus can keep invoking `phosphorus sulfur-language` and
`phosphorus sulfur-sqlite` on its own hosts: those remote helpers belong to that
mesh and do not need to switch implementations for the IDE to connect.

The former Go `hostkit` source is absent from this repository. Existing Go importers
must pin the last compatible Go revision (or retain that implementation in their
own codebase) until they move to the service/CLI protocol. Do not replace a Go
module pin with this repository and expect Go imports to resolve. The separate
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
| `toolchains`, `runs`, `languages`, `git`, `sqlite`, `vsx` | `/api/sulfur/*` | this computer, by the service in the app | every host, by its mesh service/helper |
| `people` | sharing a file, `/api/me/vault` | — | the mesh's people |
| `agents` | `/api/code/*` | — | Claude Code and opencode on any host |
| `models` | `/api/model/v1/*` | — | chat and inline suggestions |
| `forgejo` | `/api/sulfur/forgejo` | — | the mesh's Forgejo |

Sulfur's server reports the linked mesh's kind and capabilities in `/api/sidecar/info` as
`mesh: { kind, version: 1, caps }`. `PROVIDERS` in `src-tauri/service/src/mesh.rs` lists the
kinds: `phosphorus`, linked as the mesh, and `ssh`, which Sulfur's own server serves beside
whichever mesh is linked (see [SSH hosts](#ssh-hosts)). The overlay integrations below are
extension designs, not working providers.

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

## SSH hosts

A machine reached with `ssh user@host` works as a host with no mesh at all: its files,
live editing, terminals, builds and runs, Git and toolchains. Sulfur's own server holds the
SSH connection (`src-tauri/service/src/ssh.rs`, on [russh](https://crates.io/crates/russh)
and [russh-sftp](https://crates.io/crates/russh-sftp)) and serves each saved host under
`/api/ssh/<name>/` with the same version 1 APIs a mesh host gives under `/api/mesh/`:

| capability | calls under `/api/ssh/<name>` | over |
|------------|-------------------------------|------|
| `files` | `/api/files/<name>/{info,list,tree,search,read,download,upload,save,mkdir,rename,delete}` | SFTP |
| `sessions` | `/api/code/<name>?share=…&path=…` (socket): the same live sessions, the file watched every 1.5 s | SFTP |
| `terminals` | `/api/term/<name>?sid=…` (socket): the login shell in a pseudo-terminal, kept ten minutes for a reloaded page | an SSH channel with a PTY |
| `runs` | `/api/sulfur/run` (socket) | an SSH channel with a PTY |
| `git` | `/api/sulfur/git` (POST): the verbs and refusals of this computer's Git | an SSH exec channel |
| `toolchains` | `/api/sulfur/toolchains` | an SSH exec channel |

The `ssh` provider advertises exactly those (plus `hosts`). It has no merged `home` (each
host's home is its own), and no `people`, `agents`, `models`, `forgejo`, `languages`,
`sqlite` or `vsx`. It is never linked as the mesh: `/api/sidecar/mode` refuses it.

The page finds the hosts in `/api/sidecar/info` as `ssh: { kind, version, caps, hosts }`,
each host `{ name, host, port, user, key, connected, info }`, `info` being the host's facts
as `/api/state` gives them (platform, shell, home, shares: the folder holding the user's
home as `home`, `/` as `0`). It manages them with:

| call | does |
|------|------|
| `GET /api/sidecar/ssh` | the provider and its hosts |
| `POST /api/sidecar/ssh/add` `{ address, key?, name? }` | saves a host from `user@host`, `user@host:2222`, `ssh://user@host:2222/path` or scp's `user@host:/path`; answers `{ host, path }`, the path to open once connected |
| `POST /api/sidecar/ssh/connect` `{ name, password?, passphrase?, trust?, remember? }` | connects; a 401 with `need` says what to ask: `trust` (a new host key, its `fingerprint`), `password` or `passphrase` |
| `POST /api/sidecar/ssh/disconnect` `{ name }` | saves its open files, ends its terminals, closes the connection |
| `POST /api/sidecar/ssh/forget` `{ name }` | disconnects it and removes it |

A host's name is an API host name (lowercase letters, digits and dashes): a DNS name's
first label or the whole address (`172-18-220-63`), never this computer's. The page routes
every saved name to `/api/ssh/<name>/` for the page's life, so an open tab of a dropped
host never reaches another host or this computer's files.

**Host keys** are checked against `~/.ssh/known_hosts`, the file `ssh` itself uses. A host
not in it is refused with its SHA-256 fingerprint until the user trusts that exact key,
which is then added there; a key that differs from the known one is refused outright,
naming the line to remove if the machine was reinstalled.

**Logins** go as `ssh` tries them: ssh-agent (`SSH_AUTH_SOCK`, or Windows OpenSSH's
`\\.\pipe\openssh-ssh-agent`), then `~/.ssh/id_ed25519`, `id_ecdsa` and `id_rsa` (or the
one key a host names), then a password, through `password` or a one-prompt
`keyboard-interactive`. A key's passphrase is asked for when it's the host's named key, or
when the server takes no passwords. Saved hosts are written to the app's settings
(`sulfur.json`'s `ssh` list) without anything typed for them. A password or passphrase
lives only in the service's memory: while the host is connected (to reconnect quietly
after a network drop, at most every ten seconds, so a server's MaxAuthTries and fail2ban
aren't tripped), and after a disconnect only when the page's `sulfur.ssh.rememberPasswords`
setting says so, until Sulfur quits. Nothing is written to disk or to the OS keychain.

Remote commands run through `sh -c` whatever the login shell is; a task's PATH gets the
toolchains' usual folders, as on this computer.

Not there yet:

- language servers, SQLite and Open VSX conversion on an SSH host (`languages`, `sqlite`, `vsx`);
- Windows SSH servers: hosts are taken to be Unix-like (Linux, macOS, the BSDs);
- `~/.ssh/config` (its `Host` aliases, `ProxyJump`, `IdentityFile`), Pageant, certificates and
  security keys;
- connecting again after Sulfur restarts: a saved host is connected from Remote: Connect to
  SSH Host, never on its own, and a folder of it that was open falls back to the home;
- a share's confinement on the host is by path only (`..` refused); symlinks are followed
  as SFTP follows them, with the login's own permissions.

### Git's prompts

This computer's Git, run for the page by `/api/sulfur/git`, never waits on a terminal it
doesn't have. For `clone`, `fetch`, `pull`, `push`, `remote` and `lfs pull`/`fetch`:

- unless the user has their own (`GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand`), ssh
  runs as `ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4`;
- with a page listening on `/api/sulfur/asks` (a socket) and the app's executable known,
  `SSH_ASKPASS` and `GIT_ASKPASS` are that executable, with `SSH_ASKPASS_REQUIRE=force`
  (OpenSSH 8.4 or later) and `SULFUR_ASKPASS=<port>:<token>`. Run that way it hands the
  prompt to the service over loopback with the run's token, the service to the page as
  `{ type: 'ask', id, prompt, secret }`, and the first `{ type: 'answer', id, value, remember }`
  goes back to ssh; `{ type: 'cancel', id }`, three minutes unanswered, or no page refuses
  it. The page asks in its input box, masked for a password, passphrase or code;
- with nobody to answer, or for a `quiet` request (the page's autofetch), ssh gets
  `-o BatchMode=yes` and a login that needs a password fails at once instead of at the
  run's 900 s limit.

An answer is kept only with `remember` (the page sends it under
`sulfur.ssh.rememberPasswords`), in memory, until Sulfur quits; a kept answer that's asked
for again in the same run is taken as refused and dropped. The `-c`, `--upload-pack`,
`--receive-pack`, `--exec`, `--config` and `-u` refusals stand for SSH addresses as for any.
Git run on an SSH host runs there with `GIT_TERMINAL_PROMPT=0` and no terminal: that host's
own remotes need its own keys.

## Adding a kind of mesh

A provider is an entry `{kind, version: 1, caps}` in `PROVIDERS` in
`src-tauri/service/src/mesh.rs`. The typed server address is normalized to the
provider's HTTP gateway and checked as reachable before it is remembered; today
`server_url` and `reach` do that for Phosphorus, and a kind with different
address or reachability rules needs its own. The gateway translates its network discovery, authentication and host transport
into the version 1 APIs under `/api/mesh/`.

- **Phosphorus** is built in. Sulfur proxies to its existing server, which owns
  authentication and remote services. No Phosphorus server deployment is changed.
- **SSH** is built in, served by Sulfur's own server per saved host (above). It is a
  provider with `linked: false`: hosts are added one by one, beside the linked mesh.
- **Overlay networks** need a gateway/adapter that reads network-specific peer
  state, authenticates SSH or another transport, and implements file, session,
  terminal and tool services. Tailscale, Headscale, NetBird, ZeroTier and Nebula
  integrations are designs, not shipped providers. They must not advertise
  merged `home`, `people`, `agents`, `models` or `forgejo` without implementing them.

A future native extension host on a remote workspace also needs an explicit,
authenticated host service. The local Node extension process rejects remote
workspace locations rather than reading similarly named local paths.
