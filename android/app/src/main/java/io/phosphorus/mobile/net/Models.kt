package io.phosphorus.mobile.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// Wire types, after crates/core/wire in Phosphorus. Every field a server may leave out is
// nullable or defaulted, so an older or newer mesh still decodes.

// ---- account ----

@Serializable
data class Me(
    val user: String = "",
    val admin: Boolean = false,
    val prefs: Map<String, String> = emptyMap(),
    val prefsAt: Long = 0,
    val avatar: Long = 0,
    val vault: Vault? = null,
)

@Serializable
data class Vault(val hosts: Map<String, VaultLogin> = emptyMap())

@Serializable
data class VaultLogin(val user: String = "", val pass: String = "")

@Serializable
data class MeshUsers(val users: List<MeshUser> = emptyList())

@Serializable
data class MeshUser(val name: String, val admin: Boolean = false)

@Serializable
data class MeError(val error: String? = null, val setup: Boolean = false)

// ---- mesh state ----

@Serializable
data class MeshState(
    val domain: String? = null,
    val self: SelfInfo = SelfInfo(),
    val tailnet: List<TailnetDevice> = emptyList(),
    val hosts: Map<String, HostInfo> = emptyMap(),
    val load: Map<String, HostLoad> = emptyMap(),
    val update: UpdateInfo? = null,
    val home: String? = null,
)

@Serializable
data class SelfInfo(val host: String = "", val version: String? = null, val platform: String? = null)

@Serializable
data class TailnetDevice(
    val name: String,
    val os: String? = null,
    val phosphorus: Boolean = false,
    val phosphorusSeen: Boolean = false,
    val version: String? = null,
)

@Serializable
data class HostInfo(
    val version: String? = null,
    val platform: String? = null,
    val arch: String? = null,
    val distro: String? = null,
    val model: String? = null,
    val publicIPv4: String? = null,
    val files: HostFiles? = null,
    val net: HostNet? = null,
)

@Serializable
data class HostFiles(val enabled: Boolean? = null, val shares: List<HostShare> = emptyList())

@Serializable
data class HostShare(val id: String, val label: String = "", val perms: String? = null, val home: Boolean = false)

@Serializable
data class HostNet(val ip: String? = null, val up: Boolean? = null, val relay: Boolean? = null)

@Serializable
data class HostLoad(val host: String = "", val cpu: Double = 0.0, val mem: Double = 0.0, val load1: Double? = null)

@Serializable
data class UpdateInfo(val latest: String? = null, val notes: String? = null)

/** A notice pushed on the state socket: `{type:"phosphorus-ui", at, action:{kind:"notify",...}}`. */
@Serializable
data class UiFrame(val type: String? = null, val at: Long = 0, val action: UiAction? = null)

@Serializable
data class UiAction(
    val kind: String = "",
    val title: String? = null,
    val body: String? = null,
    val view: String? = null,
    val from: String? = null,
    val conv: String? = null,
)

// ---- live stats (/api/stats socket) ----

@Serializable
data class StatsSample(
    val host: String,
    val at: Long = 0,
    val platform: String? = null,
    val version: String? = null,
    val cpu: CpuStats = CpuStats(),
    val mem: MemStats = MemStats(),
    val net: List<NetIf> = emptyList(),
    val netDay: NetDay? = null,
    val trend: Trend? = null,
    val io: IoStats? = null,
    val disk: DiskStats = DiskStats(),
    val gpus: List<GpuStats> = emptyList(),
    val uptime: Double? = null,
    val procs: Procs? = null,
)

@Serializable
data class CpuStats(
    val total: Double = 0.0,
    val cores: List<Double> = emptyList(),
    val model: String? = null,
    val load: List<Double?> = emptyList(),
)

@Serializable
data class MemStats(
    val total: Double = 0.0,
    val used: Double = 0.0,
    val avail: Double = 0.0,
    val cached: Double = 0.0,
    val swapTotal: Double = 0.0,
    val swapUsed: Double = 0.0,
)

@Serializable
data class NetIf(val name: String = "", val rx: Double = 0.0, val tx: Double = 0.0)

@Serializable
data class NetDay(val rx: Double = 0.0, val tx: Double = 0.0, val since: Long? = null)

@Serializable
data class Trend(
    val at: Long = 0,
    val step: Long = 0,
    val cpu: List<Double?> = emptyList(),
    val mem: List<Double?> = emptyList(),
    val disk: List<Double?> = emptyList(),
    val rx: List<Double?> = emptyList(),
    val tx: List<Double?> = emptyList(),
)

