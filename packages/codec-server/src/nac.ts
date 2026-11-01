/**
 * National Avalanche Center (avalanche.org) forecasts: fetching a zone's product and mapping it onto
 * the app's AvalancheForecast. Unknown enumeration values throw rather than pass through, so an
 * unmapped product fails loudly instead of reaching a reader.
 *
 * A `summary` is what a center publishes outside its forecast season: prose with no danger and no
 * problems, which maps onto a forecast with neither.
 */
import {
  ASPECTS, ELEVATIONS, avalancheAnchor,
  type Aspect, type AvalancheForecast, type AvalancheProblem, type AvalanchePiece, type DangerDay,
  type DangerRating, type Elevation, type Likelihood, type ProblemType,
} from "@weather/protocol";
import { htmlToText } from "./html-text.js";

export interface NacProduct {
  id: number;
  product_type: string;
  published_time: string;
  expires_time: string;
  updated_at: string | null;
  author?: string | null;
  bottom_line?: string | null;
  hazard_discussion?: string | null;
  forecast_zone?: { id: number; name: string }[];
  danger?: { valid_day: string; upper: number | null; middle: number | null; lower: number | null }[];
  forecast_avalanche_problems?: {
    name: string;
    rank: number;
    likelihood: string;
    size: string[];
    location: string[] | null;
    discussion?: string | null;
  }[];
}

export const NWAC_CENTER = "nwac";
const NWAC_ID = "NWAC";
const NWAC_NAME = "Northwest Avalanche Center";
const NWAC_TIMEZONE = "America/Los_Angeles";

// The API's id for each zone, by the name its piece carries.
export const NWAC_ZONE_IDS: Record<string, number> = {
  "East Slopes Central": 3030, "East Slopes North": 3029, "East Slopes South": 3031, "Mt Hood": 3032,
  "Olympics": 3020, "Snoqualmie Pass": 3028, "Stevens Pass": 3024, "West Slopes Central": 3022,
  "West Slopes North": 3021, "West Slopes South": 3023,
};

const TYPES: Record<string, ProblemType> = {
  "Storm Slab": "stormSlab", "Wind Slab": "windSlab", "Persistent Slab": "persistentSlab",
  "Deep Persistent Slab": "deepPersistentSlab", "Wet Slab": "wetSlab", "Wet Loose": "wetLoose",
  "Dry Loose": "dryLoose", "Cornice Fall": "cornice", "Glide": "glide", "Glide Avalanches": "glide",
};

const LIKELIHOODS: Record<string, Likelihood> = {
  unlikely: "unlikely", possible: "possible", likely: "likely", "very likely": "veryLikely",
  "almost certain": "veryLikely-certain", certain: "certain",
};

const RATINGS: Record<number, DangerRating> = {
  [-1]: "noRating", 0: "noRating", 1: "low", 2: "moderate", 3: "considerable", 4: "high", 5: "extreme",
};

const ASPECT_NAMES: Record<string, Aspect> = {
  north: "n", northeast: "ne", east: "e", southeast: "se", south: "s", southwest: "sw", west: "w", northwest: "nw",
};

const ELEVATION_NAMES: Record<string, Elevation> = { upper: "alp", middle: "tln", lower: "btl" };

function lookup<T>(table: Record<string, T>, value: string | undefined, what: string): T {
  const v = value === undefined ? undefined : table[value];
  if (v === undefined) throw new Error(`unknown ${what}: ${JSON.stringify(value)}`);
  return v;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);

// The day a product applies to, as the center's site dates it: one published at or after local noon
// is for the following day.
export function validDate(publishedTime: string, timezone: string = NWAC_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(publishedTime));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  const local = `${part("year")}-${part("month")}-${part("day")}`;
  return Number(part("hour")) >= 12 ? addDays(local, 1) : local;
}

function rating(value: number | null): DangerRating {
  return value === null ? "noRating" : lookup(RATINGS, String(value), "danger rating");
}

function danger(p: NacProduct): DangerDay[] {
  const offsets: Record<string, number> = { current: 0, tomorrow: 1 };
  const first = validDate(p.published_time);
  return (p.danger ?? [])
    .map((d) => ({ offset: lookup(offsets, d.valid_day, "valid day"), d }))
    .sort((a, b) => a.offset - b.offset)
    .map(({ offset, d }) => ({
      date: addDays(first, offset), btl: rating(d.lower), tln: rating(d.middle), alp: rating(d.upper),
    }));
}

// The location is a set of aspect and band cells. When they are every combination of the aspects and
// bands they touch, those two lists say it all.
function location(names: string[] | null): Pick<AvalancheProblem, "elevations" | "aspects" | "cells"> {
  const cells = (names ?? []).map((name) => {
    const [aspect, elevation] = name.split(" ");
    return { aspect: lookup(ASPECT_NAMES, aspect, "aspect"), elevation: lookup(ELEVATION_NAMES, elevation, "elevation") };
  });
  const elevations = ELEVATIONS.filter((e) => cells.some((c) => c.elevation === e));
  const aspects = ASPECTS.filter((a) => cells.some((c) => c.aspect === a));
  if (new Set(names).size === elevations.length * aspects.length) return { elevations, aspects };
  const ordered = elevations.flatMap((elevation) =>
    aspects.filter((aspect) => cells.some((c) => c.aspect === aspect && c.elevation === elevation)).map((aspect) => ({ aspect, elevation })));
  return { elevations, aspects, cells: ordered };
}

