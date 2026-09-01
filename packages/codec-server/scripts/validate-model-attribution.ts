/**
 * Validates src/model-attribution.ts against the live Open-Meteo forecast API.
 *
 * For a set of corpus locations chosen to hit every best_match cascade branch, fetches
 * best_match PLUS each predicted candidate model in a single request (same target elevation and
 * grid selection for all readers, so component values match best_match exactly), then per hour:
 *
 *  - ground truth = the first candidate (in predicted priority order) whose temperature matches
 *    best_match to output precision; ties broken by humidity/wind/cloud among the tied models
 *    (best_match mixes PER VARIABLE, so matching is anchored on one variable, not joint).
 *  - compares against the predicted attribution, tolerating transition drift up to the model's
 *    full-run cadence (run age is not observable) and the 3-hour seam blend, where best_match
 *    values are a weighted mix that matches no single model by construction.
 *
 * Run: node packages/codec-server/scripts/validate-model-attribution.ts
 * ~60 API call-units against the free tier per run.
 */
import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./corpus-db.ts";
import {
  attributeHour,
  predictCenter,
  type Center,
  type ModelSpec,
} from "@weather/protocol";

const EPS = 0.051; // values are rounded to 0.1 (or integers); exact equality expected, allow last-digit noise
const TIE_BREAK_VARS = ["relative_humidity_2m", "wind_speed_10m", "cloud_cover"] as const;
const VARS = ["temperature_2m", ...TIE_BREAK_VARS] as const;

// best_match: one location per cascade branch (favorites/eval where available, else stratified
// samples). Center stacks (US/CA/DE): the composite seamless model is fetched as ground truth and
// its components as candidates; EU is a single model, so there is nothing to attribute.
const POINTS: Array<{ id: string; center: Center; composite: string; expectBranch: string }> = [
  { id: "s-cfb-0017", center: "best", composite: "best_match", expectBranch: "netherlands-knmi" },
  { id: "lom", center: "best", composite: "best_match", expectBranch: "nordic-metno" },
  { id: "s-cfb-0007", center: "best", composite: "best_match", expectBranch: "uk-ukmo" },
  { id: "chamonix", center: "best", composite: "best_match", expectBranch: "central-europe-icon-d2" },
  { id: "s-cfb-0075", center: "best", composite: "best_match", expectBranch: "france-arome" },
  { id: "s-cfc-0022", center: "best", composite: "best_match", expectBranch: "northern-europe-dmi" },
  { id: "liberty-bell-mountain", center: "best", composite: "best_match", expectBranch: "conus-hrrr" },
  { id: "s-cfa-0018", center: "best", composite: "best_match", expectBranch: "japan-jma-msm" },
  // DMI's Lambert grid reaches Romania, and the live API confirms best_match serves DMI there,
  // so the true ICON-EU branch needs a point south of the DMI branch's lat >= 44 gate.
  { id: "s-dfa-0105", center: "best", composite: "best_match", expectBranch: "northern-europe-dmi" },
  { id: "s-bsk-0005", center: "best", composite: "best_match", expectBranch: "europe-icon-eu" },
  { id: "denali", center: "best", composite: "best_match", expectBranch: "global-fallback" },
  { id: "el-chalten", center: "best", composite: "best_match", expectBranch: "global-fallback" },
  { id: "liberty-bell-mountain", center: "us", composite: "gfs_seamless", expectBranch: "us-gfs-seamless" },
  { id: "denali", center: "us", composite: "gfs_seamless", expectBranch: "us-gfs-seamless" },
  { id: "rogers-pass", center: "ca", composite: "gem_seamless", expectBranch: "ca-gem-seamless" },
  { id: "denali", center: "ca", composite: "gem_seamless", expectBranch: "ca-gem-seamless" },
  { id: "chamonix", center: "de", composite: "icon_seamless", expectBranch: "de-icon-seamless" },
  { id: "denali", center: "de", composite: "icon_seamless", expectBranch: "de-icon-seamless" },
];

interface Hourly {
  time: number[];
  [key: string]: number[] | (number | null)[];
}

