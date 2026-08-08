import type { Context } from "hono";
import { query } from "./db.js";
import { PAGE } from "./legal.js";
import { log } from "./log.js";

// GET /stats — the forecast usage dashboard, behind basic auth (wired in index.ts, which only
// registers the route when STATS_PASS is set). It reads `requests`, which has held one row per
// served forecast since launch and is therefore the authoritative usage record: Cloud Run's
// logs expire after 30 days, and log-based metrics only start counting the day you create them.
//
// The page is rendered server-side as inline SVG plus a table — no JavaScript, no chart library,
// no external requests, matching every other page here. `renderStats` is pure so the whole
// rendering path is testable without a database.

// Day boundaries are Pacific, not UTC: an evening request should count on the evening it
// happened, and UTC would push everything after 5pm into tomorrow. The named zone (rather than
// a fixed offset) is what makes the boundary follow DST.
const TZ = "America/Los_Angeles";
const WINDOW_DAYS = 90;

export type StatsRow = { day: string; requests: number; users: number; anon: number };
export type StatsTotals = { requests: number; users: number; anon: number };
export type StatsData = { rows: StatsRow[]; totals: StatsTotals; days: number };

// One row per day in the window, including days with no traffic. The `generate_series` spine is
// what produces those zeros: grouping `requests` alone would simply omit a quiet day, and a
// missing bar reads as "no data" rather than "nobody asked".
//
// `count(distinct token)` ignores nulls, so `users` counts known accounts only. That is not the
// whole story — a null token means the request carried no `u:` word, carried one from another
// environment, or belonged to an account since deleted (accounts.ts nulls the column on
// deletion) — so `anon` is reported beside it rather than folded in and lost.
//
// The day is returned as text: node-postgres would otherwise parse a `date` into a JS Date at
// the *server's* local midnight, which is exactly the timezone bug this query is avoiding.
const DAILY_SQL = `
  with span as (
    select (now() at time zone $1)::date                as last_day,
           (now() at time zone $1)::date - ($2::int - 1) as first_day
  ),
  days as (
    select generate_series(s.first_day, s.last_day, interval '1 day')::date as day from span s
  )
  select to_char(d.day, 'YYYY-MM-DD')              as day,
         count(r.id)                               as requests,
         count(distinct r.token)                   as users,
         count(r.id) filter (where r.token is null) as anon
    from days d
    left join requests r
      on (r.created_at at time zone $1)::date = d.day
     and r.created_at >= (select first_day::timestamp at time zone $1 from span)
   group by d.day
   order by d.day
`;

// Window totals are their own query because they cannot be derived from the daily rows: summing
// per-day distinct users would count somebody who texted on Monday and Friday twice.
const TOTALS_SQL = `
  select count(*)                                as requests,
         count(distinct token)                   as users,
         count(*) filter (where token is null)   as anon
    from requests
   where created_at >= ((now() at time zone $1)::date - ($2::int - 1))::timestamp at time zone $1
`;

// Postgres returns count() as bigint, which node-postgres hands back as a string to avoid
// silently truncating past 2^53. These counts are small, so coerce once at the boundary and let
// the rest of the module work in numbers.
const num = (v: unknown): number => Number(v ?? 0);

