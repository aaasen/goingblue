import type { Context } from "hono";
import { DAY_TZ, query } from "../db.js";
import { PAGE } from "./shell.js";
import { log } from "../log.js";
import { vendorUrl } from "../vendor.js";
import { basemapStyle, MIN_ZOOM, MAX_ZOOM } from "./basemap-style.js";

// GET /stats — the forecast usage dashboard, behind basic auth (wired in index.ts, which only
// registers the route when STATS_PASS is set). It reads `requests`, which has held one row per
// served forecast since launch and is therefore the authoritative usage record: Cloud Run's
// logs expire after 30 days, and log-based metrics only start counting the day you create them.
//
// The page is rendered server-side as inline SVG plus a table — no chart library, and the charts
// make no external requests, matching every other page here. The one exception is the location
// map, which runs MapLibre GL JS against the app's own basemap archives on R2 (basemap-style.ts);
// its scripts are served from this server (vendor.ts), so R2 tiles and glyphs are the only
// third-party fetches on the page. `renderStats` is pure so the whole rendering path is testable
// without a database.

// Day boundaries are Pacific, not UTC — see DAY_TZ in db.ts.
const TZ = DAY_TZ;
const WINDOW_DAYS = 30;
// Widest range the page will chart. The bound exists so a hand-edited ?from= can't ask
// generate_series for decades of empty bars; two years covers the service's whole life with room.
const MAX_RANGE_DAYS = 732;

// What the chart can be broken down by — every grouping reads the one `requests` table.
// `variable` is the one multi-valued grouping: it unnests vars, so a request can land in
// several groups and the chart's quantity becomes variable requests rather than requests — the
// renderer relabels the tooltip accordingly.
export type GroupKey =
  | "account" | "device" | "outcome" | "mode" | "model" | "messages" | "variable" | "version";
// `outcome` groups every row, since its point is showing the failures; everything else counts
// served forecasts only, so a failure's all-null shape columns never surface as a "?" series.
const SERVED = `coalesce(r.outcome, 'ok') = 'ok'`;
const GROUP_EXPRS: Record<Exclude<GroupKey, "variable">, string> = {
  account: "r.account_id::text",
  device: "r.device",
  outcome: "coalesce(r.outcome, 'ok')",
  mode: "r.mode",
  model: "r.model",
  messages: "r.messages::text",
  version: "r.version::text",
};

// The variable grouping's vocabulary. The five variables every client sends by default say
// nothing about what was chosen, so they are excluded outright. The rest fold into families:
// the codec now reports the cloud selection as a single 'clouds' var, and the cch/ccm/ccl arm
// covers rows recorded before that change; the AQ indices and constituents are one AQI
// selection, and the pressure-level winds are one wind selection (no collision with the surface
// wind: it is a default, excluded before the CASE runs). Everything else stands alone under its
// own name.
const DEFAULT_VARS = ["wind", "snow", "rain", "temp", "gust"];
const VAR_GROUP_EXPR = `case
  when v in ('cch', 'ccm', 'ccl') then 'clouds'
  when v like 'aq%' then 'aqi'
  when v ~ '^w[0-9]+$' then 'wind'
  else v end`;
const VAR_GROUP_WHERE = ` and v not in (${DEFAULT_VARS.map((v) => `'${v}'`).join(", ")})`;

// The same family mapping for rows already in JS (the recent-requests table); keep in step with
// VAR_GROUP_EXPR above.
function varFamily(v: string): string {
  if (v === "cch" || v === "ccm" || v === "ccl") return "clouds";
  if (v.startsWith("aq")) return "aqi";
  if (/^w\d+$/.test(v)) return "wind";
  return v;
}

// Everything the grouping's SQL varies by. The variable grouping unnests vars, excludes the
// defaults, and counts DISTINCT requests: a request carrying three AQ columns is one AQI
// request, not three.
function groupSql(group: GroupKey | null): { expr: string; from: string; where: string; count: string } {
  if (group === "variable") {
    return {
      expr: VAR_GROUP_EXPR,
      from: "requests r, unnest(r.vars) v",
      where: VAR_GROUP_WHERE,
      count: `count(distinct r.id) filter (where ${SERVED})`,
    };
  }
  return {
    expr: group === null ? `''` : GROUP_EXPRS[group],
    from: "requests r",
    where: "",
    count: group === "outcome" ? "count(r.id)" : `count(r.id) filter (where ${SERVED})`,
  };
}

// The page's filters, all optional in the URL.
export type StatsFilters = {
  from: string; // YYYY-MM-DD, inclusive, Pacific
  to: string;
  group: GroupKey | null; // how to split the chart; null draws one series
};

// Today as a Pacific date, without touching the database: en-CA is the locale whose date format
// is YYYY-MM-DD.
const pacificToday = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

// d days before an ISO date, computed at UTC noon so DST shifts can't move the date.
const daysBefore = (day: string, d: number): string =>
  new Date(new Date(`${day}T12:00:00Z`).getTime() - d * 86400000).toISOString().slice(0, 10);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// URL params to a validated filter set. Anything malformed falls back to its default rather than
// erroring: the URL is hand-editable, and the page should always render.
const GROUP_KEYS: readonly GroupKey[] = [
  "account", "device", "outcome", "mode", "model", "messages", "variable", "version",
];

