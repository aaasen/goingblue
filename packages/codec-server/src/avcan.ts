/**
 * Avalanche Canada bulletins: fetching the product for a point and the pieces its area covers,
 * and mapping a product onto the app's AvalancheForecast. The feed's enumerations map onto the protocol's scales, every HTML
 * field is reduced to text, and the weather summary is split into its per-period headings.
 * Unknown enumeration values throw rather than pass through, so an unmapped product fails
 * loudly instead of reaching a reader.
 */
import {
  ASPECTS, ELEVATIONS, piecesInArea,
  type Aspect, type AvalancheForecast, type AvalancheProblem, type Confidence, type DangerRating,
  type Elevation, type Likelihood, type ProblemType, type WeatherPeriod,
} from "@weather/protocol";
import { htmlToText } from "./html-text.js";

export interface RawProduct {
  id: string;
  area: { id: string };
  owner: { value: string; display: string };
  report: {
    title: string;
    forecaster?: string | null;
    dateIssued: string;
    validUntil: string;
    timezone?: string | null;
    highlights?: string | null;
    confidence?: { rating?: { value: string } | null; statements?: string[] | null } | null;
    summaries?: { type: { value: string }; content: string | null }[];
    dangerRatings?: { date: { value: string }; ratings: Record<string, { rating: { value: string } }> }[];
    problems?: {
      type: { value: string };
      comment?: string | null;
      data?: {
        elevations?: { value: string }[];
        aspects?: { value: string }[];
        likelihood?: { value: string } | null;
        expectedSize?: { min: string; max: string } | null;
      } | null;
    }[];
    terrainAndTravelAdvice?: string[] | null;
  };
}

const RATINGS: Record<string, DangerRating> = {
  low: "low", moderate: "moderate", considerable: "considerable", high: "high", extreme: "extreme",
  norating: "noRating", spring: "spring", earlyseason: "earlySeason", offseason: "offSeason", noforecast: "noForecast",
};

const LIKELIHOODS: Record<string, Likelihood> = {
  unlikely: "unlikely", possible_unlikely: "unlikely-possible", possible: "possible",
  likely_possible: "possible-likely", likely: "likely", veryLikely_likely: "likely-veryLikely",
  veryLikely: "veryLikely", certain_veryLikely: "veryLikely-certain", certain: "certain",
};

const TYPES: Record<string, ProblemType> = {
  stormslab: "stormSlab", windslab: "windSlab", persistentslab: "persistentSlab",
  deeppersistentslab: "deepPersistentSlab", wetslab: "wetSlab", wetloose: "wetLoose",
  dryloose: "dryLoose", cornice: "cornice", glide: "glide",
};

const CONFIDENCES: Record<string, Confidence | "noRating"> = {
  low: "low", moderate: "moderate", high: "high", noRating: "noRating",
};

function lookup<T>(table: Record<string, T>, value: string | undefined, what: string): T {
  const v = value === undefined ? undefined : table[value];
  if (v === undefined) throw new Error(`unknown ${what}: ${JSON.stringify(value)}`);
  return v;
}

function member<T extends string>(scale: readonly T[], value: string, what: string): T {
  if (!(scale as readonly string[]).includes(value)) throw new Error(`unknown ${what}: ${JSON.stringify(value)}`);
  return value as T;
}

