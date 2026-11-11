import { requireOptionalNativeModule, type NativeModule } from 'expo';

export interface ModelInfo {
  name: string;
  dim: number;
  layers: number;
  ffn: number;
  vocab: number;
  codable: number;
  pieces: number;
  markers: number;
  arrays: number;
}

declare class AvalancheModule extends NativeModule {
  modelInfo(path: string): Promise<string>;
}

// Null in any build without the native module (tests, web).
const native = requireOptionalNativeModule<AvalancheModule>('Avalanche');

// The native library answers in JSON: {"ok": ...} or {"error": "..."}.
function unwrap<T>(json: string): T {
  const r = JSON.parse(json) as { ok: T } | { error: string };
  if ('error' in r) throw new Error(`avalanche: ${r.error}`);
  return r.ok;
}

// Describes the model file at `path` (a local file path, not a file:// URI).
export async function modelInfo(path: string): Promise<ModelInfo> {
  if (!native) throw new Error('avalanche: native module not in this build');
  return unwrap(await native.modelInfo(path));
}
