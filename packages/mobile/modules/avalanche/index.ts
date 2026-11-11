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

// A forecast's prose with its context markers (see native/avalanche/src/lib.rs). To decode, give
// the same markers; texts are ignored.
export interface ProseDoc {
  markers: string[];
  sections: { markers: string[]; text?: string }[];
}

declare class AvalancheModule extends NativeModule {
  modelInfo(path: string): Promise<string>;
  encode(path: string, doc: string): Promise<string>;
  decode(path: string, request: string): Promise<string>;
}

// Null in any build without the native module (tests, web).
const native = requireOptionalNativeModule<AvalancheModule>('Avalanche');

function module(): AvalancheModule {
  if (!native) throw new Error('avalanche: native module not in this build');
  return native;
}

// The native library answers in JSON: {"ok": ...} or {"error": "..."}.
function unwrap<T>(json: string): T {
  const r = JSON.parse(json) as { ok: T } | { error: string };
  if ('error' in r) throw new Error(`avalanche: ${r.error}`);
  return r.ok;
}

// `path` is the model file's local path, not a file:// URI. The library loads each file once.

export async function modelInfo(path: string): Promise<ModelInfo> {
  return unwrap(await module().modelInfo(path));
}

export async function encodeProse(path: string, doc: ProseDoc): Promise<Uint8Array> {
  return Uint8Array.from(unwrap<number[]>(await module().encode(path, JSON.stringify(doc))));
}

export async function decodeProse(path: string, bytes: Uint8Array, layout: ProseDoc): Promise<string[]> {
  return unwrap(await module().decode(path, JSON.stringify({ ...layout, bytes: Array.from(bytes) })));
}