// The instant's calendar date in `tz` and the ms of that date's midnight there. The clock read
// off Intl gives the local date; the offset is then measured at the midnight guess itself, so a
// DST change between midnight and the instant does not skew it.
export function dayStart(ms: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const clock = (t: number): number[] => {
    const parts = fmt.formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return [get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")];
  };
  const [y, m, d] = clock(ms);
  const midnight = Date.UTC(y, m, d);
  const asUtc = (t: number) => { const c = clock(t); return Date.UTC(c[0], c[1], c[2], c[3], c[4], c[5]); };
  let guess = midnight - (asUtc(midnight) - midnight);
  guess -= asUtc(guess) - midnight;
  return guess;
}

const BOILERPLATE = /^More details can be found in the .*Weather Forecast\.?$/i;
// A paragraph that is nothing but a link: the link is gone from the text, so nothing is left.
const LONE_LINK = /^\s*<a\b[^>]*>[\s\S]*?<\/a>\s*\.?\s*$/i;

// Periods are the summary's bold headings. Each <p> body and each run of two or more <br>s
// starts a unit; a unit opening with a heading starts a period, and any other unit joins the
// period before it (or opens an unlabeled one when nothing precedes it).
export function weatherPeriods(html: string | null | undefined): WeatherPeriod[] {
  if (!html) return [];
  const units = html
    .split(/<\/\s*p\s*>|(?:<\s*br\s*\/?>\s*){2,}/i)
    .map((u) => u.replace(/<\s*p\b[^>]*>/gi, ""));
  const out: WeatherPeriod[] = [];
  for (const u of units) {
    if (LONE_LINK.test(u)) continue;
    const text = htmlToText(u);
    if (!text || BOILERPLATE.test(text)) continue;
    const m = /^\s*<strong>([\s\S]*?)<\/strong>([\s\S]*)$/i.exec(u);
    if (m) {
      out.push({ label: htmlToText(m[1]).replace(/:$/, "").trim(), text: htmlToText(m[2]) });
    } else if (out.length) {
      const last = out[out.length - 1];
      last.text = last.text ? `${last.text}\n\n${text}` : text;
    } else {
      out.push({ label: "", text });
    }
  }
  return out.filter((p) => p.text);
}

function problem(p: NonNullable<RawProduct["report"]["problems"]>[number]): AvalancheProblem {
  const d = p.data ?? {};
  const byScale = <T extends string>(scale: readonly T[], values: string[], what: string): T[] =>
    values.map((v) => member(scale, v, what)).sort((a, b) => scale.indexOf(a) - scale.indexOf(b));
  return {
    type: lookup(TYPES, p.type.value, "problem type"),
    elevations: byScale<Elevation>(ELEVATIONS, (d.elevations ?? []).map((e) => e.value), "elevation"),
    aspects: byScale<Aspect>(ASPECTS, (d.aspects ?? []).map((a) => a.value), "aspect"),
    likelihood: lookup(LIKELIHOODS, d.likelihood?.value, "likelihood"),
    size: { min: Number(d.expectedSize?.min), max: Number(d.expectedSize?.max) },
    description: htmlToText(p.comment),
  };
}

const RATED = new Set(["low", "moderate", "considerable", "high", "extreme"]);

// A bulletin with a real danger rating somewhere. Off-season placeholders and "no rating"
// regions carry boilerplate, not forecasts, and are excluded from the corpus.
export function isForecast(p: RawProduct): boolean {
  return (p.report.dangerRatings ?? []).some((d) =>
    Object.values(d.ratings ?? {}).some((r) => RATED.has(r.rating?.value)),
  );
}

// `pieces` is what the product's area covers (fetchAreaPieces).
export function toForecast(raw: RawProduct, pieces: number[]): AvalancheForecast {
  const r = raw.report;
  const tz = r.timezone ?? "UTC";
  const summary = (kind: string) => htmlToText(r.summaries?.find((s) => s.type.value === kind)?.content);
  return {
    center: raw.owner.value,
    issuedBy: r.forecaster ?? raw.owner.display,
    region: r.title,
    pieces,
    issued: Date.parse(r.dateIssued),
    expires: Date.parse(r.validUntil),
    timezone: tz,
    bottomLine: htmlToText(r.highlights),
    danger: (r.dangerRatings ?? []).map((d) => ({
      date: dayStart(Date.parse(d.date.value), tz),
      btl: lookup(RATINGS, d.ratings.btl?.rating.value, "danger rating"),
      tln: lookup(RATINGS, d.ratings.tln?.rating.value, "danger rating"),
      alp: lookup(RATINGS, d.ratings.alp?.rating.value, "danger rating"),
    })),
    advice: (r.terrainAndTravelAdvice ?? []).map(htmlToText),
    problems: (r.problems ?? []).map(problem),
    avalancheSummary: summary("avalanche-summary"),
    snowpackSummary: summary("snowpack-summary"),
    weather: weatherPeriods(r.summaries?.find((s) => s.type.value === "weather-summary")?.content),
    confidence: {
      rating: lookup(CONFIDENCES, r.confidence?.rating?.value ?? "noRating", "confidence"),
      statements: r.confidence?.statements ?? [],
    },
  };
}

// Overridable so tests can replay recorded responses.
const API = process.env["AVCAN_BASE_URL"] ?? "https://api.avalanche.ca";
// Inside the gateway's 15 s budget for the whole codec call. An archive query the API has not
// cached takes about 7 s; the gateway retries a timeout, by which time the API has it cached.
const FETCH_TIMEOUT_MS = 10_000;

// The product covering a point at an instant, or null when no center forecasts there then. The
// API answers both of those with an empty product rather than an error. Without an instant it
// answers with the product current now.
export async function fetchPointProduct(lat: number, lon: number, at: number | null): Promise<RawProduct | null> {
  const url = new URL("/forecasts/en/products/point", API);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("long", String(lon));
  if (at !== null) url.searchParams.set("date", new Date(at).toISOString());
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`avcan: HTTP ${res.status}`);
  const product = (await res.json()) as RawProduct | null;
  return product && product.id ? product : null;
}

// Area ids are hashes of the area, so what an id covers never changes.
const areaPieces = new Map<string, number[]>();

// The pieces a product's area covers. On a miss, fetches every area in force at the product's
// instant (`at` as passed to fetchPointProduct) and remembers them all.
export async function fetchAreaPieces(product: RawProduct, at: number | null): Promise<number[]> {
  const key = `${product.area.id}|${product.owner.value}`;
  const known = areaPieces.get(key);
  if (known) return known;
  const url = new URL("/forecasts/en/areas", API);
  if (at !== null) url.searchParams.set("date", new Date(at).toISOString());
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`avcan areas: HTTP ${res.status}`);
  const body = (await res.json()) as { features: { id: string; geometry: { type: string; coordinates: unknown } }[] };
  const feature = body.features.find((f) => f.id === product.area.id);
  if (!feature) throw new Error(`avcan areas: no area ${product.area.id}`);
  const pieces = piecesInArea(feature.geometry, product.owner.value);
  areaPieces.set(key, pieces);
  return pieces;
}
