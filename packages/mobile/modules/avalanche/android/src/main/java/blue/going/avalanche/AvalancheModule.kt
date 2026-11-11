package blue.going.avalanche

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The Rust library (native/avalanche-ffi), built into src/main/jniLibs by native/build-mobile.sh.
object AvalancheNative {
  init {
    System.loadLibrary("avalanche_ffi")
  }

  external fun modelInfo(path: String): String
}

class AvalancheModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Avalanche")

    // Async functions run off the JS thread.
    AsyncFunction("modelInfo") { path: String -> AvalancheNative.modelInfo(path) }
  }
}
