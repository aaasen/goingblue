import ExpoModulesCore
import Network

// Watches the default network path for iOS 26's ultra-constrained flag, which is how the system
// reports a carrier satellite link. The monitor runs for the module's lifetime so the synchronous
// getter always has the latest path, and JS hears only actual changes.
public final class UltraConstrainedModule: Module {
  private let monitor = NWPathMonitor()
  private let queue = DispatchQueue(label: "blue.going.UltraConstrained")
  // Read and written only on `queue`.
  private var ultraConstrained = false

  public func definition() -> ModuleDefinition {
    Name("UltraConstrained")

    Events("onChange")

    OnCreate {
      monitor.pathUpdateHandler = { [weak self] path in
        guard let self else { return }
        let value = Self.isUltraConstrained(path)
        guard value != self.ultraConstrained else { return }
        self.ultraConstrained = value
        self.sendEvent("onChange", ["ultraConstrained": value])
      }
      monitor.start(queue: queue)
    }

    Function("isUltraConstrained") { () -> Bool in
      queue.sync { ultraConstrained }
    }

    OnDestroy {
      monitor.cancel()
    }
  }

  private static func isUltraConstrained(_ path: NWPath) -> Bool {
    if #available(iOS 26.0, *) {
      return path.isUltraConstrained
    }
    return false
  }
}
