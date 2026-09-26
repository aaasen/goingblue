import { describe, it, expect } from "vitest";
import { dayStart, toForecast, weatherPeriods, type RawProduct } from "../src/avcan.ts";

describe("weatherPeriods", () => {
  it("splits bold headings inside one paragraph and drops the trailing link", () => {
    const html = '<p><strong>Saturday Night</strong><br>Clear. 20 km/h wind.<br><br><strong>Sunday</strong><br>Sunny.<br><br><br></p> '
      + '<p>More details can be found in the <a href="https://www.avalanche.ca/weather/forecast">Mountain Weather Forecast</a>.</p>';
    expect(weatherPeriods(html)).toEqual([
      { label: "Saturday Night", text: "Clear. 20 km/h wind." },
      { label: "Sunday", text: "Sunny." },
    ]);
  });

  it("takes one heading per paragraph, strips the colon, and appends unheaded paragraphs", () => {
    const html = "<p><strong>Saturday:</strong> Mixed sun and cloud.</p><p><strong>Sunday: </strong>Flurries.</p><p>A warming trend follows Monday.</p>";
    expect(weatherPeriods(html)).toEqual([
      { label: "Saturday", text: "Mixed sun and cloud." },
      { label: "Sunday", text: "Flurries.\n\nA warming trend follows Monday." },
    ]);
  });

  it("keeps unheaded prose as one unlabeled period and drops lone links", () => {
    const html = '<p>Cloudy with flurries.</p><p><a href="https://example.org/table">https://example.org/table</a></p>';
    expect(weatherPeriods(html)).toEqual([{ label: "", text: "Cloudy with flurries." }]);
    expect(weatherPeriods(null)).toEqual([]);
  });
});

describe("dayStart", () => {
  it("finds local midnight in a zone west of UTC", () => {
    // 2026-03-02T00:00Z is Sunday March 1 at 16:00 in Vancouver.
    expect(dayStart(Date.parse("2026-03-02T00:00:00Z"), "America/Vancouver")).toBe(Date.parse("2026-03-01T08:00:00Z"));
  });

  it("holds on the day the clocks change", () => {
    // Vancouver springs forward at 02:00 on 2026-03-08; midnight is still at UTC-8.
    expect(dayStart(Date.parse("2026-03-09T00:00:00Z"), "America/Vancouver")).toBe(Date.parse("2026-03-08T08:00:00Z"));
    // Halifax falls back on 2025-11-02; midnight is at UTC-3, the evening at UTC-4.
    expect(dayStart(Date.parse("2025-11-02T22:00:00Z"), "America/Halifax")).toBe(Date.parse("2025-11-02T03:00:00Z"));
  });
});

const RAW: RawProduct = {
  id: "x",
  owner: { value: "avalanche-canada" },
  report: {
    title: "Somewhere",
    dateIssued: "2026-03-01T00:00:00Z",
    validUntil: "2026-03-02T00:00:00Z",
    timezone: "America/Vancouver",
    highlights: "<p>Tricky.</p>",
    confidence: { rating: { value: "low" }, statements: ["We are uncertain."] },
    summaries: [
      { type: { value: "avalanche-summary" }, content: "<p>None seen.</p>" },
      { type: { value: "snowpack-summary" }, content: "<p>Deep.</p>" },
      { type: { value: "weather-summary" }, content: "<p><strong>Sunday</strong><br>Sunny.</p>" },
    ],
    dangerRatings: [{
      date: { value: "2026-03-02T00:00:00Z" },
      ratings: { alp: { rating: { value: "considerable" } }, tln: { rating: { value: "moderate" } }, btl: { rating: { value: "norating" } } },
    }],
    problems: [{
      type: { value: "windslab" },
      comment: "<p>Reactive.</p>",
      data: {
        elevations: [{ value: "alp" }, { value: "tln" }],
        aspects: [{ value: "nw" }, { value: "n" }, { value: "e" }],
        likelihood: { value: "likely_possible" },
        expectedSize: { min: "1.0", max: "2.5" },
      },
    }],
    terrainAndTravelAdvice: ["Go easy."],
  },
};

describe("toForecast", () => {
  it("maps the feed onto the protocol's scales", () => {
    const f = toForecast(RAW);
    expect(f.center).toBe("avalanche-canada");
    expect(f.danger).toEqual([{ date: Date.parse("2026-03-01T08:00:00Z"), btl: "noRating", tln: "moderate", alp: "considerable" }]);
    expect(f.problems).toEqual([{
      type: "windSlab", elevations: ["tln", "alp"], aspects: ["n", "e", "nw"],
      likelihood: "possible-likely", size: { min: 1, max: 2.5 }, description: "Reactive.",
    }]);
    expect(f.weather).toEqual([{ label: "Sunday", text: "Sunny." }]);
    expect(f.confidence).toEqual({ rating: "low", statements: ["We are uncertain."] });
    expect(f.bottomLine).toBe("Tricky.");
    expect(f.advice).toEqual(["Go easy."]);
  });

  it("reduces advice HTML to text", () => {
    const raw = structuredClone(RAW);
    raw.report.terrainAndTravelAdvice = ["Avoid <strong>steep</strong> slopes &amp; cornices."];
    expect(toForecast(raw).advice).toEqual(["Avoid steep slopes & cornices."]);
  });

  it("refuses a value outside the scales", () => {
    const bad = structuredClone(RAW);
    bad.report.problems![0].type.value = "glacier";
    expect(() => toForecast(bad)).toThrow(/problem type/);
  });
});