@Serializable
data class IoStats(val r: Double = 0.0, val w: Double = 0.0)

@Serializable
data class DiskStats(val total: Double = 0.0, val used: Double = 0.0, val count: Int = 0)

@Serializable
data class GpuStats(
    val name: String = "",
    val util: Double? = null,
    val temp: Double? = null,
    val memUsed: Double? = null,
    val memTotal: Double? = null,
)

@Serializable
data class Procs(val count: Int = 0, val top: List<Proc> = emptyList())

@Serializable
data class Proc(val name: String = "", val pid: Long = 0, val cpu: Double = 0.0, val mem: Double = 0.0, val cmd: String? = null)

// ---- drive ----

@Serializable
data class DriveMe(val user: String = "", val admin: Boolean = false, val host: String = "", val domain: String? = null, val homePath: String? = null)

@Serializable
data class DrivePlaces(val hosts: List<DrivePlaceHost> = emptyList())

@Serializable
data class DrivePlaceHost(val host: String, val up: Boolean = false, val login: Boolean = false, val shares: List<HostShare> = emptyList())

@Serializable
data class DriveListing(val path: String = "", val entries: List<DriveEntry> = emptyList(), val truncated: Boolean = false, val role: String? = null)

@Serializable
data class DriveEntry(
    val name: String,
    val dir: Boolean = false,
    val empty: Boolean = false,
    val link: Boolean = false,
    val size: Long? = null,
    val mtime: Long? = null,
    val starred: Boolean = false,
)

@Serializable
data class DriveItem(
    val host: String,
    val share: String,
    val path: String,
    val name: String = path.substringAfterLast('/'),
    val dir: Boolean = false,
    val size: Long? = null,
    val mtime: Long? = null,
    val owner: String? = null,
)

@Serializable
data class DriveItems(val items: List<DriveItem> = emptyList())

@Serializable
data class DriveRead(val path: String = "", val size: Long? = null, val text: String? = null, val tooBig: Boolean = false, val binary: Boolean = false)

@Serializable
data class UploadAnswer(val ok: Boolean = false, val next: Long? = null, val path: String? = null, val have: Long? = null, val error: String? = null)

@Serializable
data class At(val host: String, val share: String, val path: String)

// ---- git ----

@Serializable
data class RepoRow(
    val id: Long = 0,
    val owner: String = "",
    val name: String = "",
    val full: String = "$owner/$name",
    val description: String? = null,
    val private: Boolean = false,
    val archived: Boolean = false,
    val mirror: Boolean = false,
    val topics: List<String> = emptyList(),
    val stars: Int = 0,
    val updated: Long = 0,
)

@Serializable
data class RepoDetail(
    val owner: String = "",
    val name: String = "",
    val description: String? = null,
    val private: Boolean = false,
    val archived: Boolean = false,
    val default_branch: String = "main",
    val has_issues: Boolean = true,
    val has_pulls: Boolean = true,
    val has_actions: Boolean = false,
    val open_issues: Int = 0,
    val open_pulls: Int = 0,
    val clone_url: String? = null,
    val empty: Boolean = false,
    val branches: Int = 0,
    val tags: Int = 0,
    val stars: Int = 0,
    val can_write: Boolean = false,
    val languages: List<List<JsonElement>> = emptyList(),
)

@Serializable
data class Commit(
    val sha: String,
    val parents: List<String> = emptyList(),
    val author: String = "",
    val email: String? = null,
    val person: String? = null,
    val at: Long = 0,
    val subject: String = "",
    val body: String? = null,
)

@Serializable
data class CommitPage(val commits: List<Commit> = emptyList(), val more: Boolean = false)

@Serializable
data class CommitDetail(val commit: Commit, val diff: String = "")

@Serializable
data class Branch(
    val name: String,
    val sha: String = "",
    val at: Long = 0,
    val author: String? = null,
    val subject: String? = null,
    val default: Boolean = false,
    val ahead: Int? = null,
    val behind: Int? = null,
)

@Serializable
data class TreeAnswer(
    val ref: String? = null,
    val path: String = "",
    val kind: String? = null,
    val entries: List<TreeEntry> = emptyList(),
    val last: Commit? = null,
    val readme: Readme? = null,
    val empty: Boolean = false,
    val clone_url: String? = null,
)

