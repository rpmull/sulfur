package io.phosphorus.mobile

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import io.phosphorus.mobile.data.Prefs
import io.phosphorus.mobile.data.ServerSession
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * Phosphorus has no push service: notices arrive on the open state and chat sockets. While
 * the app's process lives (and with "stay connected" on, it keeps living) they become
 * Android notifications whenever the app isn't on screen.
 */
object Notifier {
    const val CHAT = "chat"
    const val MESH = "mesh"
    const val LINK = "link"

    @Volatile var foreground = false
        private set

    /** The conversation on screen; its lines don't notify. */
    @Volatile var openConversation: String? = null

    private lateinit var app: Context
    private var job: Job? = null

    fun init(context: Context) {
        app = context.applicationContext
        val nm = app.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(listOf(
            NotificationChannel(CHAT, "Chat", NotificationManager.IMPORTANCE_HIGH).apply { description = "Messages in the mesh chat" },
            NotificationChannel(MESH, "Mesh notices", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "Notices from your Phosphorus desktop" },
            NotificationChannel(LINK, "Connection", NotificationManager.IMPORTANCE_MIN).apply { description = "Shown while the app stays connected in the background" },
        ))
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { foreground = true }
            override fun onStop(owner: LifecycleOwner) { foreground = false }
        })
    }

    fun watch(server: ServerSession, prefs: Prefs) {
        job?.cancel()
        job = server.scope.launch {
            launch {
                server.chat.incoming.collect { line ->
                    if (!prefs.flow.first().notify) return@collect
                    if (foreground && openConversation == line.conv) return@collect
                    if (foreground) return@collect
                    val title = when {
                        line.conv.startsWith("dm:") -> line.name
                        line.conv.startsWith("ch:") -> "${line.name} in #${line.conv.removePrefix("ch:")}"
                        else -> "${line.name} in #mesh"
                    }
                    val body = line.text.ifBlank { line.files.firstOrNull()?.name ?: "" }
                    post(CHAT, line.conv.hashCode(), title, body, "chat", line.conv)
                }
            }
            launch {
                server.mesh.notices.collect { n ->
                    if (!prefs.flow.first().notify || foreground) return@collect
                    // Chat's own notices arrive on the chat socket too; don't post them twice.
                    if (n.view == "chat") return@collect
                    post(MESH, (n.title + n.body).hashCode(), n.title ?: "Phosphorus", n.body.orEmpty(), n.view, n.conv)
                }
            }
        }
    }

    private fun post(channel: String, id: Int, title: String, body: String, view: String?, conv: String?) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val intent = Intent(app, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(MainActivity.EXTRA_VIEW, view)
            putExtra(MainActivity.EXTRA_CONV, conv)
        }
        val pi = PendingIntent.getActivity(app, id, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(app, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFFAB93ED.toInt())
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setCategory(if (channel == CHAT) NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_STATUS)
            .build()
        runCatching { NotificationManagerCompat.from(app).notify(id, n) }
    }
}
