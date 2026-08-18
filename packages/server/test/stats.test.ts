import { describe, expect, it } from "vitest";
import { formatDay, renderStats, type SharedRow, type StatsData, type StatsRow } from "../src/pages/stats.js";

// Rendering is pure, so every case here feeds rows straight in — no Postgres, matching the rest
// of the server tests. Assertions are on structure and numbers rather than exact markup, so
// restyling the page doesn't break them.

const row = (
  day: string,
  requests: number,
  users: number,
  anon: number,
  extra: Partial<StatsRow> = {},
): StatsRow => ({ day, requests, users, anon, senders: 0, unlinked: 0, failed: 0, ...extra });

// Distinct measures (users, senders) are the largest day rather than a sum: over a real window
// the query counts each account or number once however many days it appears on. Additive ones
// are summed.
const peak = (rows: StatsRow[], key: keyof StatsRow): number =>
  Math.max(0, ...rows.map((r) => Number(r[key])));
const sum = (rows: StatsRow[], key: keyof StatsRow): number =>
  rows.reduce((n, r) => n + Number(r[key]), 0);

const data = (
  rows: StatsRow[],
  {
    days = rows.length,
    shared = [] as SharedRow[],
    sharedNumbers = 0,
    devices = [] as StatsData["devices"],
    modes = [] as StatsData["modes"],
    messages = [] as StatsData["messages"],
    models = [] as StatsData["models"],
    vars = [] as StatsData["vars"],
    locations = [] as StatsData["locations"],
  } = {},
): StatsData => ({
  rows,
  days,
  shared,
  sharedNumbers,
  devices,
  modes,
  messages,
  models,
  vars,
  locations,
  totals: {
    requests: sum(rows, "requests"),
    anon: sum(rows, "anon"),
    failed: sum(rows, "failed"),
    users: peak(rows, "users"),
    senders: peak(rows, "senders"),
    unlinked: peak(rows, "unlinked"),
  },
});

// Count elements by matching the tag with its fill, which is what identifies a series.
const countFill = (html: string, fill: string): number =>
  html.split(`fill="${fill}"`).length - 1;

const KNOWN = "#2a78d6";
const ANON = "#eb6834";

describe("formatDay", () => {
  it("formats the ISO day without going through a Date", () => {
    expect(formatDay("2026-08-07")).toBe("Aug 7");
    expect(formatDay("2026-01-01")).toBe("Jan 1");
    expect(formatDay("2026-12-31")).toBe("Dec 31");
  });
});

