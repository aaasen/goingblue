// Avalanche requests (`f:a`): fetch the bulletin covering the request's point from Avalanche
// Canada with the pieces its area covers, encode it whole, and split it over as many messages as it takes. Unlike a weather
// reply, which fills the budget the reader chose, a bulletin is never cut to fit: a partial
// bulletin could leave out the one problem or advice line that matters.
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { avalancheAnchor, encodeAvalancheMessage, loadModels, WIRE_HEADER_CHARS, type Models } from "@weather/protocol";
import { fetchAreaPieces, fetchPointProduct, toForecast } from "./avcan.js";
import { splitReplyFor, type ForecastParams } from "./forecast.js";

// Part labels ("i/N ") are budgeted at one digit each side.
const MAX_PARTS = 9;

// The model ships in the protocol package, beside this one in the workspace and in the image
// (Dockerfile.codec copies both); src/ and dist/ sit at the same depth.
const MODEL_URL = new URL("../../protocol/assets/avcan-model.bin.gz", import.meta.url);

// Loaded on the first avalanche request, so weather-only instances never pay for it. A failed
// load is retried by the next request rather than remembered.
let models: Promise<Models> | null = null;
function avalancheModels(): Promise<Models> {
  models ??= readFile(MODEL_URL).then((file) => loadModels(gunzipSync(file)));
  models.catch(() => { models = null; });
  return models;
}

export type AvalancheResult =
  | { kind: "ok"; replies: string[]; fetchMs: number; encodeMs: number }
  | { kind: "no_forecast" };

export async function serveAvalanche(params: ForecastParams): Promise<AvalancheResult> {
  const anchor = avalancheAnchor(params.day, params.startEpochHour);
  const at = params.day ? anchor : null;
  const fetchStart = Date.now();
  const [product, m] = await Promise.all([fetchPointProduct(params.lat!, params.lon!, at), avalancheModels()]);
  if (!product) return { kind: "no_forecast" };
  const pieces = await fetchAreaPieces(product, at);
  const fetchMs = Date.now() - fetchStart;

  const encodeStart = Date.now();
  const encoded = encodeAvalancheMessage(m, params.code, anchor, toForecast(product, pieces), params.alphabet);
  const replies = splitReplyFor(params, encoded, WIRE_HEADER_CHARS);
  if (replies.length > MAX_PARTS) throw new Error(`avalanche: bulletin ${product.id} needs ${replies.length} parts`);
  return { kind: "ok", replies, fetchMs, encodeMs: Date.now() - encodeStart };
}
