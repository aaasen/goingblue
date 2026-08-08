import { describe, expect, it } from "vitest";
import { formatDay, renderStats, type StatsData, type StatsRow } from "../src/stats.js";

// Rendering is pure, so every case here feeds rows straight in — no Postgres, matching the rest
// of the server tests. Assertions are on structure and numbers rather than exact markup, so
// restyling the page doesn't break them.

const row = (day: string, requests: number, users: number, anon: number): StatsRow =>
  ({ day, requests, users, anon });

const data = (rows: StatsRow[], days = rows.length): StatsData => ({
  rows,
  days,
  totals: {
    requests: rows.reduce((n, r) => n + r.requests, 0),
    // Deliberately not the sum of daily users: over a real window the query counts distinct
    // tokens once. The fixture keeps it simple by using the largest day.
    users: Math.max(0, ...rows.map((r) => r.users)),
    anon: rows.reduce((n, r) => n + r.anon, 0),
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
    expect(html).toContain("<td>Aug 6</td><td>0</td><td>0</td><td>0</td>");
  });

  it("puts requests, accounts and anonymous in their own columns", () => {
    const html = renderStats(data([row("2026-08-07", 21, 5, 16)]));
    expect(html).toContain("<td>Aug 7</td><td>21</td><td>5</td><td>16</td>");
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
    const html = renderStats(data([row("2026-08-07", 21, 5, 16)]));
    expect(html).toContain("<title>Aug 7 — 21 requests (5 from accounts, 16 anonymous)</title>");
    expect(html).toContain("<title>Aug 7 — 5 accounts</title>");
  });

  it("singularises counts in the tooltips", () => {
    const html = renderStats(data([row("2026-08-07", 1, 1, 0)]));
    expect(html).toContain("1 request (1 from accounts, 0 anonymous)");
    expect(html).toContain("1 account<");
  });

  it("shows window totals rather than a sum of daily distinct users", () => {
    const html = renderStats(data([row("2026-08-06", 4, 3, 1), row("2026-08-07", 6, 3, 2)]));
    expect(html).toContain("<b>10</b><span>requests</span>");
    expect(html).toContain("<b>3</b><span>distinct accounts</span>");
    expect(html).toContain("<b>3</b><span>anonymous requests</span>");
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
