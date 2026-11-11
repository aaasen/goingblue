import AvalancheFFI
import ExpoModulesCore

// Requests and results are JSON strings; index.ts builds and reads them.
public final class AvalancheModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Avalanche")

    // Async functions run off the JS thread.
    AsyncFunction("modelInfo") { (path: String) -> String in
      Self.take(avalanche_model_info(path))
    }

    AsyncFunction("encode") { (path: String, doc: String) -> String in
      Self.take(avalanche_encode(path, doc))
    }

    AsyncFunction("decode") { (path: String, request: String) -> String in
      Self.take(avalanche_decode(path, request))
    }
  }

  // Copies a string the library returned and releases it.
  private static func take(_ s: UnsafeMutablePointer<CChar>?) -> String {
    guard let s else { return #"{"error":"no result"}"# }
    defer { avalanche_free(s) }
    return String(cString: s)
  }
}
