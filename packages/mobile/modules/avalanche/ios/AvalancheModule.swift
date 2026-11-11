import AvalancheFFI
import ExpoModulesCore

public final class AvalancheModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Avalanche")

    // Async functions run off the JS thread.
    AsyncFunction("modelInfo") { (path: String) -> String in
      Self.take(avalanche_model_info(path))
    }
  }

  // Copies a string the library returned and releases it.
  private static func take(_ s: UnsafeMutablePointer<CChar>?) -> String {
    guard let s else { return #"{"error":"no result"}"# }
    defer { avalanche_free(s) }
    return String(cString: s)
  }
}
