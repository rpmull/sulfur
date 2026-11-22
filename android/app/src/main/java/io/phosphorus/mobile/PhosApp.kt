package io.phosphorus.mobile

import android.app.Application
import io.phosphorus.mobile.data.AppGraph

class PhosApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        Notifier.init(this)
    }
}
