package io.phosphorus.mobile

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the process (and so the state, chat and terminal sockets) alive in the background,
 * for chat notifications and terminals that survive switching apps. Opt-in from Settings.
 */
class LinkService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val domain = intent?.getStringExtra(EXTRA_DOMAIN) ?: "your mesh"
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(this, Notifier.LINK)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Connected to $domain")
            .setContentText("Chat and terminals stay live")
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .build()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, 1, n, type)
        return START_STICKY
    }

    companion object {
        const val EXTRA_DOMAIN = "domain"

        fun start(context: Context, domain: String) {
            runCatching {
                ContextCompat.startForegroundService(context, Intent(context, LinkService::class.java).putExtra(EXTRA_DOMAIN, domain))
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LinkService::class.java))
        }
    }
}
