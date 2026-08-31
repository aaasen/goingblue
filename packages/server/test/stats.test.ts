import { describe, expect, it } from "vitest";
import { formatDay, renderStats, type DailyRow, type RequestRow, type StatsData } from "../src/pages/stats.js";

// Rendering is pure, so every case here feeds cells straight in — no Postgres, matching the rest
// of the server tests. Assertions are on structure and numbers rather than exact markup, so
// restyling the page doesn't break them.

// One chart cell. grp defaults to the ungrouped chart's constant ''.
const cell = (day: string, requests: number, grp: string | null = ""): DailyRow =>
  ({ day, grp, requests });

// One raw request row with every column a served default-forecast reply carries; tests override
// what they exercise.
const row = (over: Partial<RequestRow> = {}): RequestRow => ({
  id: 1, time: "8/30 14:11", account: 29, device: "i", version: 3, chars: 155, outcome: "ok",
  loc: "current", lat: "63.06", lon: "-151.08", mode: "auto", model: "best", messages: 1,
  vars: ["temp", "wind", "snow", "gust", "rain"],
  periods: null, codecMs: null, fetchMs: null, encodeMs: null, ...over,
});

const data = (
  daily: DailyRow[],
  {
    groups = [] as StatsData["groups"],
    groupComponents = [] as StatsData["groupComponents"],
    mapPoints = [] as StatsData["mapPoints"],
    requests = [] as StatsData["requests"],
    totals = {} as Partial<StatsData["totals"]>,
    filters = {} as Partial<StatsData["filters"]>,
  } = {},
): StatsData => ({
  daily,
  requests,
  filters: {
    from: daily[0]?.day ?? "2026-08-01",
    to: daily[daily.length - 1]?.day ?? "2026-08-01",
    group: null,
    ...filters,
  },
  groups,
  groupComponents,
  mapPoints,
  totals: {
    requests: daily.reduce((n, c) => n + c.requests, 0),
    failed: 0,
    users: 0,
    avgPeriods: null,
    avgCodecMs: null,
    ...totals,
  },
});

// Count elements by matching the tag with its fill, which is what identifies a series.
const countFill = (html: string, fill: string): number =>
  html.split(`fill="${fill}"`).length - 1;

const KNOWN = "#2a78d6";

describe("formatDay", () => {
  it("formats the ISO day without going through a Date", () => {
    expect(formatDay("2026-08-07")).toBe("Aug 7");
    expect(formatDay("2026-01-01")).toBe("Jan 1");
    expect(formatDay("2026-12-31")).toBe("Dec 31");
  });
});

