import type { Context } from "hono";
import { DAY_TZ, query } from "../db.js";
import { PAGE } from "./shell.js";
import { log } from "../log.js";

// GET /stats — the forecast usage dashboard, behind basic auth (wired in index.ts, which only
// registers the route when STATS_PASS is set). It reads `requests`, which has held one row per
// served forecast since launch and is therefore the authoritative usage record: Cloud Run's
// logs expire after 30 days, and log-based metrics only start counting the day you create them.
//
// The page is rendered server-side as inline SVG plus a table — no JavaScript, no chart library,
// no external requests, matching every other page here. `renderStats` is pure so the whole
// rendering path is testable without a database.

// Day boundaries are Pacific, not UTC — see DAY_TZ in db.ts, which the shape table's date column
// is also bounded by, so the two records agree on what "a day" is.
const TZ = DAY_TZ;
const WINDOW_DAYS = 90;
// Accounts listed on the sharing table. A long tail here would mean something has gone wrong
// with token distribution, and the top of the list is what says so.
const SHARED_LIMIT = 20;

export type StatsRow = {
  day: string;
  requests: number;
  users: number;
  anon: number;
  senders: number;
  // Distinct numbers that texted without a recognised account. Added to `users` these are the
  // people who used the service that day: an account and a number from the same person are one
  // person, but a number we can't tie to an account is somebody the account count never sees.
  unlinked: number;
  failed: number;
};
export type StatsTotals = Omit<StatsRow, "day">;
// One account seen from more than one number — the token-sharing signal.
export type SharedRow = { account: number; numbers: number; requests: number; lastDay: string };
// One value of one request facet (a priority mode, a model, a variable, …) and how many
// requests carried it.
export type FacetRow = { value: string; count: number };
// One device code's share of the window. `users` rides along because the device is the one
// request property recorded next to the account: "how many people reach us over each route" is
// a different question from "how many requests does each route carry".
export type DeviceRow = { device: string | null; requests: number; users: number };
// One place forecasts were requested for: a named location, or coordinates at the stored ~1 km
// rounding. lat/lon arrive as strings because `numeric` comes back from node-postgres as text.
export type LocationRow = { loc: string | null; lat: string | null; lon: string | null; count: number };
export type StatsData = {
  rows: StatsRow[];
  totals: StatsTotals;
  days: number;
  shared: SharedRow[];
  // Numbers seen using more than one account: the same question from the other end.
  sharedNumbers: number;
  devices: DeviceRow[];
  // The shape facets, each over the same window. These read `request_shapes`, which shares no
  // key with `requests` — so they describe the same traffic without being joinable to anyone.
  modes: FacetRow[];
  messages: FacetRow[];
  models: FacetRow[];
  vars: FacetRow[];
  locations: LocationRow[];
};

// Every counted quantity, as one SQL fragment shared by the daily and window queries so the two
// can never drift apart. `r` is the requests row in both.
//
// `users` counts `account_id`, not `token`: the token is nulled when an account is deleted, so
// counting it made a past day's user count fall every time somebody deleted their account. The
// opaque id survives deletion for exactly this reason (accounts.ts, deleteAccount).
//
// `requests` counts served forecasts only. The table also holds failures and the messages
// answered without a forecast (HELP, probes), which belong in `failed` and in the distinct-sender
// counts but would inflate a bar labelled "forecasts". A null outcome is a row written before the
// column existed, when only successes were recorded.
const COUNTS = `
  count(r.id) filter (where coalesce(r.outcome, 'ok') = 'ok')                      as requests,
  count(distinct r.account_id)                                                     as users,
  count(r.id) filter (where coalesce(r.outcome, 'ok') = 'ok'
                        and r.account_id is null)                                  as anon,
  count(distinct r.phone_hash)                                                     as senders,
  count(distinct r.phone_hash) filter (where r.account_id is null)                 as unlinked,
  count(r.id) filter (where r.outcome in
    ('missing_version', 'unsupported_version', 'unavailable'))                     as failed
`;