export function parseFilters(q: (name: string) => string | undefined): StatsFilters {
  const today = pacificToday();
  let from = DATE_RE.test(q("from") ?? "") ? q("from")! : daysBefore(today, WINDOW_DAYS - 1);
  let to = DATE_RE.test(q("to") ?? "") ? q("to")! : today;
  if (from > to) [from, to] = [to, from];
  if (daysBefore(to, MAX_RANGE_DAYS) >= from) from = daysBefore(to, MAX_RANGE_DAYS - 1);
  const grp = q("group") ?? "";
  const group = (GROUP_KEYS as readonly string[]).includes(grp) ? (grp as GroupKey) : null;
  return { from, to, group };
}

// One (day, group value) cell of the daily chart. `grp` is the grouped column's raw value: ""
// when the chart is ungrouped, null when the column itself is null (an internet request has no
// number, an early row no version).
export type DailyRow = { day: string; grp: string | null; requests: number };
// avgPeriods / avgCodecMs are window means over served forecasts, null when no served row in
// the window carries the column (it arrived 2026-08-31; older rows have nothing to average).
export type StatsTotals = {
  requests: number; users: number; failed: number;
  avgPeriods: number | null; avgCodecMs: number | null;
};
// One raw request row, every stored column except the token: the surrogate account id exists
// precisely so a request can be shown without its credential (db.ts), and this page keeps that.
// `time` arrives formatted in Pacific. Account is non-null because rows without one are
// excluded from the page; the shape columns are null on failures and on rows whose codec sent
// no header. lat/lon arrive as strings because `numeric` comes back from node-postgres as text.
// Strings from the shape columns arrive through the untrusted shape header.
export type RequestRow = {
  id: number;
  time: string;
  account: number;
  device: string | null;
  version: number | null;
  chars: number | null;
  outcome: string | null;
  loc: string | null;
  lat: string | null;
  lon: string | null;
  mode: string | null;
  model: string | null;
  messages: number | null;
  vars: string[];
  // What the reply carried (hours-per-period → count) and what serving it cost; null on
  // failures and on rows older than the columns.
  periods: Record<string, number> | null;
  codecMs: number | null;
  fetchMs: number | null;
  encodeMs: number | null;
};
// One row of the group-totals table under the chart: a value of the selected group, its
// requests, and how many distinct accounts carried them.
export type GroupTotalRow = { grp: string | null; requests: number; users: number };
// One point on the location map: a ~1 km cell forecasts were requested for, with a name when at
// least one of its requests carried one.
export type MapPointRow = { lat: string; lon: string; loc: string | null; count: number };
export type StatsData = {
  daily: DailyRow[];
  totals: StatsTotals;
  // What the page was asked to show, echoed back so the form can render its own state.
  filters: StatsFilters;
  // The window's newest raw request rows, at most REQUESTS_LIMIT of them.
  requests: RequestRow[];
  // Window totals per value of the selected group; empty when the chart is ungrouped.
  groups: GroupTotalRow[];
  // Per-variable counts keyed to their family, for the variable grouping's table; empty
  // otherwise.
  groupComponents: { grp: string; component: string; count: number }[];
  mapPoints: MapPointRow[];
};

// Every counted quantity, as one SQL fragment shared by the daily and window queries so the two
// can never drift apart. `r` is the requests row in both.
//
// `users` counts `account_id`, not `token`: the token is nulled when an account is deleted, so
// counting it made a past day's user count fall every time somebody deleted their account. The
// opaque id survives deletion for exactly this reason (accounts.ts, deleteAccount).
//
// `requests` counts served forecasts only. The table also holds failures and the messages
// answered without a forecast (HELP, probes), which belong in `failed` but would inflate a bar
// labelled "forecasts". A null outcome is a row written before the column existed, when only
// successes were recorded.
const COUNTS = `
  count(r.id) filter (where ${SERVED})                                             as requests,
  count(distinct r.account_id)                                                     as users,
  count(r.id) filter (where r.outcome in
    ('missing_version', 'unsupported_version', 'unavailable'))                     as failed,
  avg((select sum(value::int) from jsonb_each_text(r.periods)))
    filter (where ${SERVED})                                                       as avg_periods,
  avg(r.codec_ms) filter (where ${SERVED})                                         as avg_codec_ms
`;

// The WHERE clause and its parameters, built together so the placeholder numbers can never
// drift from the values. $1 is always the timezone and $2/$3 the inclusive day range. The
// window is a pair of half-open timestamp bounds rather than a per-row cast of created_at,
// so the created_at indexes stay usable.
function requestsFilter(f: StatsFilters): { where: string; params: unknown[] } {
  const params: unknown[] = [TZ, f.from, f.to];
  // The baseline exclusions: rows with no account predate the current clients (tokens arrived
  // later), and the page leaves them out entirely rather than carrying them as an "anonymous"
  // category. Probe and HELP rows are today implied by that (they carry no token), but are
  // named anyway so they stay out if they ever gain an identity.
  const where = `r.created_at >= ($2::date::timestamp at time zone $1)
     and r.created_at < (($3::date + 1)::timestamp at time zone $1)
     and r.account_id is not null
     and coalesce(r.outcome, 'ok') not in ('probe', 'help')`;
  return { where, params };
}

// Requests per day, split by the selected grouping (a constant '' when ungrouped). The FROM,
// WHERE tail and count expression come from groupSql, since the variable grouping needs the
// unnest join, the default-variable exclusion and a distinct count. Only days with traffic come
// back; the renderer lays the cells over the full window so a quiet day is a zero column rather
// than a missing one.
//
// The day is returned as text: node-postgres would otherwise parse a `date` into a JS Date at
// the *server's* local midnight, which is exactly the timezone bug this query is avoiding.
const dailySql = (where: string, g: ReturnType<typeof groupSql>) => `
  select to_char((r.created_at at time zone $1)::date, 'YYYY-MM-DD') as day,
         ${g.expr} as grp,
         ${g.count} as requests
    from ${g.from}
   where ${where}${g.where}
   group by 1, 2
   order by 1
`;

