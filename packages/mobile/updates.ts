import { useEffect, useRef } from 'react';
import * as Updates from 'expo-updates';
import { isUltraConstrained, useUltraConstrained } from './modules/ultra-constrained';

// How long after launch, or after leaving a satellite link, to wait before checking: the
// satellite flag arrives from a network callback a moment after the app starts, and checking
// before it lands could start a download over satellite.
const SETTLE_MS = 5000;

// The OTA update check, run from here rather than natively at launch (checkAutomatically is NEVER
// in app.json) so it can wait out a satellite link: on Android the satellite opt-in covers the
// whole app, and an update can be megabytes. Once per launch, like the native check; a downloaded
// update applies on the next launch.
export function useUpdateCheck(): void {
  const constrained = useUltraConstrained();
  const done = useRef(false);
  useEffect(() => {
    if (constrained || done.current || !Updates.isEnabled) return;
    const timer = setTimeout(async () => {
      if (isUltraConstrained()) return;
      done.current = true;
      try {
        const { isAvailable } = await Updates.checkForUpdateAsync();
        if (isAvailable) await Updates.fetchUpdateAsync();
      } catch {
        // The next launch checks again.
      }
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [constrained]);
}