type NacProblem = NonNullable<NacProduct["forecast_avalanche_problems"]>[number];

function problem(p: NacProblem): AvalancheProblem {
  const sizes = p.size.map(Number).sort((a, b) => a - b);
  return {
    type: lookup(TYPES, p.name, "problem type"),
    ...location(p.location),
    likelihood: lookup(LIKELIHOODS, p.likelihood, "likelihood"),
    size: { min: sizes[0], max: sizes[sizes.length - 1] },
    description: htmlToText(p.discussion),
  };
}

// A forecast with a real danger rating somewhere, the training corpus's rule.
export function isRated(p: NacProduct): boolean {
  return (p.danger ?? []).some((d) => [d.upper, d.middle, d.lower].some((v) => v !== null && v >= 1));
}

export function toForecast(p: NacProduct, piece: Pick<AvalanchePiece, "id" | "names">): AvalancheForecast {
  return {
    center: NWAC_CENTER,
    issuedBy: p.author ?? NWAC_NAME,
    region: piece.names[0],
    pieces: [piece.id],
    issued: Date.parse(p.published_time),
    expires: Date.parse(p.expires_time),
    timezone: NWAC_TIMEZONE,
    bottomLine: htmlToText(p.bottom_line),
    danger: danger(p),
    advice: [],
    problems: [...(p.forecast_avalanche_problems ?? [])].sort((a, b) => a.rank - b.rank).map(problem),
    avalancheSummary: "",
    snowpackSummary: "",
    hazardDiscussion: htmlToText(p.hazard_discussion),
    weather: [],
    confidence: { rating: "noRating", statements: [] },
  };
}

// Overridable so tests can replay recorded responses.
const API = process.env["NAC_BASE_URL"] ?? "https://api.avalanche.org";
// Inside the gateway's 20 s budget for the whole codec call.
const FETCH_TIMEOUT_MS = 15_000;
const SERVED_TYPES = new Set(["forecast", "summary"]);
// How far before the requested day the reply's header can place a product's issue time.
const MAX_DAYS_BACK = 339;

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(new URL(path, API), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`nac: HTTP ${res.status}`);
  return res.json();
}

// The latest product for a zone. The API answers an empty object of nulls when there is none, and a
// null updated_at marks a stub that holds no forecast.
async function latestProduct(zoneId: number): Promise<NacProduct | null> {
  const product = await getJson(`/v2/public/product?type=forecast&center_id=${NWAC_ID}&zone_id=${zoneId}`) as NacProduct;
  if (product.updated_at === null || product.id === undefined) return null;
  if (!SERVED_TYPES.has(product.product_type)) throw new Error(`nac: unexpected product type ${product.product_type}`);
  return product;
}

// A zone's served products published from `from` up to but not including `until`, latest first, from
// the listing, whose rows leave out the prose. The listing filters on UTC publish dates.
async function listProducts(zoneId: number, from: string, until: string): Promise<NacProduct[]> {
  const rows = await getJson(
    `/v2/public/products?avalanche_center_id=${NWAC_ID}&date_start=${from}&date_end=${until}`,
  ) as (NacProduct & { forecast_zone: { id: number }[] })[];
  return rows
    .filter((r) => SERVED_TYPES.has(r.product_type) && r.updated_at !== null && r.forecast_zone.some((z) => z.id === zoneId))
    .sort((a, b) => b.published_time.localeCompare(a.published_time));
}

// The product a zone's forecast for `day` ("YYYY-MM-DD") shows: the latest published for that day, or
// else what was still in force that day, such as a summary published weeks before. The API has no
// dated lookup, so this finds it in the listing and fetches it by id.
async function datedProduct(zoneId: number, day: string): Promise<NacProduct | null> {
  const near = await listProducts(zoneId, addDays(day, -1), addDays(day, 1));
  let found = near.find((p) => validDate(p.published_time) === day);
  if (!found) {
    const at = avalancheAnchor(day, 0);
    const back = await listProducts(zoneId, addDays(day, -MAX_DAYS_BACK), addDays(day, 1));
    found = back.find((p) => Date.parse(p.published_time) <= at && at < Date.parse(p.expires_time));
  }
  return found ? await getJson(`/v2/public/product/${found.id}`) as NacProduct : null;
}

// The product for a piece's zone on `day`, or the latest when `day` is null. Null when there is none.
export function fetchZoneProduct(piece: Pick<AvalanchePiece, "names">, day: string | null): Promise<NacProduct | null> {
  const zoneId = lookup(NWAC_ZONE_IDS, piece.names[0], "zone");
  return day ? datedProduct(zoneId, day) : latestProduct(zoneId);
}
