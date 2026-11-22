package io.phosphorus.mobile.repo

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import io.phosphorus.mobile.net.PhosClient
import io.phosphorus.mobile.net.PhosException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import java.io.File

object Downloads {
    fun mime(name: String): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

    /** Saves to the phone's Downloads through the system's download manager, with the session cookie. */
    fun toDownloads(context: Context, client: PhosClient, url: String, name: String) {
        val u = url.toHttpUrl()
        val cookie = client.session.loadForRequest(u).joinToString("; ") { "${it.name}=${it.value}" }
        val req = DownloadManager.Request(Uri.parse(url))
            .addRequestHeader("Cookie", cookie)
            .setTitle(name)
            .setMimeType(mime(name))
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "Phosphorus/" + name.replace('/', '_'))
        context.getSystemService(DownloadManager::class.java).enqueue(req)
    }

    /** Fetches into the app's cache and returns a content URI another app may read. */
    suspend fun toCache(context: Context, client: PhosClient, url: String, name: String): Uri = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "open").apply { mkdirs() }
        val file = File(dir, name.replace('/', '_'))
        client.http.newCall(Request.Builder().url(url).build()).execute().use { r ->
            if (!r.isSuccessful) throw PhosException(r.code, "download failed (${r.code})")
            r.body?.byteStream()?.use { input -> file.outputStream().use { input.copyTo(it) } }
        }
        FileProvider.getUriForFile(context, context.packageName + ".files", file)
    }

    fun openWith(context: Context, uri: Uri, name: String) {
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime(name)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(Intent.createChooser(intent, "Open $name").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun share(context: Context, uri: Uri, name: String) {
        val intent = Intent(Intent.ACTION_SEND).setType(mime(name)).putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(Intent.createChooser(intent, "Share $name").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
