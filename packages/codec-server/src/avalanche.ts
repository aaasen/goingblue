// Avalanche requests (`f:a`): fetch the bulletin covering the request's point from the center that
// forecasts there, encode it whole under that center's structured model and the shared prose
// model, and split it over as many messages as it takes. Unlike a weather
// reply, which fills the budget the reader chose, a bulletin is never cut to fit: a partial
// bulletin could leave out the one problem or advice line that matters.
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
// Loads the native binding when the server starts, so an image without it fails to boot.
import { AvalancheModel } from "@weather/avalanche-node";
import {
  NAC_CENTERS, avalancheAnchor, avalancheModelFile, encodeAvalancheMessage, loadStructured, pieceAt, PROSE_MODEL_FILE, WIRE_HEADER_CHARS,
  type AvalancheForecast, type Models, type ProseCoder, type StructuredModel,
} from "@weather/protocol";
import { fetchAreaPieces, fetchPointProduct, toForecast } from "./avcan.js";
import { splitReplyFor, type ForecastParams } from "./forecast.js";
import { fetchZoneProduct, toForecast as toNacForecast } from "./nac.js";

// Part labels ("i/N ") are budgeted at two digits each side at most.
const MAX_PARTS = 99;

// The models ship in the protocol package, beside this one in the workspace and in the image
// (Dockerfile.codec copies both); src/ and dist/ sit at the same depth.
const MODEL_DIR = new URL("../../protocol/assets/", import.meta.url);

// Each is loaded on its first request, so weather-only instances never pay for one. A failed load
// is retried by the next request rather than remembered.
const loads = new Map<string, Promise<StructuredModel | ProseCoder>>();
function load<T extends StructuredModel | ProseCoder>(file: string, parse: (bytes: Buffer) => T): Promise<T> {
  let loading = loads.get(file);
  if (!loading) {
    loading = readFile(new URL(file, MODEL_DIR)).then(parse);
    loads.set(file, loading);
    loading.catch(() => { loads.delete(file); });
  }
  return loading as Promise<T>;
}

// A prose coder that can also say how many model steps encoding a doc took.
export type NativeProseCoder = ProseCoder & {
  encodeCounted(doc: Parameters<ProseCoder["encode"]>[0]): Promise<{ bytes: Uint8Array; steps: number }>;
};

// The native prose model as the protocol's coder. Encoding runs off the event loop.
export function proseCoder(bytes: Buffer): NativeProseCoder {
  const model = new AvalancheModel(bytes);
  const encodeCounted = async (doc: Parameters<ProseCoder["encode"]>[0]) => {
    const out = await model.encode(doc);
    return { bytes: new Uint8Array(out.bytes), steps: out.steps };
  };
  return {
    encodeCounted,
    encode: async (doc) => (await encodeCounted(doc)).bytes,
    decode: (bytes, layout) => model.decode(Buffer.from(bytes), layout),
  };
}

async function avalancheModels(file: string): Promise<{ structured: StructuredModel; prose: NativeProseCoder }> {
  const [structured, prose] = await Promise.all([
    load(file, (bytes) => loadStructured(gunzipSync(bytes))),
    load(PROSE_MODEL_FILE, proseCoder),
  ]);
  return { structured, prose };
}

export type AvalancheResult =
  // `encodeSteps` is the prose model's work: the tokens it was fed.
  | { kind: "ok"; replies: string[]; fetchMs: number; encodeMs: number; encodeSteps: number }
  | { kind: "no_forecast" };

// The forecast covering the request's point, or null when no center forecasts there then.
async function fetchForecast(params: ForecastParams, at: number | null): Promise<AvalancheForecast | null> {
  const piece = pieceAt(params.lat!, params.lon!);
  const center = piece && NAC_CENTERS[piece.center];
  if (piece && center) {
    const product = await fetchZoneProduct(piece, params.day ?? null);
    return product && toNacForecast(product, center, piece);
  }
  const product = await fetchPointProduct(params.lat!, params.lon!, at);
  return product && toForecast(product, await fetchAreaPieces(product, at));
}

export async function serveAvalanche(params: ForecastParams): Promise<AvalancheResult> {
  const anchor = avalancheAnchor(params.day, params.startEpochHour);
  const at = params.day ? anchor : null;
  const fetchStart = Date.now();
  const [forecast, m] = await Promise.all([
    fetchForecast(params, at), avalancheModels(avalancheModelFile(params.lat!, params.lon!)),
  ]);
  if (!forecast) return { kind: "no_forecast" };
  const fetchMs = Date.now() - fetchStart;

  const encodeStart = Date.now();
  let encodeSteps = 0;
  const prose: ProseCoder = {
    decode: m.prose.decode,
    encode: async (doc) => {
      const out = await m.prose.encodeCounted(doc);
      encodeSteps += out.steps;
      return out.bytes;
    },
  };
  const models: Models = { structured: m.structured, prose };
  const encoded = await encodeAvalancheMessage(models, params.code, anchor, forecast, params.alphabet);
  const replies = splitReplyFor(params, encoded, WIRE_HEADER_CHARS);
  if (replies.length > MAX_PARTS) throw new Error(`avalanche: bulletin for ${forecast.region} needs ${replies.length} parts`);
  return { kind: "ok", replies, fetchMs, encodeMs: Date.now() - encodeStart, encodeSteps };
}
