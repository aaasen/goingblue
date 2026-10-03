import { useEffect, useState } from 'react';
import { requireOptionalNativeModule, type NativeModule } from 'expo';

type Events = {
  onChange(event: { ultraConstrained: boolean }): void;
};

declare class UltraConstrainedModule extends NativeModule<Events> {
  isUltraConstrained(): boolean;
}

// Null in any build without the native module (tests, web), which reads as never constrained.
const native = requireOptionalNativeModule<UltraConstrainedModule>('UltraConstrained');

export function isUltraConstrained(): boolean {
  return native?.isUltraConstrained() ?? false;
}

// True while the app's network is ultra-constrained: a carrier satellite link on iOS 26+ or
// Android 16+.
export function useUltraConstrained(): boolean {
  const [value, setValue] = useState(isUltraConstrained);
  useEffect(() => {
    if (!native) return;
    const sub = native.addListener('onChange', (e) => setValue(e.ultraConstrained));
    // A change between the initial render and the subscription would otherwise be missed.
    setValue(native.isUltraConstrained());
    return () => sub.remove();
  }, []);
  return value;
}
