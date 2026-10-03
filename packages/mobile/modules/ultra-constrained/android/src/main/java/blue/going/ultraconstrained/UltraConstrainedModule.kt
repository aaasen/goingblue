package blue.going.ultraconstrained

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Watches the best internet network the app may use, constrained satellite networks included, and
// reports whether it is one: a network without NOT_BANDWIDTH_CONSTRAINED, or a satellite transport
// (which stays worth optimizing for even when the capability is set). Only Android 16 and later
// expose constrained networks to apps; earlier versions always report false.
class UltraConstrainedModule : Module() {
  private val thread = HandlerThread("UltraConstrained").apply { start() }
  private val handler = Handler(thread.looper)
  private val mainHandler = Handler(Looper.getMainLooper())
  // Read and written only on `thread`.
  private var ultraConstrained = false
  private var callback: ConnectivityManager.NetworkCallback? = null

  private val connectivityManager: ConnectivityManager?
    get() = appContext.reactContext?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

  override fun definition() = ModuleDefinition {
    Name("UltraConstrained")

    Events("onChange")

    OnCreate {
      if (Build.VERSION.SDK_INT >= 36) register()
    }

    Function("isUltraConstrained") {
      var value = false
      val latch = java.util.concurrent.CountDownLatch(1)
      handler.post {
        value = ultraConstrained
        latch.countDown()
      }
      latch.await()
      value
    }

    OnDestroy {
      callback?.let { cb -> runCatching { connectivityManager?.unregisterNetworkCallback(cb) } }
      thread.quitSafely()
    }
  }

  private fun register() {
    val cm = connectivityManager ?: return
    val request = NetworkRequest.Builder()
      .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_BANDWIDTH_CONSTRAINED)
      .build()
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
        update(
          !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_BANDWIDTH_CONSTRAINED) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_SATELLITE)
        )
      }

      override fun onLost(network: Network) {
        update(false)
      }
    }
    // ConnectivityManager throws on a request it rejects; the module then just reports false.
    runCatching { cm.registerBestMatchingNetworkCallback(request, cb, handler) }
      .onSuccess { callback = cb }
  }

  private fun update(value: Boolean) {
    if (value == ultraConstrained) return
    ultraConstrained = value
    // Events go out on the main thread.
    mainHandler.post { sendEvent("onChange", mapOf("ultraConstrained" to value)) }
  }
}