export async function dailyStats(days: number = WINDOW_DAYS): Promise<StatsData> {
  const [daily, totals] = await Promise.all([
    query(DAILY_SQL, [TZ, days]),
    query(TOTALS_SQL, [TZ, days]),
  ]);
  const t = totals.rows[0];
  return {
    days,
    rows: daily.rows.map((r) => ({
      day: String(r["day"]),
      requests: num(r["requests"]),
      users: num(r["users"]),
      anon: num(r["anon"]),
    })),
    totals: { requests: num(t?.["requests"]), users: num(t?.["users"]), anon: num(t?.["anon"]) },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Categorical slots 1 and 2 of the house palette. The pair was validated against this page's
// white surface rather than assumed: worst-case colour-vision-deficient separation ΔE 24.7 and
// normal-vision ΔE 33.6, both comfortably clear of the 8 / 15 floors, and both above 3:1
// contrast. Grid and axis are hairline greys a step off the surface so they stay recessive.
const C_KNOWN = "#2a78d6";
const C_ANON = "#eb6834";
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

type Segment = { key: "known" | "anon" | "users"; color: string };

// Value of one segment for a row. `known` is derived rather than stored: it is every request
// that carried a token we recognised.
function segValue(row: StatsRow, key: Segment["key"]): number {
  if (key === "known") return row.requests - row.anon;
  if (key === "anon") return row.anon;
  return row.users;
}

// A stacked column chart. Segments stack bottom-up in array order; a single-element array is
// just a plain bar chart. Each column carries a full-height transparent hit rect so the hover
// target is the whole column rather than a 5px-wide bar — with 90 days on screen the bars are
// far too thin to ask anyone to land on.
function barChart(rows: StatsRow[], segments: Segment[], plotH: number, label: string, tip: (r: StatsRow) => string): string {
  const svgH = PAD_T + plotH + AXIS_H;
  const baseline = PAD_T + plotH;
  const pitch = PLOT_W / rows.length;
  const barW = Math.max(1, pitch - GAP);

  const peak = Math.max(...rows.map((r) => segments.reduce((sum, s) => sum + segValue(r, s.key), 0)));
  const scale = niceScale(peak);
  const y = (v: number): number => baseline - (v / scale.max) * plotH;

  const grid: string[] = [];
  for (let v = 0; v <= scale.max; v += scale.step) {
    grid.push(
      `<line x1="${PAD_L}" y1="${round(y(v))}" x2="${W - PAD_R}" y2="${round(y(v))}" ` +
        `stroke="${v === 0 ? C_AXIS : C_GRID}" stroke-width="1"/>`,
      `<text x="${PAD_L - 6}" y="${round(y(v) + 3.5)}" text-anchor="end" font-size="10" fill="${C_MUTED}">${v}</text>`,
    );
  }

  const columns = rows.map((row, i) => {
    const x = PAD_L + i * pitch + (pitch - barW) / 2;
    const marks: string[] = [];
    let top = baseline; // running top of the stack, in user units
    // Walk the stack from the bottom so each segment sits on the one below it. The topmost
    // non-empty segment is the data-end and takes the corner radius.
    const drawn = segments.map((s) => ({ s, v: segValue(row, s.key) })).filter((d) => d.v > 0);
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
    return (
      `<g><title>${tip(row)}</title>` +
      marks.join("") +
      `<rect x="${round(PAD_L + i * pitch)}" y="${PAD_T}" width="${round(pitch)}" height="${plotH}" fill="transparent"/>` +
      `</g>`
    );
  });

  // Six or so date labels, stepped back from the most recent day so the right edge — the one
  // you actually look at — is always labelled. That last label sits within half a bar of the
  // plot edge, where a centred "Aug 8" would run past the viewBox and be clipped, so labels
  // near either edge anchor to the edge instead of to their column.
  const every = Math.max(1, Math.ceil(rows.length / 6));
  const ticks: string[] = [];
  for (let i = rows.length - 1; i >= 0; i -= every) {
    const row = rows[i];
    if (!row) continue;
    const cx = PAD_L + i * pitch + pitch / 2;
    const half = 20; // half the width of a "Mmm D" label at 10px
    const anchor = cx + half > W ? "end" : cx - half < 0 ? "start" : "middle";
    const x = anchor === "end" ? W : anchor === "start" ? 0 : cx;
    ticks.push(
      `<text x="${round(x)}" y="${svgH - 5}" text-anchor="${anchor}" ` +
        `font-size="10" fill="${C_MUTED}">${formatDay(row.day)}</text>`,
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

const CSS = `
  .stats svg { display: block; width: 100%; height: auto; }
  .stats h2 { margin: 1.6em 0 0.2em; }
  .summary { display: flex; gap: 28px; flex-wrap: wrap; margin: 0.6em 0 1.6em; }
  .summary div { line-height: 1.25; }
  .summary b { display: block; font-size: 1.7em; font-weight: 600; }
  .summary span { color: #52514e; font-size: 0.85em; }
  .legend { display: flex; gap: 16px; margin: 0.2em 0 0.6em; font-size: 0.85em; color: #52514e; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend i { width: 10px; height: 10px; border-radius: 2px; }
  /* The four columns have a min-content width wider than a phone. Left alone, the table widens
     the whole page, and the charts — sized at 100% of that wider block — get cut off at the
     viewport edge. Scrolling the table inside its own box keeps the overflow local to it. */
  .tablewrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.8em;
    font-variant-numeric: tabular-nums; font-size: 0.9em; }
  th, td { padding: 5px 8px; text-align: right; border-bottom: 1px solid #eee; }
  th:first-child, td:first-child { text-align: left; }
  thead th { color: #52514e; font-weight: 600; font-size: 0.85em; }
  tbody tr:hover { background: #f7fafd; }
  .quiet { color: #898781; }
  .note { color: #666; font-size: 0.85em; margin-top: 1.6em; }
  @media (max-width: 600px) {
    .summary { gap: 18px; }
    .summary b { font-size: 1.45em; }
    th, td { padding: 5px 6px; }
  }
`;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

// Every value on this page is a number or a date this module formats itself — nothing from the
// request reaches the markup — so there is deliberately no escaping helper here.
export function renderStats(data: StatsData): string {
  const { rows, totals, days } = data;

  if (totals.requests === 0) {
    return PAGE(
      "Stats",
      `<div class=stats><p>No forecast requests in the last ${plural(days, "day")}.</p></div>`,
      { showUpdated: false, css: CSS },
    );
  }

  const requestsChart = barChart(
    rows,
    [{ key: "known", color: C_KNOWN }, { key: "anon", color: C_ANON }],
    150,
    "Forecast requests per day",
    (r) =>
      `${formatDay(r.day)} — ${plural(r.requests, "request")}` +
      (r.requests > 0 ? ` (${r.requests - r.anon} from accounts, ${r.anon} anonymous)` : ""),
  );

  // Users gets its own plot rather than a second line over the requests chart: the two measures
  // differ by an order of magnitude, and putting them on one frame would mean either flattening
  // users into the axis or inventing a second y-scale.
  const usersChart = barChart(
    rows,
    [{ key: "users", color: C_KNOWN }],
    90,
    "Distinct accounts per day",
    (r) => `${formatDay(r.day)} — ${plural(r.users, "account")}`,
  );

  const tableRows = rows
    .slice()
    .reverse()
    .map(
      (r) =>
        `<tr${r.requests === 0 ? " class=quiet" : ""}><td>${formatDay(r.day)}</td>` +
        `<td>${r.requests}</td><td>${r.users}</td><td>${r.anon}</td></tr>`,
    )
    .join("");

  const body = `<div class=stats>
<div class=summary>
  <div><b>${totals.requests}</b><span>requests</span></div>
  <div><b>${totals.users}</b><span>distinct accounts</span></div>
  <div><b>${totals.anon}</b><span>anonymous requests</span></div>
</div>

<h2>Requests per day</h2>
<div class=legend>
  <span><i style="background:${C_KNOWN}"></i>From an account</span>
  <span><i style="background:${C_ANON}"></i>Anonymous</span>
</div>
${requestsChart}

<h2>Distinct accounts per day</h2>
${usersChart}

<h2>By day</h2>
<div class=tablewrap>
<table>
<thead><tr><th>Day</th><th>Requests</th><th>Accounts</th><th>Anonymous</th></tr></thead>
<tbody>${tableRows}</tbody>
</table>
</div>

<p class=note>Last ${plural(days, "day")}, days bounded in Pacific time. &ldquo;Accounts&rdquo;
counts distinct account tokens, so it excludes anonymous requests &mdash; a request arrives
anonymous when it carries no <code>u:</code> token, carries one from another environment, or
belongs to an account since deleted. Only successfully served forecasts are recorded, so failed
and unsupported-version requests do not appear here.</p>
</div>`;

  return PAGE("Stats", body, { showUpdated: false, css: CSS });
}

export async function stats(c: Context) {
  try {
    const data = await dailyStats();
    // Authenticated, per-user content: it must not be held by any shared cache in front of this.
    return c.html(renderStats(data), 200, { "Cache-Control": "private, no-store" });
  } catch (e) {
    log.error("stats.query_failed", { err: e });
    return c.text("Stats unavailable", 503);
  }
}