// One row per day in the window, including days with no traffic. The `generate_series` spine is
// what produces those zeros: grouping `requests` alone would simply omit a quiet day, and a
// missing bar reads as "no data" rather than "nobody asked".
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
  select to_char(d.day, 'YYYY-MM-DD') as day, ${COUNTS}
    from days d
    left join requests r
      on (r.created_at at time zone $1)::date = d.day
     and r.created_at >= (select first_day::timestamp at time zone $1 from span)
   group by d.day
   order by d.day
`;

// The window clause the totals and facet queries share, in both tables' vocabularies: requests
// are windowed by timestamp, shapes by their date column — which is all they have, by design.
const REQUESTS_WINDOW = `r.created_at >= ((now() at time zone $1)::date - ($2::int - 1))::timestamp at time zone $1`;
const SHAPES_WINDOW = `s.day >= (now() at time zone $1)::date - ($2::int - 1)`;

// Window totals are their own query because they cannot be derived from the daily rows: summing
// per-day distinct users would count somebody who texted on Monday and Friday twice.
const TOTALS_SQL = `
  select ${COUNTS} from requests r
   where ${REQUESTS_WINDOW}
`;

// Requests and people by device code. Grouped over every outcome, not just served forecasts:
// which routes a failure arrives over is part of what the column is for (a burst of
// unsupported-version failures from one device names the client that needs sunsetting last).
const DEVICES_SQL = `
  select r.device                                                                   as device,
         count(r.id) filter (where coalesce(r.outcome, 'ok') = 'ok')                as requests,
         count(distinct r.account_id)                                               as users
    from requests r
   where ${REQUESTS_WINDOW}
   group by r.device
   order by requests desc, device
`;

// The shape facets: what the window's requests asked for, one query per facet because they
// aggregate along different axes (a request has one mode but several models and variables).
const MODES_SQL = `
  select coalesce(s.mode, '?') as value, count(*) as count
    from request_shapes s where ${SHAPES_WINDOW}
   group by 1 order by count desc, value
`;
const MESSAGES_SQL = `
  select coalesce(s.messages::text, '?') as value, count(*) as count
    from request_shapes s where ${SHAPES_WINDOW}
   group by s.messages order by min(s.messages) nulls last
`;
const MODELS_SQL = `
  select m as value, count(*) as count
    from request_shapes s, unnest(s.models) m where ${SHAPES_WINDOW}
   group by m order by count desc, m
`;
const VARS_SQL = `
  select v as value, count(*) as count
    from request_shapes s, unnest(s.vars) v where ${SHAPES_WINDOW}
   group by v order by count desc, v
`;

// The most-asked-for places in the window. A named location groups on its name; coordinates
// group at the stored ~1 km rounding, which is the only precision that exists to group by.
const LOCATIONS_LIMIT = 15;
const LOCATIONS_SQL = `
  select s.loc, s.lat::text as lat, s.lon::text as lon, count(*) as count
    from request_shapes s where ${SHAPES_WINDOW}
   group by s.loc, s.lat, s.lon
   order by count desc, s.loc
   limit ${LOCATIONS_LIMIT}
`;

// Accounts that have been used from more than one number. Deliberately not windowed: sharing is
// a property of the account's whole life, and a token passed to a second handset last spring is
// still a shared token today.
const SHARED_SQL = `
  select r.account_id                                                as account,
         count(distinct r.phone_hash)                                as numbers,
         count(*)                                                    as requests,
         to_char(max(r.created_at at time zone $1)::date, 'YYYY-MM-DD') as last_day
    from requests r
   where r.account_id is not null and r.phone_hash is not null
   group by r.account_id
  having count(distinct r.phone_hash) > 1
   order by numbers desc, requests desc
   limit ${SHARED_LIMIT}