// Window totals are their own query because they cannot be derived from the daily rows: summing
// per-day distinct users would count somebody who texted on Monday and Friday twice.
const totalsSql = (where: string) => `
  select ${COUNTS} from requests r
   where ${where}
`;

// Window totals per value of the selected group, for the table under the chart. Unlike the
// chart it lists every value, biggest first — it is where a series folded into the chart's
// "Other" can still be read individually. `users` rides along because the distinct-account
// count cannot be derived from daily cells.
const groupTotalsSql = (where: string, g: ReturnType<typeof groupSql>) => `
  select ${g.expr}                       as grp,
         ${g.count}                      as requests,
         count(distinct r.account_id)   as users
    from ${g.from}
   where ${where}${g.where}
   group by 1
   order by requests desc, grp
`;

// The raw rows behind the section's aggregates, newest first. The timestamp is formatted here,
// in the same Pacific frame every other date on the page lives in.
const REQUESTS_LIMIT = 20;
const requestRowsSql = (where: string) => `
  select r.id, to_char(r.created_at at time zone $1, 'FMMM/FMDD HH24:MI') as time,
         r.account_id, r.device, r.version, r.chars, r.outcome,
         r.loc, r.lat::text as lat, r.lon::text as lon, r.mode, r.model, r.messages, r.vars,
         r.periods, r.codec_ms, r.fetch_ms, r.encode_ms
    from requests r
   where ${where}
   order by r.created_at desc
   limit ${REQUESTS_LIMIT}
`;

// The variable grouping's component breakdown: how many requests carried each individual
// variable, keyed to the family it folds into, so the table can show "AQI" and its constituents
// both. A plain count is right here — vars hold each variable at most once per request.
const varComponentsSql = (where: string) => `
  select ${VAR_GROUP_EXPR} as grp, v as component, count(*) as count
    from requests r, unnest(r.vars) v
   where ${where}${VAR_GROUP_WHERE}
   group by 1, 2
   order by 1, count desc, 2
`;

// Every place in the window with stored coordinates, one point per ~1 km cell. Windowed by time
// alone — a located request belongs on the map even when the identity exclusions would keep it
// out of the counts. Named and unnamed requests for the same cell fold together; min(loc) picks
// a stable representative name where any request carried one ('current' is the app's marker for
// "my location", not a name).
const MAP_POINTS_SQL = `
  select r.lat::text as lat, r.lon::text as lon,
         min(r.loc) filter (where r.loc is not null and r.loc <> 'current') as loc,
         count(*) as count
    from requests r
   where r.created_at >= ($2::date::timestamp at time zone $1)
     and r.created_at < (($3::date + 1)::timestamp at time zone $1)
     and r.lat is not null and r.lon is not null
   group by r.lat, r.lon
   order by count desc
`;

// Postgres returns count() as bigint, which node-postgres hands back as a string to avoid
// silently truncating past 2^53. These counts are small, so coerce once at the boundary and let
// the rest of the module work in numbers.
const num = (v: unknown): number => Number(v ?? 0);

const counts = (r: Record<string, unknown> | undefined): StatsTotals => ({
  requests: num(r?.["requests"]),
  users: num(r?.["users"]),
  failed: num(r?.["failed"]),
  avgPeriods: r?.["avg_periods"] == null ? null : Math.round(num(r["avg_periods"])),
  avgCodecMs: r?.["avg_codec_ms"] == null ? null : Math.round(num(r["avg_codec_ms"])),
});

// The periods jsonb as stored, coerced defensively: it arrived through the untrusted shape
// header (bounded there by shapePeriods), so a row that somehow holds another shape reads as
// "not reported" rather than rendering garbage.
const periodsOf = (v: unknown): Record<string, number> | null => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "number" || !Number.isFinite(val)) return null;
    out[k] = val;
  }
  return Object.keys(out).length ? out : null;
};

