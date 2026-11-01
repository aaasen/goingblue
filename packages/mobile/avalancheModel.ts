import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { gunzipSync } from 'fflate';
import { loadModels, type Models } from '@weather/protocol';
import { replyModelFile, setAvalancheModels } from './cache';

// The avalanche models, bundled with the app (metro.config.js registers .gz as an asset). Each is
// loaded once, the first time a forecast it codes is sent, pasted, or shown, and unpacks to tens of
// megabytes, so a reader only pays for the centers they use.
const MODELS: Record<string, number> = {
  'avcan-model.bin.gz': require('../protocol/assets/avcan-model.bin.gz'),
  'nwac-model.bin.gz': require('../protocol/assets/nwac-model.bin.gz'),
};

const loading = new Map<string, Promise<Models>>();

// Starts the load of a model file if it hasn't started. A failed load is retried by the next call.
export function loadAvalancheModel(file: string): Promise<Models> {
  let load = loading.get(file);
  if (!load) {
    load = (async () => {
      const asset = Asset.fromModule(MODELS[file]);
      await asset.downloadAsync();
      if (!asset.localUri) throw new Error(`avalanche model ${file} did not resolve`);
      const models = loadModels(gunzipSync(await new File(asset.localUri).bytes()));
      setAvalancheModels(models, file);
      return models;
    })();
    loading.set(file, load);
    load.catch(() => { loading.delete(file); });
  }
  return load;
}

// Loads the model of each reply that answers an avalanche request this device holds.
export async function loadModelsForReplies(token: string, ...replies: string[]): Promise<void> {
  const files = new Set(replies.map((r) => replyModelFile(r, token)).filter((f) => f !== null));
  await Promise.all([...files].map(loadAvalancheModel));
}