`;

// The same question from the other end: one handset carrying several accounts, which is what a
// reinstall-loop or a shared device looks like rather than a shared token.
const SHARED_NUMBERS_SQL = `
  select count(*) as numbers from (
    select r.phone_hash from requests r
     where r.phone_hash is not null and r.account_id is not null
     group by r.phone_hash
    having count(distinct r.account_id) > 1
  ) t
`;

// Postgres returns count() as bigint, which node-postgres hands back as a string to avoid
// silently truncating past 2^53. These counts are small, so coerce once at the boundary and let
// the rest of the module work in numbers.
const num = (v: unknown): number => Number(v ?? 0);

const counts = (r: Record<string, unknown> | undefined): StatsTotals => ({
  requests: num(r?.["requests"]),
  users: num(r?.["users"]),
  anon: num(r?.["anon"]),
  senders: num(r?.["senders"]),
  unlinked: num(r?.["unlinked"]),
  failed: num(r?.["failed"]),
});

const facets = (rows: Record<string, unknown>[]): FacetRow[] =>
  rows.map((r) => ({ value: String(r["value"]), count: num(r["count"]) }));

export async function dailyStats(days: number = WINDOW_DAYS): Promise<StatsData> {
  const win = [TZ, days];
  const [daily, totals, shared, sharedNumbers, devices, modes, messages, models, vars, locations] =
    await Promise.all([
      query(DAILY_SQL, win),
      query(TOTALS_SQL, win),
      query(SHARED_SQL, [TZ]),
      query(SHARED_NUMBERS_SQL),
      query(DEVICES_SQL, win),
      query(MODES_SQL, win),
      query(MESSAGES_SQL, win),
      query(MODELS_SQL, win),
      query(VARS_SQL, win),
      query(LOCATIONS_SQL, win),
    ]);
  return {
    days,
    rows: daily.rows.map((r) => ({ day: String(r["day"]), ...counts(r) })),
    totals: counts(totals.rows[0]),
    shared: shared.rows.map((r) => ({
      account: num(r["account"]),
      numbers: num(r["numbers"]),
      requests: num(r["requests"]),
      lastDay: String(r["last_day"]),
    })),
    sharedNumbers: num(sharedNumbers.rows[0]?.["numbers"]),
    devices: devices.rows.map((r) => ({
      device: r["device"] == null ? null : String(r["device"]),
      requests: num(r["requests"]),
      users: num(r["users"]),
    })),
    modes: facets(modes.rows),
    messages: facets(messages.rows),
    models: facets(models.rows),
    vars: facets(vars.rows),
    locations: locations.rows.map((r) => ({
      loc: r["loc"] == null ? null : String(r["loc"]),
      lat: r["lat"] == null ? null : String(r["lat"]),
      lon: r["lon"] == null ? null : String(r["lon"]),
      count: num(r["count"]),
    })),
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

type Segment = { key: "known" | "anon" | "users" | "unlinked"; color: string };

// Value of one segment for a row. `known` is derived rather than stored: it is every request
// that carried a token we recognised.
function segValue(row: StatsRow, key: Segment["key"]): number {
  if (key === "known") return row.requests - row.anon;
  if (key === "anon") return row.anon;
  if (key === "unlinked") return row.unlinked;
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
  /* Facet tables sit side by side and wrap on a phone; each is only as wide as its words. */
  .facets { display: flex; gap: 32px; flex-wrap: wrap; align-items: flex-start; }
  .facets table { width: auto; min-width: 140px; }
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

// What each `d:` code is, for the devices table. The codes are the identifiers the protocol
// defines (DEVICE_TRANSPORT); the words are only for this page.
const DEVICE_LABELS: Record<string, string> = {
  i: "iPhone satellite",
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

// One facet as a compact two-column table, or nothing when the facet has no rows — the section
// around these carries the "no shape record" state so an empty facet doesn't have to.
function facetTable(header: string, rows: FacetRow[]): string {
  if (!rows.length) return "";
  const body = rows
    .map((f) => `<tr><td>${esc(f.value)}</td><td>${f.count}</td></tr>`)
    .join("");
  return `<table><thead><tr><th>${header}</th><th>Requests</th></tr></thead><tbody>${body}</tbody></table>`;
}

export function renderStats(data: StatsData): string {
  const { rows, totals, days, shared, sharedNumbers, devices, locations } = data;

  if (totals.requests === 0 && totals.failed === 0 && totals.senders === 0) {
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

  // People gets its own plot rather than a second series over the requests chart: the two
  // measures differ by an order of magnitude, and putting them on one frame would mean either
  // flattening people into the axis or inventing a second y-scale.
  //
  // The two segments are the two ways we can tell one person from another, and they don't
  // overlap: an account, or — for someone texting with no account we recognise — the number they
  // texted from. Stacked, they are the closest thing to a count of people that anonymous
  // identifiers allow.
  const peopleChart = barChart(
    rows,
    [{ key: "users", color: C_KNOWN }, { key: "unlinked", color: C_ANON }],
    90,
    "People per day",
    (r) =>
      `${formatDay(r.day)} — ${plural(r.users, "account")}, ` +
      `${plural(r.unlinked, "number")} with no account`,
  );

  const tableRows = rows
    .slice()
    .reverse()
    .map(
      (r) =>
        `<tr${r.requests + r.failed === 0 ? " class=quiet" : ""}><td>${formatDay(r.day)}</td>` +
        `<td>${r.requests}</td><td>${r.failed}</td><td>${r.users}</td>` +
        `<td>${r.senders}</td><td>${r.anon}</td></tr>`,
    )
    .join("");

  // Goal of this table: notice a token being passed around. Empty is the expected state, and it
  // says so rather than disappearing — an absent table reads as "not measured".
  const sharedRows = shared
    .map(
      (s) =>
        `<tr><td>#${s.account}</td><td>${s.numbers}</td><td>${s.requests}</td>` +
        `<td>${formatDay(s.lastDay)}</td></tr>`,
    )
    .join("");
  // The converse sentence, kept on one line: these strings are asserted on, and a template
  // literal wrapped for the 100-column margin would put a newline inside the phrase.
  const converse =
    sharedNumbers === 0
      ? "No number has used more than one account."
      : `${plural(sharedNumbers, "number")} ${sharedNumbers === 1 ? "has" : "have"} used more than one account, which looks like a reinstall or a shared handset rather than a shared token.`;
  const sharedSection = shared.length
    ? `<div class=tablewrap>
<table>
<thead><tr><th>Account</th><th>Numbers</th><th>Requests</th><th>Last seen</th></tr></thead>
<tbody>${sharedRows}</tbody>
</table>
</div>
<p class=note>Accounts used from more than one number, over all time rather than the window above. ${converse}</p>`
    : `<p class=note>No account has been used from more than one number. ${converse}</p>`;

  // Requests and people per device. Null is a real category, not missing data: a hand-typed
  // message or a pre-`d:` client names no device, and both are still served.
  const deviceRows = devices
    .map(
      (d) =>
        `<tr><td>${d.device === null ? "Not stated" : (DEVICE_LABELS[d.device] ?? esc(d.device))}</td>` +
        `<td>${d.requests}</td><td>${d.users}</td></tr>`,
    )
    .join("");
  const deviceSection = devices.length
    ? `<div class=tablewrap>
<table>
<thead><tr><th>Device</th><th>Requests</th><th>Accounts</th></tr></thead>
<tbody>${deviceRows}</tbody>
</table>
</div>`
    : `<p class=note>No devices recorded in the window.</p>`;

  // The shape facets. These read the unlinked shape record, so they can be shown right next to
  // the identity numbers above without the two becoming joinable — that separation is the schema,
  // not this page's discretion (db.ts).
  const facetTables = [
    facetTable("Priority", data.modes),
    facetTable("Messages", data.messages),
    facetTable("Model", data.models),
    facetTable("Variable", data.vars),
  ].filter((t) => t.length > 0);
  const shapeSection = facetTables.length
    ? `<div class="facets tablewrap">${facetTables.join("")}</div>`
    : `<p class=note>No request shapes recorded in the window.</p>`;

  const locationRows = locations
    .map((l) => {
      const isNamed = l.loc !== null && l.loc !== "current";
      const place = isNamed ? esc(l.loc ?? "") : l.lat != null && l.lon != null ? `${esc(l.lat)}, ${esc(l.lon)}` : "?";
      return `<tr><td>${place}</td><td>${l.count}</td></tr>`;
    })
    .join("");
  const locationSection = locations.length
    ? `<div class=tablewrap>
<table>
<thead><tr><th>Location</th><th>Requests</th></tr></thead>
<tbody>${locationRows}</tbody>
</table>
</div>
<p class=note>The ${locations.length === LOCATIONS_LIMIT ? `${LOCATIONS_LIMIT} ` : ""}most requested places
in the window, at the stored ~1&nbsp;km rounding. Named locations group under their names.</p>`
    : `<p class=note>No locations recorded in the window.</p>`;

  // The number is read first and the label second, so the label agrees with it: "1 request",
  // not "1 requests". `word` is the singular; the caller's adjectives come before it.
  const tile = (n: number, word: string, adjective = ""): string =>
    `<div><b>${n}</b><span>${adjective}${adjective ? " " : ""}${word}${n === 1 ? "" : "s"}</span></div>`;

  const body = `<div class=stats>
<div class=summary>
  ${tile(totals.requests, "request")}
  ${tile(totals.users, "account", "distinct")}
  ${tile(totals.senders, "number", "distinct")}
  ${tile(totals.anon, "request", "anonymous")}
  ${tile(totals.failed, "request", "failed")}
</div>

<h2>Requests per day</h2>
<div class=legend>
  <span><i style="background:${C_KNOWN}"></i>From an account</span>
  <span><i style="background:${C_ANON}"></i>Anonymous</span>
</div>
${requestsChart}

<h2>People per day</h2>
<div class=legend>
  <span><i style="background:${C_KNOWN}"></i>Accounts</span>
  <span><i style="background:${C_ANON}"></i>Numbers with no account</span>
</div>
${peopleChart}

<h2>Devices</h2>
${deviceSection}

<h2>What was asked for</h2>
${shapeSection}

<h2>Locations</h2>
${locationSection}

<h2>By day</h2>
<div class=tablewrap>
<table>
<thead><tr><th>Day</th><th>Requests</th><th>Failed</th><th>Accounts</th><th>Numbers</th>
<th>Anonymous</th></tr></thead>
<tbody>${tableRows}</tbody>
</table>
</div>

<h2>Shared accounts</h2>
${sharedSection}

<p class=note>Last ${plural(days, "day")}, days bounded in Pacific time.
&ldquo;Requests&rdquo; counts served forecasts; &ldquo;Failed&rdquo; counts requests answered
with an error, and HELP and probe messages are counted in &ldquo;Numbers&rdquo; but in neither.
&ldquo;Accounts&rdquo; survives account deletion &mdash; a deleted account keeps its place in
past counts as an opaque number &mdash; but a request still arrives anonymous when it carries no
<code>u:</code> token or carries one from another environment. &ldquo;Numbers&rdquo; counts
distinct senders by a keyed hash of the number, so it covers text messages only; requests the app
sends over the internet carry no number. &ldquo;What was asked for&rdquo; and
&ldquo;Locations&rdquo; read the shape record, which is kept apart from accounts and numbers and
is written only for served forecasts, so its counts can run a little behind
&ldquo;Requests&rdquo;.</p>
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
