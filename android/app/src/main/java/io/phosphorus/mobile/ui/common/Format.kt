package io.phosphorus.mobile.ui.common

import java.text.DateFormat
import java.util.Date
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.pow

object Format {
    fun bytes(n: Double?): String {
        if (n == null || n.isNaN()) return "—"
        if (n < 1024) return "${n.toLong()} B"
        val units = listOf("KB", "MB", "GB", "TB", "PB")
        val e = (ln(n) / ln(1024.0)).toInt().coerceIn(1, units.size)
        val v = n / 1024.0.pow(e)
        return (if (v >= 100) "%.0f" else if (v >= 10) "%.1f" else "%.2f").format(v) + " " + units[e - 1]
    }

    fun bytes(n: Long?) = bytes(n?.toDouble())

    fun rate(n: Double) = bytes(n) + "/s"

    fun pct(n: Double) = "%.0f%%".format(n.coerceIn(0.0, 100.0))

    fun ago(ms: Long, now: Long = System.currentTimeMillis()): String {
        if (ms <= 0) return ""
        val d = (now - ms) / 1000
        return when {
            abs(d) < 45 -> "now"
            d < 3600 -> "${d / 60}m"
            d < 86_400 -> "${d / 3600}h"
            d < 7 * 86_400 -> "${d / 86_400}d"
            d < 365 * 86_400 -> "${d / (7 * 86_400)}w"
            else -> "${d / (365 * 86_400)}y"
        }
    }

    fun agoLong(ms: Long): String {
        val a = ago(ms)
        return if (a == "now" || a.isEmpty()) "just now" else "$a ago"
    }

    fun time(ms: Long): String = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(ms))

    fun dateTime(ms: Long): String = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(ms))

    fun day(ms: Long): String = DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(ms))

    fun uptime(seconds: Double?): String {
        if (seconds == null) return "—"
        val s = seconds.toLong()
        val d = s / 86_400; val h = (s % 86_400) / 3600; val m = (s % 3600) / 60
        return when {
            d > 0 -> "${d}d ${h}h"
            h > 0 -> "${h}h ${m}m"
            else -> "${m}m"
        }
    }

    fun duration(start: Long?, end: Long?): String {
        if (start == null || start <= 0) return ""
        val s = ((end ?: System.currentTimeMillis()) - start) / 1000
        return if (s < 60) "${s}s" else if (s < 3600) "${s / 60}m ${s % 60}s" else "${s / 3600}h ${(s % 3600) / 60}m"
    }
}