async function fetchModels(lat: number, lon: number, models: string[]): Promise<Hourly> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=${VARS.join(",")}&models=${models.join(",")}` +
    `&forecast_days=16&timeformat=unixtime`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const body = (await res.json()) as { hourly: Hourly };
    return body.hourly;
  }
}

const col = (h: Hourly, variable: string, model: string): (number | null)[] | undefined =>
  (h[`${variable}_${model}`] as (number | null)[] | undefined) ??
  // single-model responses (not used here) carry no suffix
  undefined;

const eq = (a: number | null | undefined, b: number | null | undefined): boolean =>
  a != null && b != null && Math.abs(a - b) <= EPS;

/** Ground-truth serving models at hour i: candidates matching the composite model, tie-broken. */
function actualModelsAt(h: Hourly, composite: string, candidates: string[], i: number): string[] | null {
  const bmT = col(h, "temperature_2m", composite)?.[i];
  if (bmT == null) return null; // the composite itself has no data (past every horizon)
  let tied = candidates.filter((m) => eq(col(h, "temperature_2m", m)?.[i], bmT));
  for (const v of TIE_BREAK_VARS) {
    if (tied.length <= 1) break;
    const bmV = col(h, v, composite)?.[i];
    if (bmV == null) continue;
    // a candidate missing this variable is "no evidence", not a mismatch — best_match mixes per
    // variable, so e.g. AROME HD can serve temperature while lacking the tie-break variable
    const narrowed = tied.filter((m) => {
      const mv = col(h, v, m)?.[i];
      return mv == null || eq(mv, bmV);
    });
    if (narrowed.length > 0) tied = narrowed;
  }
  return tied;
}

/** Compress an hour→label array into "0–47 label" segments for printing. */
function segments(labels: (string | null)[]): string {
  const out: string[] = [];
  let start = 0;
  for (let i = 1; i <= labels.length; i++) {
    if (i === labels.length || labels[i] !== labels[start]) {
      out.push(`${start}–${i - 1} ${labels[start] ?? "∅"}`);
      start = i;
    }
  }
  return out.join(" | ");
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const locStmt = db.prepare("SELECT id, name, lat, lon FROM locations WHERE id = ?");

const nowMs = Date.now();
const totals = { exact: 0, drift: 0, blend: 0, ambiguous: 0, mismatch: 0, nodata: 0 };
let branchFailures = 0;

for (const point of POINTS) {
  const loc = locStmt.get(point.id) as { id: string; name: string; lat: number; lon: number } | undefined;
  if (!loc) {
    console.error(`corpus location ${point.id} not found`);
    continue;
  }
  const prediction = predictCenter(point.center, loc.lat, loc.lon);
  const branchOk = prediction.branch === point.expectBranch;
  if (!branchOk) branchFailures++;

  const candidateIds = prediction.models.map((m) => m.id);
  let hourly: Hourly;
  try {
    hourly = await fetchModels(loc.lat, loc.lon, [point.composite, ...candidateIds]);
  } catch (err) {
    console.error(`${loc.id}: fetch failed: ${(err as Error).message}`);
    continue;
  }

  const hours = hourly.time as number[];
  const predicted: (ModelSpec | null)[] = [];
  const predictedIds: (string | null)[] = [];
  const actualIds: (string | null)[] = [];
  const stats = { exact: 0, drift: 0, blend: 0, ambiguous: 0, mismatch: 0, nodata: 0 };
  const mismatches: string[] = [];
  let lastActual: string | null = null;
  let lastChangeAt = -99;

  for (let i = 0; i < hours.length; i++) {
    const tMs = hours[i] * 1000;
    const pred = attributeHour(prediction.models, tMs, nowMs);
    predicted.push(pred.model);
    predictedIds.push(pred.model?.id ?? null);

    const actual = actualModelsAt(hourly, point.composite, candidateIds, i);
    const actualTop = actual && actual.length > 0 ? actual[0] : null;
    actualIds.push(actualTop);
    if (actualTop !== lastActual) {
      lastChangeAt = i;
      lastActual = actualTop;
    }

    if (actual === null) {
      stats.nodata++;
      continue;
    }
    if (actual.length === 0) {
      // no single model matches: expected right after a transition (3-step seam blend)
      if (i - lastChangeAt < 4 || (i + 3 < hours.length && actualModelsAt(hourly, point.composite, candidateIds, i + 3)?.length)) {
        stats.blend++;
      } else {
        stats.mismatch++;
        if (mismatches.length < 5) mismatches.push(`h${i}: no candidate matches best_match`);
      }
      continue;
    }
    const predictedId = pred.model?.id ?? null;
    if (predictedId && actual.includes(predictedId)) {
      if (actual.length > 1) stats.ambiguous++;
      else stats.exact++;
      continue;
    }
    // transition drift: does the prediction for t ± the model's run cadence match?
    const tolMs = (pred.toleranceHours + 1) * 3600_000;
    const shifted = [
      attributeHour(prediction.models, tMs - tolMs, nowMs).model?.id,
      attributeHour(prediction.models, tMs + tolMs, nowMs).model?.id,
    ];
    if (shifted.some((id) => id && actual.includes(id))) {
      stats.drift++;
      continue;
    }
    stats.mismatch++;
    if (mismatches.length < 5) {
      mismatches.push(`h${i}: predicted ${predictedId ?? "∅"}, matched [${actual.join(", ")}]`);
    }
  }

  for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += stats[k];

  console.log(`\n${loc.name} (${loc.id}) ${loc.lat},${loc.lon} [${point.center}]`);
  console.log(`  branch: ${prediction.branch}${branchOk ? "" : ` EXPECTED ${point.expectBranch} ✗`}`);
  console.log(`  priority: ${candidateIds.join(" > ")}`);
  console.log(`  predicted: ${segments(predictedIds)}`);
  console.log(`  actual:    ${segments(actualIds)}`);
  const scored = hours.length - stats.nodata;
  const ok = stats.exact + stats.ambiguous + stats.drift + stats.blend;
  console.log(
    `  hours: ${ok}/${scored} consistent ` +
      `(exact ${stats.exact}, ambiguous ${stats.ambiguous}, drift ${stats.drift}, ` +
      `blend ${stats.blend}, MISMATCH ${stats.mismatch}, no-data ${stats.nodata})`,
  );
  for (const m of mismatches) console.log(`    ✗ ${m}`);
  await new Promise((r) => setTimeout(r, 500));
}

const scored = totals.exact + totals.ambiguous + totals.drift + totals.blend + totals.mismatch;
console.log(
  `\nTOTAL: ${scored - totals.mismatch}/${scored} consistent — ` +
    `exact ${totals.exact}, ambiguous ${totals.ambiguous}, drift ${totals.drift}, ` +
    `blend ${totals.blend}, mismatch ${totals.mismatch}, branch failures ${branchFailures}`,
);
