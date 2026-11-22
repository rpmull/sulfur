package io.phosphorus.mobile.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import io.phosphorus.mobile.ui.theme.ThemeMode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.store: DataStore<Preferences> by preferencesDataStore("phosphorus")

/** What the app remembers between launches, apart from the session itself (see [SessionStore]). */
data class AppPrefs(
    val server: String? = null,
    val theme: ThemeMode = ThemeMode.System,
    val termFontSize: Float = 13f,
    val lastHost: String? = null,
    val notify: Boolean = true,
    val stayConnected: Boolean = false,
)

class Prefs(private val context: Context) {
    private object K {
        val server = stringPreferencesKey("server")
        val theme = stringPreferencesKey("theme")
        val termFont = floatPreferencesKey("term_font")
        val lastHost = stringPreferencesKey("last_host")
        val notify = booleanPreferencesKey("notify")
        val stay = booleanPreferencesKey("stay_connected")
    }

    val flow: Flow<AppPrefs> = context.store.data.map { p ->
        AppPrefs(
            server = p[K.server],
            theme = p[K.theme]?.let { runCatching { ThemeMode.valueOf(it) }.getOrNull() } ?: ThemeMode.System,
            termFontSize = p[K.termFont] ?: 13f,
            lastHost = p[K.lastHost],
            notify = p[K.notify] ?: true,
            stayConnected = p[K.stay] ?: false,
        )
    }

    suspend fun current(): AppPrefs = flow.first()

    suspend fun setServer(url: String?) = context.store.edit { if (url == null) it.remove(K.server) else it[K.server] = url }
    suspend fun setTheme(mode: ThemeMode) = context.store.edit { it[K.theme] = mode.name }
    suspend fun setTermFont(size: Float) = context.store.edit { it[K.termFont] = size }
    suspend fun setLastHost(host: String) = context.store.edit { it[K.lastHost] = host }
    suspend fun setNotify(on: Boolean) = context.store.edit { it[K.notify] = on }
    suspend fun setStayConnected(on: Boolean) = context.store.edit { it[K.stay] = on }
}
