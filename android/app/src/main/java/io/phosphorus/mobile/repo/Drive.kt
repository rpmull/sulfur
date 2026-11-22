package io.phosphorus.mobile.repo

import kotlinx.serialization.decodeFromString
import android.content.ContentResolver
import android.net.Uri
import io.phosphorus.mobile.net.At
import io.phosphorus.mobile.net.DriveItems
import io.phosphorus.mobile.net.DriveListing
import io.phosphorus.mobile.net.DriveMe
import io.phosphorus.mobile.net.DrivePlaces
import io.phosphorus.mobile.net.DriveRead
import io.phosphorus.mobile.net.PhosClient
import io.phosphorus.mobile.net.PhosException
import io.phosphorus.mobile.net.PhosJson
import io.phosphorus.mobile.net.UploadAnswer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import kotlin.random.Random

/**
 * Phosphorus Drive: the API the desktop's Files window uses. One {host, share, path} model
 * covers the synced home ("home"), each host's shares ("0", "1", ...) and whole disks ("fs").
 */
class Drive(private val client: PhosClient) {
    private val base = "/api/app/drive/site/api"

    private fun q(vararg kv: Pair<String, String>) =
        kv.joinToString("&") { (k, v) -> k + "=" + URLEncoder.encode(v, "UTF-8").replace("+", "%20") }

    suspend fun me(): DriveMe = PhosJson.decodeFromString(client.get("$base/me"))
    suspend fun places(): DrivePlaces = PhosJson.decodeFromString(client.get("$base/places"))

    suspend fun list(at: At): DriveListing =
        PhosJson.decodeFromString(client.get("$base/list?" + q("host" to at.host, "share" to at.share, "path" to at.path)))

    suspend fun read(at: At): DriveRead =
        PhosJson.decodeFromString(client.get("$base/read?" + q("host" to at.host, "share" to at.share, "path" to at.path)))

    fun fileUrl(at: At, inline: Boolean = true): String =
        client.url("$base/file?" + q("host" to at.host, "share" to at.share, "path" to at.path) + if (inline) "&inline=1" else "").toString()

    suspend fun recent(): DriveItems = PhosJson.decodeFromString(client.get("$base/recent"))
    suspend fun starred(): DriveItems = PhosJson.decodeFromString(client.get("$base/starred"))
    suspend fun shared(): DriveItems = PhosJson.decodeFromString(client.get("$base/shared"))
    suspend fun search(query: String): DriveItems = PhosJson.decodeFromString(client.get("$base/search?" + q("q" to query)))

    suspend fun mkdir(at: At) {
        client.post("$base/mkdir", PhosJson.encodeToJsonElement(at).toString())
    }

    suspend fun rename(at: At, name: String) {
        val body = buildJsonObject { put("host", at.host); put("share", at.share); put("path", at.path); put("name", name) }
        client.post("$base/rename", body.toString())
    }

    suspend fun trash(items: List<At>) {
        val body = buildJsonObject { put("items", JsonArray(items.map { PhosJson.encodeToJsonElement(it) })) }
        client.post("$base/trash", body.toString())
    }

    suspend fun star(at: At, on: Boolean, dir: Boolean) {
        val body = buildJsonObject {
            put("host", at.host); put("share", at.share); put("path", at.path); put("on", on); put("dir", dir)
        }
        client.post("$base/star", body.toString())
    }

    suspend fun copy(from: At, to: At, dir: Boolean, size: Long, move: Boolean) {
        val body = buildJsonObject {
            put("from", PhosJson.encodeToJsonElement(from)); put("to", PhosJson.encodeToJsonElement(to))
            put("dir", dir); put("size", size); put("move", move)
        }
        client.post("$base/copy", body.toString())
    }

    /**
     * Uploads [uri] to [dest] (a file path) in 8 MiB slices, as the web client does; a
     * 409 "out of order" answer resumes from the offset the server has.
     */
    suspend fun upload(
        resolver: ContentResolver,
        uri: Uri,
        dest: At,
        total: Long,
        progress: (Long, Long) -> Unit,
    ) = withContext(Dispatchers.IO) {
        val id = (1..12).map { "abcdefghijklmnopqrstuvwxyz0123456789"[Random.nextInt(36)] }.joinToString("")
        val chunk = 8 * 1024 * 1024
        val octet = "application/octet-stream".toMediaType()
        var offset = 0L
        fun url(off: Long) = "$base/upload?" + q(
            "host" to dest.host, "share" to dest.share, "path" to dest.path,
            "id" to id, "offset" to off.toString(), "total" to total.toString(),
        )
        if (total == 0L) {
            client.post(url(0), ByteArray(0).toRequestBody(octet))
            progress(0, 0)
            return@withContext
        }
        while (offset < total) {
            val len = minOf(chunk.toLong(), total - offset).toInt()
            val buf = ByteArray(len)
            // Reopen per slice so a resumed offset can seek without holding the stream.
            (resolver.openInputStream(uri) ?: throw PhosException(0, "can't read the file")).use { input ->
                var skip = offset
                while (skip > 0) {
                    val n = input.skip(skip)
                    if (n <= 0) throw PhosException(0, "can't seek in the file")
                    skip -= n
                }
                var read = 0
                while (read < len) {
                    val n = input.read(buf, read, len - read)
                    if (n < 0) break
                    read += n
                }
                if (read < len) throw PhosException(0, "the file changed while uploading")
            }
            val answer = try {
                PhosJson.decodeFromString<UploadAnswer>(client.post(url(offset), buf.toRequestBody(octet)))
            } catch (e: PhosException) {
                // Out of order: the server says how much it has; carry on from there.
                val have = if (e.status == 409) runCatching {
                    PhosJson.decodeFromString<UploadAnswer>(e.body ?: "").have
                }.getOrNull() else null
                if (have == null || have == offset) throw e
                offset = have
                continue
            }
            offset = answer.next ?: if (answer.path != null) total else offset + len
            progress(offset, total)
        }
    }

    companion object {
        fun parent(path: String) = path.substringBeforeLast('/', "")
        fun join(dir: String, name: String) = if (dir.isEmpty()) name else "$dir/$name"
    }
}
