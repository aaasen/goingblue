import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { gunzipSync } from 'fflate';
import { loadStructured, type Models, type ProseCoder } from '@weather/protocol';
import { decodeProse, encodeProse } from './modules/avalanche';
import { replyModelFile, setAvalancheModels } from './cache';

// The avalanche models, bundled with the app (metro.config.js registers .gz and .bin as assets):
// a structured model per center, loaded the first time a forecast it codes is sent, pasted, or
// shown, and the prose model every center shares, which the native module reads from its file.
const STRUCTURED: Record<string, number> = {
  'avcan-structured.bin.gz': require('../protocol/assets/avcan-structured.bin.gz'),
  'nwac-structured.bin.gz': require('../protocol/assets/nwac-structured.bin.gz'),
};
const PROSE_ASSET: number = require('../protocol/assets/prose-model.bin');

async function localPath(module: number): Promise<string> {
  const asset = Asset.fromModule(module);
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error(`avalanche model ${asset.name} did not resolve`);
  return asset.localUri;
}

let prose: Promise<ProseCoder> | null = null;
function proseCoder(): Promise<ProseCoder> {
  if (!prose) {
    prose = localPath(PROSE_ASSET).then((uri): ProseCoder => {
      // The native module wants a filesystem path, not a file:// URI.
      const path = decodeURIComponent(uri.replace(/^file:\/\//, ''));
      return {
        encode: (doc) => encodeProse(path, doc),
        decode: (bytes, layout) => decodeProse(path, bytes, layout),
      };
    });
    prose.catch(() => { prose = null; });
  }
  return prose;
}

const loading = new Map<string, Promise<Models>>();

// Starts the load of a structured model file if it hasn't started. A failed load is retried by the
// next call.
export function loadAvalancheModel(file: string): Promise<Models> {
  let load = loading.get(file);
  if (!load) {
    load = (async () => {
      const [uri, coder] = await Promise.all([localPath(STRUCTURED[file]), proseCoder()]);
      const models = { structured: loadStructured(gunzipSync(await new File(uri).bytes())), prose: coder };
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
