package io.phosphorus.mobile.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/**
 * The server's session cookies, kept encrypted with a key in the Android keystore, so a
 * sign-in survives restarts. Nothing typed at sign-in (passwords, codes) is ever stored.
 */
class SessionStore(context: Context) : CookieJar {
    private val prefs: SharedPreferences = runCatching {
        EncryptedSharedPreferences.create(
            context,
            "phosphorus_session",
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }.getOrElse {
        // A keystore that lost its key (restored backup, OS reset) leaves an unreadable file.
        context.deleteSharedPreferences("phosphorus_session")
        EncryptedSharedPreferences.create(
            context,
            "phosphorus_session",
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private val lock = Any()
    private val cookies = mutableListOf<Cookie>()

    init {
        prefs.getStringSet("cookies", emptySet())?.forEach { line ->
            val parts = line.split('\u0001', limit = 2)
            if (parts.size == 2) {
                val url = HttpUrl.Builder().scheme("https").host(parts[0]).build()
                Cookie.parse(url, parts[1])?.let { cookies += it }
            }
        }
    }

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) = synchronized(lock) {
        for (c in cookies) {
            this.cookies.removeAll { it.name == c.name && it.domain == c.domain && it.path == c.path }
            if (c.expiresAt > System.currentTimeMillis()) this.cookies += c
        }
        persist()
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> = synchronized(lock) {
        val now = System.currentTimeMillis()
        cookies.removeAll { it.expiresAt <= now }
        cookies.filter { it.matches(url) }
    }

    fun has(name: String): Boolean = synchronized(lock) { cookies.any { it.name == name } }

    fun value(url: HttpUrl, name: String): String? = loadForRequest(url).firstOrNull { it.name == name }?.value

    fun clear() = synchronized(lock) {
        cookies.clear()
        persist()
    }

    private fun persist() {
        // Cookie.toString() is Set-Cookie syntax; session cookies come back without an expiry,
        // which is what a phone app's sign-in wants.
        val lines = cookies.map { it.domain + '\u0001' + it.toString() }.toSet()
        prefs.edit().putStringSet("cookies", lines).apply()
    }
}