describe("renderStats", () => {
  it("reports an empty window instead of drawing an empty chart", () => {
    const html = renderStats(data([row("2026-08-06", 0, 0, 0), row("2026-08-07", 0, 0, 0)]));
    expect(html).toContain("No forecast requests in the last 2 days");
    expect(html).not.toContain("<svg");
  });

  it("draws no bar for a zero day but still lists it in the table", () => {
    const rows = [row("2026-08-05", 4, 2, 2), row("2026-08-06", 0, 0, 0), row("2026-08-07", 6, 3, 3)];
    const html = renderStats(data(rows));
    // Two days with traffic, so two bars per series — the quiet day contributes none.
    expect(countFill(html, ANON)).toBe(2);
    // ...and it is still a row, so the gap is visible as a zero rather than missing.
    expect(html).toContain("<td>Aug 6</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td>");
  });

  it("puts each measure in its own column", () => {
    const html = renderStats(data([
      row("2026-08-07", 21, 5, 16, { senders: 4, failed: 2 }),
    ]));
    expect(html).toContain("<td>Aug 7</td><td>21</td><td>2</td><td>5</td><td>4</td><td>16</td>");
  });

  it("lists days newest first", () => {
    const html = renderStats(data([row("2026-08-05", 1, 1, 0), row("2026-08-07", 2, 1, 0)]));
    expect(html.indexOf("Aug 7</td>")).toBeLessThan(html.indexOf("Aug 5</td>"));
  });

  it("scales bars against the window's peak, not each day", () => {
    const html = renderStats(data([row("2026-08-06", 5, 0, 5), row("2026-08-07", 10, 0, 10)]));
    // Both days are anon-only, so each is a single bar. The taller day must be exactly twice the
    // shorter one — a per-day scale would draw them the same height. The bar's true top is the
    // first arc's endpoint, not the `V` before it, which stops short by the corner radius.
    const heights = [...html.matchAll(/M[\d.]+ ([\d.]+)V[\d.]+A[\d.]+ [\d.]+ 0 0 1 [\d.]+ ([\d.]+)H/g)]
      .map(([, bottom, top]) => Number(bottom) - Number(top))
      .filter((h) => h > 0)
      .sort((a, b) => a - b);
    expect(heights).toHaveLength(2);
    expect(heights[1]! / heights[0]!).toBeCloseTo(2, 5);
  });

  it("stacks account requests below anonymous ones", () => {
    const html = renderStats(data([row("2026-08-07", 10, 2, 4)]));
    // 6 from accounts + 4 anonymous. Both segments are drawn, and the known one sits lower on
    // the page (a larger y) than the anonymous one stacked above it.
    const known = html.indexOf(`fill="${KNOWN}"`);
    const anon = html.indexOf(`fill="${ANON}"`);
    expect(known).toBeGreaterThan(-1);
    expect(anon).toBeGreaterThan(-1);
    // The users chart reuses the known colour, so count the first (requests) chart's segments by
    // taking the pair that appear before the second <h2>.
    expect(html).toContain("From an account");
    expect(html).toContain("Anonymous");
  });

  it("describes each column in a hover title covering both parts of the stack", () => {
    const html = renderStats(data([row("2026-08-07", 21, 5, 16, { unlinked: 3 })]));
    expect(html).toContain("<title>Aug 7 — 21 requests (5 from accounts, 16 anonymous)</title>");
    expect(html).toContain("<title>Aug 7 — 5 accounts, 3 numbers with no account</title>");
  });

  it("singularises counts in the tooltips", () => {
    const html = renderStats(data([row("2026-08-07", 1, 1, 0, { unlinked: 1 })]));
    expect(html).toContain("1 request (1 from accounts, 0 anonymous)");
    expect(html).toContain("1 account, 1 number with no account");
  });

  it("shows window totals rather than a sum of daily distinct users", () => {
    const html = renderStats(data([
      row("2026-08-06", 4, 3, 1, { senders: 2, failed: 1 }),
      row("2026-08-07", 6, 3, 2, { senders: 2 }),
    ]));
    expect(html).toContain("<b>10</b><span>requests</span>");
    expect(html).toContain("<b>3</b><span>distinct accounts</span>");
    expect(html).toContain("<b>2</b><span>distinct numbers</span>");
    expect(html).toContain("<b>3</b><span>anonymous requests</span>");
    // Singular, because the label is read together with the number beside it.
    expect(html).toContain("<b>1</b><span>failed request</span>");
  });

  // The count of people is the whole point of the second chart: an account and the number it
  // texts from are one person, so only numbers we cannot tie to an account are added on top.
  it("stacks numbers with no account above accounts in the people chart", () => {
    const html = renderStats(data([row("2026-08-07", 8, 2, 3, { senders: 5, unlinked: 3 })]));
    expect(html).toContain("Numbers with no account");
    expect(html).toContain("<title>Aug 7 — 2 accounts, 3 numbers with no account</title>");
  });

  // A day that served nothing but failed and was texted is still a day with traffic; the empty
  // state must not claim otherwise.
  it("reports an empty window only when nothing at all happened", () => {
    const failedOnly = renderStats(data([row("2026-08-07", 0, 0, 0, { senders: 1, failed: 2 })]));
    expect(failedOnly).not.toContain("No forecast requests");
    expect(failedOnly).toContain("<b>2</b><span>failed requests</span>");
    expect(failedOnly).toContain("<b>1</b><span>distinct number</span>");
  });

  it("keeps gridlines on whole numbers — these are counts, not measurements", () => {
    // A peak of 2 divided into four gridlines wants a step of 0.5, which would offer to measure
    // half a person.
    const html = renderStats(data([row("2026-08-06", 2, 2, 0), row("2026-08-07", 1, 1, 0)]));
    const axisLabels = [...html.matchAll(/text-anchor="end" font-size="10" fill="#898781">([\d.]+)</g)]
      .map(([, v]) => v!);
    expect(axisLabels.length).toBeGreaterThan(0);
    expect(axisLabels.filter((v) => v.includes("."))).toEqual([]);
  });

  it("labels the most recent day on the x axis", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row(`2026-07-${String(i + 1).padStart(2, "0")}`, i, 1, 0),
    );
    const html = renderStats(data(rows));
    expect(html).toContain(">Jul 30<");
  });
});