@Serializable
data class TreeEntry(val name: String, val path: String, val type: String = "blob", val symlink: Boolean = false)

@Serializable
data class Readme(val path: String = "", val text: String = "", val markdown: Boolean = true)

@Serializable
data class BlobAnswer(
    val path: String = "",
    val size: Long = 0,
    val lines: Int = 0,
    val type: String = "text",
    val media: String? = null,
    val markdown: Boolean = false,
    val text: String? = null,
    val raw: String? = null,
)

@Serializable
data class Label(val name: String = "", val color: String? = null)

@Serializable
data class ThreadRow(
    val repo: String? = null,
    val index: Int,
    val pull: Boolean = false,
    val title: String = "",
    val author: String = "",
    val person: String? = null,
    val state: String = "open",
    val merged: Boolean = false,
    val created: Long = 0,
    val comments: Int = 0,
    val labels: List<Label> = emptyList(),
    val excerpt: String? = null,
)

@Serializable
data class ThreadPage(val open: Int = 0, val closed: Int = 0, val items: List<ThreadRow> = emptyList(), val more: Boolean = false)

@Serializable
data class ThreadDetail(
    val index: Int,
    val pull: Boolean = false,
    val title: String = "",
    val body: String = "",
    val author: String = "",
    val person: String? = null,
    val state: String = "open",
    val merged: Boolean = false,
    val created: Long = 0,
    val labels: List<Label> = emptyList(),
    val notes: List<Note> = emptyList(),
    val can: Can = Can(),
    val pr: PullInfo? = null,
)

@Serializable
data class Can(val write: Boolean = false, val comment: Boolean = false, val edit: Boolean = false)

@Serializable
data class Note(
    val id: Long = 0,
    val kind: String = "comment",
    val author: String = "",
    val person: String? = null,
    val at: Long = 0,
    val body: String? = null,
    val mine: Boolean = false,
)

@Serializable
data class PullInfo(
    val base: String = "",
    val head: String = "",
    val commits: Int = 0,
    val files: Int = 0,
    val add: Int = 0,
    val del: Int = 0,
    val mergeable: Boolean? = null,
    val checks: List<Check> = emptyList(),
    val can_merge: Boolean = false,
)

@Serializable
data class Check(val id: Long = 0, val name: String = "", val status: String = "")

@Serializable
data class DiffAnswer(val diff: String = "")

@Serializable
data class RunRow(
    val id: Long,
    val number: Int = 0,
    val workflow: String? = null,
    val name: String? = null,
    val title: String? = null,
    val event: String? = null,
    val ref: String? = null,
    val sha: String? = null,
    val actor: String? = null,
    val status: String = "",
    val created: Long = 0,
    val started: Long? = null,
    val finished: Long? = null,
)

@Serializable
data class RunPage(val total: Int = 0, val runs: List<RunRow> = emptyList(), val more: Boolean = false, val can_write: Boolean = false)

@Serializable
data class RunDetail(val run: RunRow, val jobs: List<JobRow> = emptyList(), val job: JobRow? = null, val can_write: Boolean = false)

@Serializable
data class JobRow(
    val id: Long,
    val name: String = "",
    val status: String = "",
    val started: Long? = null,
    val finished: Long? = null,
    val steps_done: Int = 0,
    val steps: JsonElement? = null,
)

@Serializable
data class Step(val idx: Int = 0, val name: String = "", val status: String = "", val log: String? = null)

@Serializable
data class Created(val index: Int = 0)

// ---- chat ----

@Serializable
data class ChatFile(val host: String, val id: String, val name: String = "", val type: String = "", val size: Long = 0)

@Serializable
data class ChatMsg(
    val host: String = "",
    val seq: JsonElement? = null,
    val timestamp: Long = 0,
    val name: String = "",
    val color: String? = null,
    val text: String = "",
    val kind: String? = null,
    val ch: String? = null,
    val dm: String? = null,
    val re: String? = null,
    val ref: String? = null,
    val files: List<ChatFile> = emptyList(),
    val em: String? = null,
    val emoji: String? = null,
    val on: Boolean? = null,
)

@Serializable
data class ChannelMeta(
    val created: Long = 0,
    val createdBy: String? = null,
    val topic: String? = null,
    val closedAt: Long? = null,
)

@Serializable
data class ChatPerson(val name: String, val color: String? = null, val host: String? = null, val typing: String? = null, val online: Boolean = true)