export async function dailyStats(filters: StatsFilters): Promise<StatsData> {
  const filtered = requestsFilter(filters);
  const g = groupSql(filters.group);
  const [daily, totals, requests, groups, components, mapPoints] = await Promise.all([
    query(dailySql(filtered.where, g), filtered.params),
    query(totalsSql(filtered.where), filtered.params),
    query(requestRowsSql(filtered.where), filtered.params),
    query(groupTotalsSql(filtered.where, g), filtered.params),
    filters.group === "variable"
      ? query(varComponentsSql(filtered.where), filtered.params)
      : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    query(MAP_POINTS_SQL, filtered.params),
  ]);
  return {
    daily: daily.rows.map((r) => ({
      day: String(r["day"]),
      grp: r["grp"] == null ? null : String(r["grp"]),
      requests: num(r["requests"]),
    })),
    filters,
    requests: requests.rows.map((r) => ({
      id: num(r["id"]),
      time: String(r["time"]),
      account: num(r["account_id"]),
      device: r["device"] == null ? null : String(r["device"]),
      version: r["version"] == null ? null : num(r["version"]),
      chars: r["chars"] == null ? null : num(r["chars"]),
      outcome: r["outcome"] == null ? null : String(r["outcome"]),
      loc: r["loc"] == null ? null : String(r["loc"]),
      lat: r["lat"] == null ? null : String(r["lat"]),
      lon: r["lon"] == null ? null : String(r["lon"]),
      mode: r["mode"] == null ? null : String(r["mode"]),
      model: r["model"] == null ? null : String(r["model"]),
      messages: r["messages"] == null ? null : num(r["messages"]),
      vars: Array.isArray(r["vars"]) ? (r["vars"] as unknown[]).map(String) : [],
      periods: periodsOf(r["periods"]),
      codecMs: r["codec_ms"] == null ? null : num(r["codec_ms"]),
      fetchMs: r["fetch_ms"] == null ? null : num(r["fetch_ms"]),
      encodeMs: r["encode_ms"] == null ? null : num(r["encode_ms"]),
    })),
    totals: counts(totals.rows[0]),
    groups:
      filters.group === null
        ? []
        : groups.rows.map((r) => ({
            grp: r["grp"] == null ? null : String(r["grp"]),
            requests: num(r["requests"]),
            users: num(r["users"]),
          })),
    groupComponents: components.rows.map((r) => ({
      grp: String(r["grp"]),
      component: String(r["component"]),
      count: num(r["count"]),
    })),
    mapPoints: mapPoints.rows.map((r) => ({
      lat: String(r["lat"]),
      lon: String(r["lon"]),
      loc: r["loc"] == null ? null : String(r["loc"]),
      count: num(r["count"]),
    })),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// The house categorical palette in its fixed slot order, validated as a set on this page's
// white surface (worst adjacent-pair CVD ΔE 9.1, worst adjacent normal-vision ΔE 19.6, both
// clear of the 8 / 15 floors). Series take slots in this order, biggest first; whatever does
// not fit the eight slots folds into a gray "Other", deliberately outside the palette because a
// remainder should read as material rather than as an identity. Aqua, yellow and magenta sit
// under 3:1 contrast on white; the relief is the per-column tooltip and the request log
// carrying the same rows as a table. Grid and axis are hairline greys a step off the surface
// so they stay recessive.
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const C_KNOWN = PALETTE[0]!;
const C_GRID = "#e1e0d9";
const C_AXIS = "#c3c2b7";
const C_MUTED = "#898781";

// Drawn at a fixed 680-unit width — the content width of the page's 720px column — and scaled to
// the viewport by the viewBox, so the same markup fits a phone.
const W = 680;
const PAD_L = 34;
const PAD_R = 6;
const PAD_T = 10;
const AXIS_H = 18;
const PLOT_W = W - PAD_L - PAD_R;
const GAP = 2; // surface gap between adjacent bars and between stacked segments

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-08-07" → "Aug 7". Formatted off the string rather than a Date so no timezone is involved
// on this side either; the query already decided which day a request belongs to.
export function formatDay(day: string): string {
  const [, m, d] = day.split("-");
  return `${MONTHS[parseInt(m ?? "1", 10) - 1]} ${parseInt(d ?? "1", 10)}`;
}

// Round a maximum up to a 1/2/5×10ⁿ step, aiming for about four gridlines. Charted against the
// raw maximum the axis would read 37 or 41; against this it reads 40.
//
// The step floor of 1 is not cosmetic: every quantity on this page is a count, so on a quiet day
// with a two-request peak the unclamped step is 0.5 and the axis offers to measure half a
// person. Integer steps also keep the tick loop free of floating-point drift.
function niceScale(max: number): { max: number; step: number } {
  if (max <= 0) return { max: 1, step: 1 };
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = Math.max(1, ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag);
  return { max: Math.ceil(max / step) * step, step };
}

const round = (n: number): string => (Math.round(n * 100) / 100).toString();

// A bar with only its data-end rounded: the top two corners take the radius, the baseline end
// stays square against the axis. `rx` on a <rect> would round all four and lift the mark off its
// own baseline.
function barPath(x: number, y: number, w: number, h: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, w / 2, h));
  return (
    `M${round(x)} ${round(y + h)}V${round(y + r)}` +
    `A${round(r)} ${round(r)} 0 0 1 ${round(x + r)} ${round(y)}` +
    `H${round(x + w - r)}` +
    `A${round(r)} ${round(r)} 0 0 1 ${round(x + w)} ${round(y + r)}` +
    `V${round(y + h)}Z`
  );
}

// One series of the daily chart: a legend/tooltip label (already escaped) and one value per day
// of the window.
type Series = { label: string; color: string; values: number[] };