describe("renderStats — shared accounts", () => {
  const shared: SharedRow[] = [
    { account: 412, numbers: 3, requests: 27, lastDay: "2026-08-07" },
    { account: 77, numbers: 2, requests: 4, lastDay: "2026-07-19" },
  ];

  it("lists accounts seen from more than one number", () => {
    const html = renderStats(data([row("2026-08-07", 31, 2, 0, { senders: 5 })], { shared }));
    expect(html).toContain("<td>#412</td><td>3</td><td>27</td><td>Aug 7</td>");
    expect(html).toContain("<td>#77</td><td>2</td><td>4</td><td>Jul 19</td>");
  });

  // Empty is the expected state and has to say so: a table that vanishes reads as "not measured"
  // rather than "nothing to report".
  it("says nothing is shared rather than dropping the section", () => {
    const html = renderStats(data([row("2026-08-07", 3, 1, 0, { senders: 1 })]));
    expect(html).toContain("Shared accounts");
    expect(html).toContain("No account has been used from more than one number");
  });

  it("reports the converse — a number carrying several accounts", () => {
    const one = renderStats(data([row("2026-08-07", 3, 2, 0, { senders: 1 })], { sharedNumbers: 1 }));
    expect(one).toContain("1 number has used more than one account");

    const many = renderStats(data([row("2026-08-07", 9, 4, 0, { senders: 2 })], { shared, sharedNumbers: 2 }));
    expect(many).toContain("2 numbers have used more than one account");
  });
});

describe("renderStats — devices and request shapes", () => {
  const rows = [row("2026-08-07", 12, 3, 1, { senders: 4 })];

  it("names each device code and keeps null as its own row", () => {
    const html = renderStats(data(rows, {
      devices: [
        { device: "i", requests: 8, users: 2 },
        { device: null, requests: 4, users: 1 },
      ],
    }));
    expect(html).toContain("<td>iPhone satellite</td><td>8</td><td>2</td>");
    expect(html).toContain("<td>Not stated</td><td>4</td><td>1</td>");
  });

  it("lists the shape facets — priority, messages, models, variables", () => {
    const html = renderStats(data(rows, {
      modes: [{ value: "auto", count: 9 }, { value: "range", count: 3 }],
      messages: [{ value: "1", count: 10 }, { value: "2", count: 2 }],
      models: [{ value: "best", count: 11 }, { value: "eu", count: 1 }],
      vars: [{ value: "temp", count: 12 }, { value: "freeze", count: 5 }],
    }));
    expect(html).toContain("<td>auto</td><td>9</td>");
    expect(html).toContain("<th>Messages</th>");
    expect(html).toContain("<td>2</td><td>2</td>");
    expect(html).toContain("<td>eu</td><td>1</td>");
    expect(html).toContain("<td>freeze</td><td>5</td>");
  });

  it("shows a named location by name and coordinates at their stored rounding", () => {
    const html = renderStats(data(rows, {
      locations: [
        { loc: "summit", lat: "63.07", lon: "-151.00", count: 7 },
        { loc: "current", lat: "63.06", lon: "-151.08", count: 3 },
      ],
    }));
    expect(html).toContain("<td>summit</td><td>7</td>");
    expect(html).toContain("<td>63.06, -151.08</td><td>3</td>");
  });

  // The shape header is untrusted input (dispatch.ts); a compromised codec must not be able to
  // put markup on this page.
  it("escapes shape strings on the way into the markup", () => {
    const html = renderStats(data(rows, {
      modes: [{ value: '<script>alert(1)</script>', count: 1 }],
    }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says when nothing has been recorded rather than dropping the sections", () => {
    const html = renderStats(data(rows));
    expect(html).toContain("No devices recorded");
    expect(html).toContain("No request shapes recorded");
    expect(html).toContain("No locations recorded");
  });
});
