import { describe, it, expect } from "vitest";
import { displayedDate, toForecast, weatherPeriods, type RawProduct } from "../src/avcan.ts";

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

describe("displayedDate", () => {
  it("dates a day by its displayed weekday, not the UTC date of its instant", () => {
    // 2026-03-02T00:00Z is Sunday March 1 at 16:00 in Vancouver.
    expect(displayedDate("2026-03-02T00:00:00Z", "Sunday")).toBe("2026-03-01");
    expect(displayedDate("2026-03-01T23:00:00Z", "Sunday")).toBe("2026-03-01");
    expect(displayedDate("2026-03-02T00:00:00Z", "Monday")).toBe("2026-03-02");
  });

  it("rejects a display that is not a weekday", () => {
    expect(() => displayedDate("2026-03-02T00:00:00Z", "Someday")).toThrow(/unknown danger day/);
  });
});

const RAW: RawProduct = {
  id: "x",
  area: { id: "a" },
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
      date: { value: "2026-03-02T00:00:00Z", display: "Sunday" },
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
    const f = toForecast(RAW, []);
    expect(f.center).toBe("avalanche-canada");
    expect(f.danger).toEqual([{ date: "2026-03-01", btl: "noRating", tln: "moderate", alp: "considerable" }]);
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
    expect(toForecast(raw, []).advice).toEqual(["Avoid steep slopes & cornices."]);
  });

  it("refuses a value outside the scales", () => {
    const bad = structuredClone(RAW);
    bad.report.problems![0].type.value = "glacier";
    expect(() => toForecast(bad, [])).toThrow(/problem type/);
  });
});
