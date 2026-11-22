package io.phosphorus.mobile.repo

import kotlinx.serialization.decodeFromString
import io.phosphorus.mobile.net.BlobAnswer
import io.phosphorus.mobile.net.Branch
import io.phosphorus.mobile.net.CommitDetail
import io.phosphorus.mobile.net.CommitPage
import io.phosphorus.mobile.net.Created
import io.phosphorus.mobile.net.DiffAnswer
import io.phosphorus.mobile.net.PhosClient
import io.phosphorus.mobile.net.PhosJson
import io.phosphorus.mobile.net.RepoDetail
import io.phosphorus.mobile.net.RepoRow
import io.phosphorus.mobile.net.RunDetail
import io.phosphorus.mobile.net.RunPage
import io.phosphorus.mobile.net.ThreadDetail
import io.phosphorus.mobile.net.ThreadPage
import io.phosphorus.mobile.net.TreeAnswer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URLEncoder

/** The mesh's forge, through its native `/-/` JSON API at /api/app/git/ui (the desktop's route). */
class Git(private val client: PhosClient) {
    private val base = "/api/app/git/ui"
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
    private fun repoPath(full: String) = "$base/-/repos/$full"

    fun avatarUrl(person: String) = client.url("$base/_avatar/${enc(person)}").toString()
    fun rawUrl(full: String, ref: String, path: String) =
        client.url("$base/$full/raw/${enc(ref)}/" + path.split('/').joinToString("/") { enc(it) }).toString()

    suspend fun repos(query: String = ""): List<RepoRow> =
        PhosJson.decodeFromString(client.get("$base/-/repos?sort=updated&q=${enc(query)}"))

    suspend fun repo(full: String): RepoDetail = PhosJson.decodeFromString(client.get(repoPath(full)))

    suspend fun branches(full: String): List<Branch> = PhosJson.decodeFromString(client.get(repoPath(full) + "/branches"))

    suspend fun tree(full: String, ref: String, path: String): TreeAnswer =
        PhosJson.decodeFromString(client.get(repoPath(full) + "/tree?ref=${enc(ref)}&path=${enc(path)}"))

    suspend fun blob(full: String, ref: String, path: String): BlobAnswer =
        PhosJson.decodeFromString(client.get(repoPath(full) + "/blob?ref=${enc(ref)}&path=${enc(path)}"))

    suspend fun commits(full: String, ref: String, page: Int, path: String = ""): CommitPage =
        PhosJson.decodeFromString(client.get(repoPath(full) + "/commits?ref=${enc(ref)}&path=${enc(path)}&page=$page"))

    suspend fun commit(full: String, sha: String): CommitDetail =
        PhosJson.decodeFromString(client.get(repoPath(full) + "/commits/$sha"))

    /** [kind] is "issues" or "pulls". */
    suspend fun threads(full: String, kind: String, state: String, page: Int, query: String = ""): ThreadPage =
        PhosJson.decodeFromString(client.get(repoPath(full) + "/$kind?state=$state&page=$page&q=${enc(query)}"))

    suspend fun thread(full: String, kind: String, n: Int): ThreadDetail =
        PhosJson.decodeFromString(client.get(repoPath(full) + "/$kind/$n"))

    suspend fun pullDiff(full: String, n: Int): String =
        PhosJson.decodeFromString<DiffAnswer>(client.get(repoPath(full) + "/pulls/$n/files")).diff

    /** Comments on an issue or a pull request; [state] "closed"/"open" also closes or reopens it. */
    suspend fun comment(full: String, n: Int, body: String, state: String? = null) {
        val json = buildJsonObject { put("body", body); if (state != null) put("state", state) }
        client.post(repoPath(full) + "/issues/$n/comment", json.toString())
    }

    suspend fun merge(full: String, n: Int, deleteBranch: Boolean) {
        client.post(repoPath(full) + "/issues/$n/merge", buildJsonObject { put("delete_branch", deleteBranch) }.toString())
    }

    suspend fun createIssue(full: String, title: String, body: String): Int =
        PhosJson.decodeFromString<Created>(
            client.post(repoPath(full) + "/issues", buildJsonObject { put("title", title); put("body", body) }.toString()),
        ).index

    suspend fun runs(full: String, page: Int): RunPage =
        PhosJson.decodeFromString(client.get(repoPath(full) + "/actions?page=$page"))

    suspend fun run(full: String, id: Long, job: Long? = null): RunDetail =
        PhosJson.decodeFromString(client.get(repoPath(full) + "/actions/runs/$id" + (job?.let { "?job=$it" } ?: "")))

    suspend fun rerun(full: String, id: Long) { client.post(repoPath(full) + "/actions/runs/$id/rerun") }
    suspend fun cancel(full: String, id: Long) { client.post(repoPath(full) + "/actions/runs/$id/cancel") }

    /** Your issues and pull requests across every repository. */
    suspend fun myThreads(kind: String): ThreadPage =
        PhosJson.decodeFromString(client.get("$base/-/threads?type=$kind&tab=yours&state=open"))
}