// A stacked column chart over the window's days. Series stack bottom-up in array order; a
// single-element array is just a plain bar chart. Each column carries a full-height transparent
// hit rect so the hover target is the whole column rather than a 5px-wide bar — with 90 days on
// screen the bars are far too thin to ask anyone to land on. The tooltip names the day and the
// total, and, when the chart is grouped, each non-empty series on its own line.
function stackedChart(days: string[], series: Series[], plotH: number, label: string, noun = "request"): string {
  const svgH = PAD_T + plotH + AXIS_H;
  const baseline = PAD_T + plotH;
  const pitch = PLOT_W / days.length;
  const barW = Math.max(1, pitch - GAP);

  const totals = days.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const scale = niceScale(Math.max(...totals, 0));
  const y = (v: number): number => baseline - (v / scale.max) * plotH;

  const grid: string[] = [];
  for (let v = 0; v <= scale.max; v += scale.step) {
    grid.push(
      `<line x1="${PAD_L}" y1="${round(y(v))}" x2="${W - PAD_R}" y2="${round(y(v))}" ` +
        `stroke="${v === 0 ? C_AXIS : C_GRID}" stroke-width="1"/>`,
      `<text x="${PAD_L - 6}" y="${round(y(v) + 3.5)}" text-anchor="end" font-size="10" fill="${C_MUTED}">${v}</text>`,
    );
  }

  const columns = days.map((day, i) => {
    const x = PAD_L + i * pitch + (pitch - barW) / 2;
    const marks: string[] = [];
    let top = baseline; // running top of the stack, in user units
    // Walk the stack from the bottom so each segment sits on the one below it. The topmost
    // non-empty segment is the data-end and takes the corner radius.
    const drawn = series.map((s) => ({ s, v: s.values[i] ?? 0 })).filter((d) => d.v > 0);
    drawn.forEach(({ s, v }, idx) => {
      const h = (v / scale.max) * plotH;
      const isTop = idx === drawn.length - 1;
      // The gap is carved out of the bottom of every segment above the first, so the top of the
      // stack keeps reporting the true total.
      const inset = idx > 0 && h > GAP ? GAP : 0;
      marks.push(
        `<path d="${barPath(x, top - h, barW, h - inset, isTop ? 3 : 0)}" fill="${s.color}"/>`,
      );
      top -= h;
    });
    const tip =
      `${formatDay(day)} — ${plural(totals[i] ?? 0, noun)}` +
      (series.length > 1 ? drawn.map(({ s, v }) => `\n${s.label}: ${v}`).join("") : "");
    return (
      `<g><title>${tip}</title>` +
      marks.join("") +
      `<rect x="${round(PAD_L + i * pitch)}" y="${PAD_T}" width="${round(pitch)}" height="${plotH}" fill="transparent"/>` +
      `</g>`
    );
  });

  // Six or so date labels, stepped back from the most recent day so the right edge — the one
  // you actually look at — is always labelled. That last label sits within half a bar of the
  // plot edge, where a centred "Aug 8" would run past the viewBox and be clipped, so labels
  // near either edge anchor to the edge instead of to their column.
  const every = Math.max(1, Math.ceil(days.length / 6));
  const ticks: string[] = [];
  for (let i = days.length - 1; i >= 0; i -= every) {
    const day = days[i];
    if (!day) continue;
    const cx = PAD_L + i * pitch + pitch / 2;
    const half = 20; // half the width of a "Mmm D" label at 10px
    const anchor = cx + half > W ? "end" : cx - half < 0 ? "start" : "middle";
    const x = anchor === "end" ? W : anchor === "start" ? 0 : cx;
    ticks.push(
      `<text x="${round(x)}" y="${svgH - 5}" text-anchor="${anchor}" ` +
        `font-size="10" fill="${C_MUTED}">${formatDay(day)}</text>`,
    );
  }

  return (
    `<svg viewBox="0 0 ${W} ${svgH}" width="100%" role="img" aria-label="${label}">` +
    grid.join("") +
    columns.join("") +
    ticks.join("") +
    `</svg>`
  );
}

// How many real series the chart will carry before folding the rest into "Other": the palette's
// slot count. Fewer series read better anyway; past eight the legend is a wall either way.
const MAX_SERIES = 8;

// Every day of the window, inclusive. Iterated at UTC noon so DST shifts can't skip or repeat a
// date; the hard stop is a guard against a malformed range, not a real limit (parseFilters caps
// the range first).
function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let t = new Date(`${from}T12:00:00Z`).getTime(); days.length <= MAX_RANGE_DAYS; t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    days.push(day);
    if (day >= to) break;
  }
  return days;
}

// The display name of one group value, per group kind. A null value is a row the column
// predates (or, for the shape columns, a served reply whose codec sent no header). mode,
// messages, model and outcome read as stored; the variable families read as stored except AQI,
// whose name is an initialism.
function groupLabel(group: GroupKey, grp: string | null): string {
  if (grp === null) return "?";
  if (group === "device") return DEVICE_LABELS[grp] ?? grp;
  if (group === "version") return `v${grp}`;
  if (group === "variable" && grp === "aqi") return "AQI";
  return grp;
}

// Pivot the (day, group, count) cells into chart series: one per group value, biggest first so
// slot colors go to the biggest series, everything past the palette folded into a gray "Other".
// `label` names a group value and is null for an ungrouped chart, whose single '' group comes
// out as one unlabelled series.
function dailySeries(daily: DailyRow[], days: string[], label: ((grp: string | null) => string) | null): Series[] {
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const totals = new Map<string | null, number>();
  for (const c of daily) totals.set(c.grp, (totals.get(c.grp) ?? 0) + c.requests);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  const top = ranked.slice(0, MAX_SERIES);
  const series: Series[] = top.map((g, i) => ({
    label: label === null ? "Requests" : esc(label(g)),
    color: PALETTE[i]!,
    values: days.map(() => 0),
  }));
  const other: Series = { label: "Other", color: C_MUTED, values: days.map(() => 0) };
  const slot = new Map(top.map((g, i) => [g, i]));
  for (const c of daily) {
    const i = dayIndex.get(c.day);
    if (i === undefined) continue;
    const s = slot.has(c.grp) ? series[slot.get(c.grp)!]! : other;
    s.values[i] = (s.values[i] ?? 0) + c.requests;
  }
  if (ranked.length > top.length) series.push(other);
  return series;
}

