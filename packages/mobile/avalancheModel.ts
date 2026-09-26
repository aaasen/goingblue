import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { gunzipSync } from 'fflate';
import { loadModels, type Models } from '@weather/protocol';
import { setAvalancheModels } from './cache';

// The avalanche bulletin model, bundled with the app (metro.config.js registers .gz as an asset)
// and loaded once, the first time an avalanche forecast is sent, pasted, or shown. It unpacks to
// about 18 MB, so a reader who never uses the Avalanche tab never pays for it.
const MODEL = require('../protocol/assets/avcan-model.bin.gz');

let loaded: Models | null = null;
let loading: Promise<Models> | null = null;

// The model once it has loaded, or null before then.
export function avalancheModels(): Models | null {
  return loaded;
}

// Starts the load if it hasn't started. A failed load is retried by the next call.
export function loadAvalancheModels(): Promise<Models> {
  loading ??= (async () => {
    const asset = Asset.fromModule(MODEL);
    await asset.downloadAsync();
    if (!asset.localUri) throw new Error('avalanche model did not resolve');
    loaded = loadModels(gunzipSync(await new File(asset.localUri).bytes()));
    setAvalancheModels(loaded);
    return loaded;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}
