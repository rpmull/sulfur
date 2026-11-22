# Phosphorus for Android

A native Android app for a Phosphorus mesh. You type your mesh's domain and sign in, and you
get your mesh's terminals, git, drive, chat, device status and settings on your phone.

Kotlin, Jetpack Compose and Material 3, themed from Phosphorus's own palette
(`web/theme/theme.json`): System, Light, Dark and Black. On tablets and foldables the bottom
bar becomes a navigation rail.

## What it does

| Tab | What you get | Phosphorus API |
|-----|--------------|----------------|
| **Devices** | Every host on the mesh. Each one shows whether it's online, plus live CPU and memory sparklines. A mesh-wide summary sits on top. Tap a host for gauges, per-core load, memory and swap, disk and I/O, network rates, GPUs, top processes and 24-hour trends. From there you can jump to a terminal or the host's files. | `/api/state` and `/api/stats` (WebSockets) |
| **Terminal** | Real shells on any host, drawn by xterm.js (bundled, offline) inside a WebView. A key bar gives you Esc, Tab, Ctrl, Alt, arrows, ^C/^D/^Z/^L/^R, Home/End and PgUp/PgDn. Pinch to zoom. Copy and paste. A dropped connection resumes the same session, with no output lost. You can also open the Phos shell. Hosts with a login saved in your vault sign in by themselves. | `/api/term/<host>`, `/api/psh` |
| **Files** | Drive: your synced home, Everyone, each host's shares, and whole disks where you've saved a login. Also Recent, Starred, Shared with me, and search. You can upload (chunked and resumable, several files at once), make folders, rename, star, move to trash, and download to `Downloads/Phosphorus`. Previews cover images (pinch zoom), text and code with line numbers, and rendered Markdown. Anything else opens in another app. Files shared to Phosphorus from other apps can be uploaded into any folder. | `/api/app/drive/site/api/*` |
| **Git** | Your repositories, searchable, plus your open issues and pull requests across all of them. In a repository: code browsing on any branch, the README, language bar and clone URL; commit history with diffs; issues and pull requests with the full timeline. You can comment, close, reopen, open new issues, see a PR's changed files and merge it. Actions runs show live status, jobs and step logs, with rerun and cancel. | `/api/app/git/ui/-/*` |
| **Chat** | #mesh, channels and direct messages, with unread counts, who's online, and typing indicators. Messages support Markdown, replies, reactions, editing and deleting your own, and image and file attachments. You can create channels. | `/api/app/chat/ws`, `/upload`, `/media` |
| **Settings** | Theme, terminal text size, notifications, staying connected in the background, changing your password, mesh version and updates, the people on the mesh (for admins), sign out, and switching meshes. | `/api/me/*`, `/api/users` |

Notifications: Phosphorus has no push service, so chat messages and desktop notices arrive on
the app's open sockets. They are posted as Android notifications whenever the app isn't on
screen. **Settings › Stay connected** keeps those sockets, and your terminals, alive in the
background through a foreground service.

## Signing in

The first screen asks for your mesh's domain: the one set in the desktop's **Settings ›
Domain**, for example `example.com`.

- It assumes `https://`. Type `http://host:port` to reach a desktop on a LAN or mesh address;
  the app warns that this isn't encrypted.
- The app signs in with your Phosphorus user and password, as the desktop does, and keeps the
  `phosphorus-user` session cookie. That cookie is encrypted with a key in the Android keystore
  and excluded from backups.
- Your password is never stored. The session lasts 30 days, and changing your password ends it.

## Building

You need JDK 17+ and the Android SDK (platform 35). Android Studio provides both.

```sh
cd android
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug         # onto a connected phone
```

**Release builds** are signed when `android/keystore.properties` exists. That file is never
committed. It looks like this:

```properties
storeFile=/path/to/release.jks
storePassword=…
keyAlias=phosphorus
keyPassword=…
```

Then run `./gradlew assembleRelease` (or `bundleRelease` for Play).

The debug build installs beside a release build as `io.phosphorus.mobile.debug`.

## Layout

```
app/src/main/
  assets/terminal/        xterm.js 6 page the terminal WebView draws with (Kotlin owns the socket)
  java/io/phosphorus/mobile/
    net/                  OkHttp client, wire models (after crates/core/wire), reconnecting socket
    repo/                 Mesh (sign-in, state, stats), Drive, Git, Chat, Terminals, Downloads
    data/                 preferences, encrypted session cookies, per-server session graph
    ui/                   Compose screens: onboarding, shell, devices, terminal, files, git, chat, settings
```

## Notes

- **Host power actions**: Phosphorus has no REST endpoint for reboot or shutdown. Only its MCP
  `host_power` tool, which needs a key, can do it. So the app doesn't offer them.
- **Chat history**: the server sends the last 1000 lines on connect and has no paging, so
  that's how far back the app goes.
- **Terminals**: these are tied to the app's process. Phosphorus keeps a shell for ten minutes
  without a viewer, and the app resumes it within that time. With Stay connected on, the
  process (and so the terminals) lives on in the background.
