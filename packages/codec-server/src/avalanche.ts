// Avalanche requests (`f:a`): fetch the bulletin covering the request's point from the center that
// forecasts there, encode it whole under that center's model, and split it over as many messages as it takes. Unlike a weather
// reply, which fills the budget the reader chose, a bulletin is never cut to fit: a partial
// bulletin could leave out the one problem or advice line that matters.
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  avalancheAnchor, avalancheModelFile, encodeAvalancheMessage, loadModels, pieceAt, WIRE_HEADER_CHARS,
  type AvalancheForecast, type Models,
} from "@weather/protocol";
import { fetchAreaPieces, fetchPointProduct, toForecast } from "./avcan.js";
import { splitReplyFor, type ForecastParams } from "./forecast.js";
import { fetchZoneProduct, NWAC_CENTER, toForecast as toNacForecast } from "./nac.js";

// Part labels ("i/N ") are budgeted at two digits each side at most.
const MAX_PARTS = 99;

// The models ship in the protocol package, beside this one in the workspace and in the image
// (Dockerfile.codec copies both); src/ and dist/ sit at the same depth.
const MODEL_DIR = new URL("../../protocol/assets/", import.meta.url);

// Each is loaded on its first request, so weather-only instances never pay for one. A failed load
// is retried by the next request rather than remembered.
const models = new Map<string, Promise<Models>>();
function avalancheModels(file: string): Promise<Models> {
  let loading = models.get(file);
  if (!loading) {
    loading = readFile(new URL(file, MODEL_DIR)).then((bytes) => loadModels(gunzipSync(bytes)));
    models.set(file, loading);
    loading.catch(() => { models.delete(file); });
  }
  return loading;
}

export type AvalancheResult =
  | { kind: "ok"; replies: string[]; fetchMs: number; encodeMs: number }
  | { kind: "no_forecast" };

// The forecast covering the request's point, or null when no center forecasts there then.
async function fetchForecast(params: ForecastParams, at: number | null): Promise<AvalancheForecast | null> {
  const piece = pieceAt(params.lat!, params.lon!);
  if (piece?.center === NWAC_CENTER) {
    const product = await fetchZoneProduct(piece, params.day ?? null);
    return product && toNacForecast(product, piece);
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
  const encoded = encodeAvalancheMessage(m, params.code, anchor, forecast, params.alphabet);
  const replies = splitReplyFor(params, encoded, WIRE_HEADER_CHARS);
  if (replies.length > MAX_PARTS) throw new Error(`avalanche: bulletin for ${forecast.region} needs ${replies.length} parts`);
  return { kind: "ok", replies, fetchMs, encodeMs: Date.now() - encodeStart };
}