describe("renderStats", () => {
  it("reports an empty window instead of drawing an empty chart", () => {
    const html = renderStats(data([], { filters: { from: "2026-08-06", to: "2026-08-07" } }));
    expect(html).toContain("No requests in this window.");
    expect(html).not.toContain("<svg");
  });

  it("draws no bar for a zero day", () => {
    const html = renderStats(data(
      [cell("2026-08-05", 4), cell("2026-08-07", 6)],
      { filters: { from: "2026-08-05", to: "2026-08-07" } },
    ));
    // Three days in the window, two with traffic, so two bars — the quiet middle day
    // contributes none.
    expect(countFill(html, KNOWN)).toBe(2);
  });

  it("scales bars against the window's peak, not each day", () => {
    const html = renderStats(data([cell("2026-08-06", 5), cell("2026-08-07", 10)]));
    // The taller day must be exactly twice the shorter one — a per-day scale would draw them
    // the same height. The bar's true top is the first arc's endpoint, not the `V` before it,
    // which stops short by the corner radius.
    const heights = [...html.matchAll(/M[\d.]+ ([\d.]+)V[\d.]+A[\d.]+ [\d.]+ 0 0 1 [\d.]+ ([\d.]+)H/g)]
      .map(([, bottom, top]) => Number(bottom) - Number(top))
      .filter((h) => h > 0)
      .sort((a, b) => a - b);
    expect(heights).toHaveLength(2);
    expect(heights[1]! / heights[0]!).toBeCloseTo(2, 5);
  });

  it("describes each column in a hover title and singularises counts", () => {
    const html = renderStats(data([cell("2026-08-07", 21)]));
    expect(html).toContain("<title>Aug 7 — 21 requests</title>");
    const one = renderStats(data([cell("2026-08-07", 1)]));
    expect(one).toContain("1 request</title>");
  });

  it("shows the window totals in the summary tiles", () => {
    const html = renderStats(data(
      [cell("2026-08-06", 4), cell("2026-08-07", 6)],
      { totals: { requests: 10, users: 3, failed: 1 } },
    ));
    expect(html).toContain("<b>10</b><span>requests</span>");
    expect(html).toContain("<b>3</b><span>distinct accounts</span>");
    // Singular, because the label is read together with the number beside it.
    expect(html).toContain("<b>1</b><span>failed request</span>");
  });

  it("shows the mean periods and codec time tiles only when the window has them", () => {
    const html = renderStats(data(
      [cell("2026-08-07", 6)],
      { totals: { avgPeriods: 152, avgCodecMs: 940 } },
    ));
    expect(html).toContain("<b>152</b><span>mean periods / forecast</span>");
    expect(html).toContain("<b>940</b><span>mean codec ms</span>");
    // A window of rows older than the columns has nothing to average, and no tile.
    const without = renderStats(data([cell("2026-08-07", 6)]));
    expect(without).not.toContain("mean periods");
    expect(without).not.toContain("mean codec ms");
  });

  // A day that served nothing but failed is still a day with traffic; the empty state must not
  // claim otherwise.
  it("reports an empty window only when nothing at all happened", () => {
    const failedOnly = renderStats(data([], { totals: { failed: 2 } }));
    expect(failedOnly).not.toContain("No requests in this window");
    expect(failedOnly).toContain("<b>2</b><span>failed requests</span>");
  });

  it("keeps gridlines on whole numbers — these are counts, not measurements", () => {
    // A peak of 2 divided into four gridlines wants a step of 0.5, which would offer to measure
    // half a person.
    const html = renderStats(data([cell("2026-08-06", 2), cell("2026-08-07", 1)]));
    const axisLabels = [...html.matchAll(/text-anchor="end" font-size="10" fill="#898781">([\d.]+)</g)]
      .map(([, v]) => v!);
    expect(axisLabels.length).toBeGreaterThan(0);
    expect(axisLabels.filter((v) => v.includes("."))).toEqual([]);
  });

  it("labels the most recent day on the x axis", () => {
    const daily = Array.from({ length: 30 }, (_, i) =>
      cell(`2026-07-${String(i + 1).padStart(2, "0")}`, i + 1),
    );
    const html = renderStats(data(daily));
    expect(html).toContain(">Jul 30<");
  });
});