const CSS = `
  /* Much wider than the prose pages, for the charts, the map and the wide request table. The
     override only exists on this page, since the shell inlines each page's own css. */
  .wrap { max-width: 1200px; }
  .windowbar { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; font-size: 0.9em;
    color: #52514e; }
  .windowbar label { display: inline-flex; align-items: center; gap: 6px; }
  .windowbar input, .windowbar button { font: inherit; font-size: 0.95em; }
  .windowbar button { padding: 2px 14px; }
  .stats svg { display: block; width: 100%; height: auto; }
  .stats h2 { margin: 1.6em 0 0.2em; }
  .stats h2.section { font-size: 1.35em; margin: 1.8em 0 0; padding-bottom: 0.15em;
    border-bottom: 1px solid #ddd; }
  .chartbar { margin: 0.6em 0 0.4em; font-size: 0.9em; color: #52514e; }
  .chartbar select { font: inherit; font-size: 0.95em; margin-left: 4px; }
  /* The anchor the group-by select submits to; the offset keeps a heading from hiding under
     the viewport's very top edge when jumped to. */
  #requests { scroll-margin-top: 12px; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; margin: 0.2em 0 0.6em; font-size: 0.85em;
    color: #52514e; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend i { width: 10px; height: 10px; border-radius: 2px; }
  .summary { display: flex; gap: 28px; flex-wrap: wrap; margin: 0.6em 0 1.6em; }
  .summary div { line-height: 1.25; }
  .summary b { display: block; font-size: 1.7em; font-weight: 600; }
  .summary span { color: #52514e; font-size: 0.85em; }
  /* The wide tables have a min-content width wider than a phone. Left alone, a table widens
     the whole page, and the charts — sized at 100% of that wider block — get cut off at the
     viewport edge. Scrolling the table inside its own box keeps the overflow local to it. */
  .tablewrap { overflow-x: auto; }
  /* overflow:hidden is what makes the corner radius actually clip the map canvas. */
  #locmap { height: 640px; margin-top: 0.8em; border: 1px solid #e1e0d9; border-radius: 8px;
    overflow: hidden; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.8em;
    font-variant-numeric: tabular-nums; font-size: 0.9em; }
  th, td { padding: 5px 8px; text-align: right; border-bottom: 1px solid #eee; }
  th:first-child, td:first-child { text-align: left; }
  thead th { color: #52514e; font-weight: 600; font-size: 0.85em; }
  tfoot td { font-weight: 600; border-top: 1px solid #c3c2b7; border-bottom: none; }
  td.comp { padding-left: 26px; }
  tbody tr:hover { background: #f7fafd; }
  .quiet { color: #898781; }
  .note { color: #666; font-size: 0.85em; margin-top: 1.6em; }
  @media (max-width: 600px) {
    .summary { gap: 18px; }
    .summary b { font-size: 1.45em; }
    th, td { padding: 5px 6px; }
    #locmap { height: 420px; }
  }
`;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

// What each `d:` code is, for the devices table. The codes are the identifiers the protocol
// defines (DEVICE_TRANSPORT); the words are only for this page.
const DEVICE_LABELS: Record<string, string> = {
  i: "iPhone",
  s: "SMS",
  z: "ZOLEO",
  d: "Internet",
  g: "inReach",
};

// The numbers and dates on this page are formatted by this module and need no escaping. The
// shape facets are different: their strings arrive through the codec's shape header, which
// dispatch.ts explicitly treats as untrusted input, so everything from it is escaped on the way
// into the markup.
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// A chart's group-by control, sitting just above its chart. The select belongs to the sidebar
// form (the `form` attribute), so submitting carries the window along; changing it retargets
// the submission at the chart's anchor so the reload lands back on the chart instead of at the
// top of the page.
function groupBar(name: string, anchor: string, active: string | null, options: [string, string][]): string {
  return (
    `<div class=chartbar><label>Group by <select name=${name} form=filters ` +
    `onchange="this.form.action='/stats#${anchor}';this.form.submit()">${options
      .map(([v, l]) => `<option value="${v}"${(active ?? "") === v ? " selected" : ""}>${l}</option>`)
      .join("")}</select></label></div>`
  );
}

// The raw request rows as a table, newest first: every stored column except the token (see
// RequestRow). Null cells render empty rather than as a word, except outcome, whose absence
// means a pre-outcome-column success. Location shows the name where one was given ('current' is
// the app's marker for "my location", not a name), else the stored ~1 km coordinates. The
// variables cell lists only the opt-ins — the five defaults are on every row and would drown
// the signal — folded to their families (clouds, AQI, wind) so a row reads as what was chosen
// rather than as a column dump.
function requestTable(requests: RequestRow[]): string {
  if (!requests.length) return `<p class=note>No requests in the window.</p>`;
  // Periods render as the reply's total, with the per-resolution breakdown ("1h×130, 3h×56")
  // in the hover title; timing as codec_ms, with the codec's own fetch/encode split in the
  // title. The periods keys arrived through the untrusted shape header, so they are escaped
  // like every other shape string.
  const periodsCell = (p: RequestRow["periods"]): string => {
    if (p === null) return "<td></td>";
    const entries = Object.entries(p).sort((a, b) => Number(a[0]) - Number(b[0]));
    const total = entries.reduce((n, [, v]) => n + v, 0);
    return `<td title="${esc(entries.map(([h, v]) => `${h}h×${v}`).join(", "))}">${total}</td>`;
  };
  const msCell = (r: RequestRow): string => {
    if (r.codecMs === null) return "<td></td>";
    const split = [
      ...(r.fetchMs === null ? [] : [`fetch ${r.fetchMs}`]),
      ...(r.encodeMs === null ? [] : [`encode ${r.encodeMs}`]),
    ].join(", ");
    return `<td${split ? ` title="${split} ms"` : ""}>${r.codecMs}</td>`;
  };
  const body = requests
    .map((r) => {
      const named = r.loc !== null && r.loc !== "current";
      const place = named ? esc(r.loc ?? "") : r.lat !== null && r.lon !== null ? `${esc(r.lat)}, ${esc(r.lon)}` : "";
      const vars = [...new Set(r.vars.filter((v) => !DEFAULT_VARS.includes(v)).map(varFamily))]
        .map((f) => esc(f === "aqi" ? "AQI" : f))
        .join(", ");
      return (
        `<tr><td>${r.id}</td><td>${r.time}</td><td>${r.account}</td>` +
        `<td>${r.device === null ? "" : DEVICE_LABELS[r.device] ?? esc(r.device)}</td>` +
        `<td>${r.version ?? ""}</td><td>${place}</td>` +
        `<td>${r.mode === null ? "" : esc(r.mode)}</td>` +
        `<td>${r.model === null ? "" : esc(r.model)}</td>` +
        `<td>${r.messages ?? ""}</td><td>${r.chars ?? ""}</td>` +
        periodsCell(r.periods) + msCell(r) + `<td>${vars}</td>` +
        `<td>${r.outcome === null || r.outcome === "ok" ? `<span class=quiet>ok</span>` : esc(r.outcome)}</td></tr>`
      );
    })
    .join("");
  return `<div class=tablewrap>
<table>
<thead><tr><th>Id</th><th>Time</th><th>Account</th><th>Device</th><th>Version</th>
<th>Location</th><th>Priority</th><th>Model</th><th>Messages</th><th>Chars</th>
<th>Periods</th><th>Codec ms</th><th>Variables</th><th>Outcome</th></tr></thead>
<tbody>${body}</tbody>
</table>
</div>`;
}

