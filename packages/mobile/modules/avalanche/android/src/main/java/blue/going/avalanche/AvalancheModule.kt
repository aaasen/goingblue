package blue.going.avalanche

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The Rust library (native/avalanche-ffi), built into src/main/jniLibs by native/build-mobile.sh.
// Requests and results are JSON strings; index.ts builds and reads them.
object AvalancheNative {
  init {
    System.loadLibrary("avalanche_ffi")
  }

  external fun modelInfo(path: String): String

  external fun encode(path: String, doc: String): String

  external fun decode(path: String, request: String): String
}

class AvalancheModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Avalanche")

    // Async functions run off the JS thread.
    AsyncFunction("modelInfo") { path: String -> AvalancheNative.modelInfo(path) }

    AsyncFunction("encode") { path: String, doc: String -> AvalancheNative.encode(path, doc) }

    AsyncFunction("decode") { path: String, request: String -> AvalancheNative.decode(path, request) }
  }
}