describe("renderStats — grouped chart", () => {
  it("stacks one series per group value with a legend", () => {
    const html = renderStats(data(
      [cell("2026-08-07", 7, "s"), cell("2026-08-07", 5, "g"), cell("2026-08-06", 3, "s")],
      { filters: { group: "device" } },
    ));
    // Biggest series takes slot 1; the legend names both by their device labels.
    expect(html).toContain("<i style=\"background:#2a78d6\"></i>SMS");
    expect(html).toContain("<i style=\"background:#eb6834\"></i>inReach");
    // The tooltip carries the total and each non-empty series on its own line.
    expect(html).toContain("<title>Aug 7 — 12 requests\nSMS: 7\ninReach: 5</title>");
  });

  it("labels groups by kind — accounts as ids, versions prefixed, nulls as ?", () => {
    const accounts = renderStats(data([cell("2026-08-07", 3, "29")], { filters: { group: "account" } }));
    expect(accounts).toContain("</i>29</span>");
    const versions = renderStats(data(
      [cell("2026-08-07", 3, "3"), cell("2026-08-07", 2, null)],
      { filters: { group: "version" } },
    ));
    expect(versions).toContain("</i>v3</span>");
    expect(versions).toContain("</i>?</span>");
  });

  it("folds groups past the palette into a gray Other", () => {
    const daily = Array.from({ length: 10 }, (_, i) => cell("2026-08-07", 10 - i, `${i + 1}`));
    const html = renderStats(data(daily, { filters: { group: "account" } }));
    expect(html).toContain(">Other</span>");
    expect(html).toContain("background:#898781");
    // Eight slots + Other = nine legend entries, not ten.
    expect(html.split("<i style=").length - 1).toBe(9);
  });

  it("shows a single unlabelled series with no legend when ungrouped", () => {
    const html = renderStats(data([cell("2026-08-07", 5)]));
    expect(html).not.toContain("class=legend");
  });

  it("lists window totals for the selected group under the chart", () => {
    const html = renderStats(data([cell("2026-08-07", 12)], {
      filters: { group: "device" },
      groups: [
        { grp: "i", requests: 8, users: 2 },
        { grp: "g", requests: 4, users: 1 },
      ],
    }));
    expect(html).toContain("By device");
    expect(html).toContain("<td>iPhone</td><td>8</td><td>2</td>");
    expect(html).toContain("<td>inReach</td><td>4</td><td>1</td>");
    // Requests sum across groups; accounts are the window's distinct count, not a sum.
    expect(html).toContain("<tfoot><tr><td>Total</td><td>12</td><td>0</td></tr></tfoot>");
  });

  it("shows no group table when the chart is ungrouped", () => {
    const html = renderStats(data([cell("2026-08-07", 12)], {
      groups: [{ grp: "", requests: 12, users: 3 }],
    }));
    expect(html).not.toContain("<th>Requests</th><th>Accounts</th>");
  });

  it("relabels the quantity under the variable grouping and lists family components", () => {
    const html = renderStats(data(
      [cell("2026-08-07", 5, "clouds"), cell("2026-08-07", 3, "aqi")],
      {
        filters: { group: "variable" },
        groups: [{ grp: "clouds", requests: 5, users: 2 }, { grp: "aqi", requests: 3, users: 1 }],
        groupComponents: [
          { grp: "clouds", component: "cch", count: 5 },
          { grp: "clouds", component: "ccm", count: 5 },
          { grp: "aqi", component: "aq_pm25", count: 3 },
          { grp: "aqi", component: "aqi", count: 2 },
        ],
      },
    ));
    // A request can sit in several families, so the stack's unit is variable requests.
    expect(html).toContain("<title>Aug 7 — 8 variable requests\nclouds: 5\nAQI: 3</title>");
    expect(html).toContain("By variable");
    // The family row carries the distinct-request count; its components follow, indented.
    expect(html).toContain("<tr><td>AQI</td><td>3</td><td>1</td></tr><tr class=quiet><td class=comp>aq_pm25</td><td>3</td><td></td></tr>");
    expect(html).toContain("<td class=comp>cch</td><td>5</td>");
  });

  // The shape columns are untrusted input (dispatch.ts); a compromised codec must not be able
  // to put markup on this page.
  it("escapes shape strings on the way into the markup", () => {
    const html = renderStats(data(
      [cell("2026-08-07", 1, "<script>alert(1)</script>")],
      {
        filters: { group: "mode" },
        groups: [{ grp: "<script>alert(1)</script>", requests: 1, users: 1 }],
      },
    ));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderStats — recent requests", () => {
  it("lists rows with named or coordinate locations and opt-in variables only", () => {
    const html = renderStats(data([cell("2026-08-07", 2)], {
      requests: [
        row({ id: 55, time: "8/30 14:11", account: 29, device: "i", version: 3, loc: "summit",
              lat: "63.07", lon: "-151.00", mode: "auto", model: "best", messages: 2, chars: 288,
              vars: ["temp", "wind", "freeze", "cch", "ccm", "aq_o3", "w500"],
              periods: { "1": 130, "3": 56 }, codecMs: 1037, fetchMs: 1015, encodeMs: 18 }),
        row({ id: 54, time: "8/29 09:02", account: 12, device: "s", version: 2, loc: "current",
              lat: "47.62", lon: "-122.29", mode: "detail", model: "eu", messages: null,
              chars: null, vars: ["temp"] }),
      ],
    }));
    expect(html).toContain("Recent requests");
    // Components fold to their families, deduplicated: cch+ccm are one clouds entry. Periods
    // show the total with the resolution split in the title; codec ms carries its own split.
    expect(html).toContain(
      "<td>55</td><td>8/30 14:11</td><td>29</td><td>iPhone</td><td>3</td><td>summit</td>" +
      "<td>auto</td><td>best</td><td>2</td><td>288</td>" +
      `<td title="1h×130, 3h×56">186</td><td title="fetch 1015, encode 18 ms">1037</td>` +
      "<td>freeze, clouds, AQI, wind</td>");
    // 'current' is not a name; the coordinates stand in, and all-default vars leave the cell
    // empty, as do the periods/timing columns the row predates.
    expect(html).toContain(
      "<td>54</td><td>8/29 09:02</td><td>12</td><td>SMS</td><td>2</td><td>47.62, -122.29</td>" +
      "<td>detail</td><td>eu</td><td></td><td></td><td></td><td></td><td></td>");
  });

  // A failure has no shape: every codec-reported cell is empty, and the outcome says why.
  it("renders a failed request's shape cells empty and its outcome loud", () => {
    const html = renderStats(data([cell("2026-08-07", 1)], {
      requests: [row({ device: null, loc: null, lat: null, lon: null, mode: null, model: null,
                       messages: null, chars: null, vars: [], outcome: "unsupported_version" })],
    }));
    expect(html).toContain("<td>unsupported_version</td>");
    expect(html).not.toContain("<td>iPhone</td>");
  });

  it("says when nothing has been recorded rather than dropping the sections", () => {
    const html = renderStats(data([cell("2026-08-07", 1)]));
    expect(html).toContain("No requests in the window");
    expect(html).toContain("No locations recorded");
  });
});