// The window bar at the top of the page, a plain GET form holding the shared date range:
// applying it reloads the page with the window in the URL, so a view is a link. The charts'
// group-by selects live next to their charts but belong to this form via the `form` attribute,
// so an Apply here carries them along unchanged.
function windowBar(data: StatsData): string {
  const f = data.filters;
  return `<form id=filters class=windowbar method=get action=/stats>
<label>From <input type=date name=from value="${f.from}"></label>
<label>To <input type=date name=to value="${f.to}"></label>
<button type=submit>Apply</button>
<a href="/stats">Reset</a>
</form>`;
}

// JSON destined for an inline <script>. Escaping `<` is what keeps a "</script>" (or "<!--")
// inside a location name from terminating the script block; it covers both since JSON strings
// read < back as `<`.
const jsonForScript = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c");

// The location map: the app's basemap with one circle per requested place, sized by request
// count. The style is built here rather than in the browser so the inline script stays small:
// it registers the pmtiles protocol, fits the camera, and wires the hover popup.
function locationMap(points: MapPointRow[]): { head: string; html: string } {
  const style = basemapStyle();
  style.sources["requests"] = {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: points.map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [Number(p.lon), Number(p.lat)] },
        // lat/lon ride along at the stored rounding for the popup on unnamed points; the name
        // is untrusted shape-header text, escaped client-side by being set via textContent.
        properties: { n: p.count, name: p.loc, lat: p.lat, lon: p.lon },
      })),
    },
  };
  // Area proportional to requests: radius on sqrt(count), from 4px at one request to 14px at
  // the window's busiest place.
  const maxN = Math.max(...points.map((p) => p.count), 1);
  const radius =
    maxN > 1 ? ["interpolate", ["linear"], ["sqrt", ["get", "n"]], 1, 4, Math.sqrt(maxN), 14] : 4;
  style.layers.push({
    id: "requests",
    type: "circle",
    source: "requests",
    paint: {
      "circle-color": C_KNOWN,
      "circle-opacity": 0.7,
      "circle-radius": radius as never,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
    },
  });

  const lats = points.map((p) => Number(p.lat));
  const lons = points.map((p) => Number(p.lon));
  const bounds = points.length
    ? [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]]
    : null;

  const cfg = { style, bounds, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM };
  const script = `
import * as maplibregl from "${vendorUrl("maplibre-gl.mjs")}";

const cfg = ${jsonForScript(cfg)};
maplibregl.addProtocol("pmtiles", new pmtiles.Protocol().tile);
const map = new maplibregl.Map({
  container: "locmap",
  style: cfg.style,
  center: [0, 20],
  zoom: cfg.minZoom,
  minZoom: cfg.minZoom,
  maxZoom: cfg.maxZoom,
  attributionControl: false,
  cooperativeGestures: true,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: "\\u00a9 OpenStreetMap" }));
if (cfg.bounds) map.fitBounds(cfg.bounds, { padding: 48, maxZoom: 8, animate: false });

// The peak icon the basemap's peaks layers ask for, drawn once on demand: the app registers it
// as an image asset, a canvas is the browser equivalent.
map.on("styleimagemissing", (e) => {
  if (e.id !== "peak-triangle" || map.hasImage("peak-triangle")) return;
  const size = 16;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.beginPath();
  ctx.moveTo(size / 2, 1.5);
  ctx.lineTo(size - 1.5, size - 2);
  ctx.lineTo(1.5, size - 2);
  ctx.closePath();
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = "#5a4636";
  ctx.fill();
  map.addImage("peak-triangle", ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
});

// Hover popup, built with textContent because the name arrives through the untrusted shape
// header.
const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
map.on("mousemove", "requests", (e) => {
  const f = e.features && e.features[0];
  if (!f) return;
  map.getCanvas().style.cursor = "pointer";
  const p = f.properties;
  const div = document.createElement("div");
  const name = document.createElement("b");
  name.textContent = p.name || (p.lat + ", " + p.lon);
  const n = document.createElement("div");
  n.textContent = p.n === 1 ? "1 request" : p.n + " requests";
  div.append(name, n);
  popup.setLngLat(f.geometry.coordinates).setDOMContent(div).addTo(map);
});
map.on("mouseleave", "requests", () => {
  map.getCanvas().style.cursor = "";
  popup.remove();
});
`;
  return {
    head: `<link rel=stylesheet href="${vendorUrl("maplibre-gl.css")}">`,
    // pmtiles is a classic script, not an import: its browser bundle is an IIFE exposing a
    // `pmtiles` global (see vendor.ts for why the ESM build can't be used).
    html:
      `<div id=locmap></div>\n<script src="${vendorUrl("pmtiles.js")}"></script>\n` +
      `<script type=module>${script}</script>`,
  };
}

export function renderStats(data: StatsData): string {
  const { daily, totals, filters, requests, groups, mapPoints } = data;

  const days = enumerateDays(filters.from, filters.to);
  const group = filters.group;
  const series = dailySeries(daily, days, group === null ? null : (g) => groupLabel(group, g));
  // Under the variable grouping a request counts once per variable it carried, so the stack's
  // quantity is variable requests, and the tooltip says so.
  const requestsChart = stackedChart(days, series, 150, "Requests per day",
    group === "variable" ? "variable request" : "request");
  // The ungrouped single series needs no legend — the heading names it. A grouped chart gets
  // one even with a single series on screen: the heading can't say which group survived the
  // filters. Labels are pre-escaped by dailySeries.
  const legend =
    group !== null && series.length > 0
      ? `<div class=legend>${series
          .map((x) => `<span><i style="background:${x.color}"></i>${x.label}</span>`)
          .join("")}</div>`
      : "";

  // The totals table under the chart, one row per value of the selected group. This is the full
  // list — a series the chart folded into "Other" still gets its own row here. Absent entirely
  // when the chart is ungrouped: the summary tiles already carry the window total.
  const GROUP_NAMES: Record<GroupKey, string> = {
    account: "Account", device: "Device", outcome: "Outcome", mode: "Priority", model: "Model",
    messages: "Messages", variable: "Variable", version: "Version",
  };
  // Under the variable grouping each family row is followed by its components, indented and
  // quiet — "AQI 6" and then which indices carried it. A family of one variable under its own
  // name gets no component rows; they would only repeat it.
  const componentRows = (grp: string | null): string => {
    if (grp === null) return "";
    const comps = data.groupComponents.filter((c) => c.grp === grp);
    if (comps.length === 1 && comps[0]!.component === grp) return "";
    return comps
      .map((c) => `<tr class=quiet><td class=comp>${esc(c.component)}</td><td>${c.count}</td><td></td></tr>`)
      .join("");
  };
  const groupRows = groups
    .map(
      (g) =>
        `<tr><td>${filters.group === null ? "" : esc(groupLabel(filters.group, g.grp))}</td>` +
        `<td>${g.requests}</td><td>${g.users}</td></tr>` +
        componentRows(g.grp),
    )
    .join("");
  // The total row sums requests but not accounts: distinct counts don't add across groups (one
  // account can sit in several), so the window's own distinct-account total stands in.
  const groupTotalRow =
    `<tfoot><tr><td>Total</td><td>${groups.reduce((n, g) => n + g.requests, 0)}</td>` +
    `<td>${totals.users}</td></tr></tfoot>`;
  const groupSection =
    filters.group !== null && groups.length
      ? `
<h2>By ${GROUP_NAMES[filters.group].toLowerCase()}</h2>
<div class=tablewrap>
<table>
<thead><tr><th>${GROUP_NAMES[filters.group]}</th><th>Requests</th><th>Accounts</th></tr></thead>
<tbody>${groupRows}</tbody>
${groupTotalRow}
</table>
</div>`
      : "";

  const map = mapPoints.length ? locationMap(mapPoints) : null;
  const locationSection = map ? map.html : `<p class=note>No locations recorded in the window.</p>`;

  // The number is read first and the label second, so the label agrees with it: "1 request",
  // not "1 requests". `word` is the singular; the caller's adjectives come before it.
  const tile = (n: number, word: string, adjective = ""): string =>
    `<div><b>${n}</b><span>${adjective}${adjective ? " " : ""}${word}${n === 1 ? "" : "s"}</span></div>`;

  const requestsSection =
    totals.requests === 0 && totals.failed === 0
      ? `<p class=note>No requests in this window.</p>`
      : `<div class=summary>
  ${tile(totals.requests, "request")}
  ${tile(totals.users, "account", "distinct")}
  ${tile(totals.failed, "request", "failed")}
  ${totals.avgPeriods === null ? "" : `<div><b>${totals.avgPeriods}</b><span>mean periods / forecast</span></div>`}
  ${totals.avgCodecMs === null ? "" : `<div><b>${totals.avgCodecMs}</b><span>mean codec ms</span></div>`}
</div>

<h2>Requests per day</h2>
${groupBar("group", "requests", group, [
  ["", "None"], ["account", "Account"], ["device", "Device"], ["outcome", "Outcome"],
  ["mode", "Priority"], ["model", "Model"], ["messages", "Messages"], ["variable", "Variable"],
  ["version", "Version"],
])}
${legend}
${requestsChart}
${groupSection}

<h2>Recent requests</h2>
${requestTable(requests)}`;

  const body = `<div class=stats>
${windowBar(data)}
<h2 class=section id=requests>Requests</h2>
${requestsSection}

${locationSection}
</div>`;

  return PAGE("Stats", body, { showUpdated: false, css: CSS, ...(map && { head: map.head }) });
}

export async function stats(c: Context) {
  try {
    const data = await dailyStats(parseFilters((name) => c.req.query(name)));
    // Authenticated, per-user content: it must not be held by any shared cache in front of this.
    return c.html(renderStats(data), 200, { "Cache-Control": "private, no-store" });
  } catch (e) {
    log.error("stats.query_failed", { err: e });
    return c.text("Stats unavailable", 503);
  }
}
