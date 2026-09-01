import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wireCodec, WIRE_VERSION } from "@weather/protocol";
import { fetchForecast, parseRequest, splitReplyFor } from "../src/forecast.js";

// Bit-exactness guard for the CURRENT protocol version: replays the recorded Open-Meteo
// responses through the full pipeline (parse → aggregate → fill search → encode) and asserts
// byte-identical output. Once this version has deployed clients, a failure here means the
// change would break phones in the field — it belongs to the next protocol version, not this
// one (VERSIONING.md). Record with scripts/record-goldens.ts at ship time; the file is absent
// (and this suite skipped) only before the version has shipped, and the goldens are deleted
// along with the version when it moves into its frozen container.
const GOLDEN_PATH = fileURLToPath(new URL("./golden/goldens.json", import.meta.url));

interface GoldenCase {
  name: string;
  request: string;
  responses: Record<string, string>; // base64 FlatBuffers bodies, keyed by path+query
  encoded: string; // the wire reply as /encode returns it: splitReplyFor(...).join("\n")
}

const goldens = existsSync(GOLDEN_PATH)
  ? (JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as { protocolVersion: number; cases: GoldenCase[] })
  : null;

describe.skipIf(!goldens)("golden corpus (bit-exact encode)", () => {
  afterEach(() => vi.unstubAllGlobals());

  for (const c of goldens?.cases ?? []) {
    it(c.name, async () => {
      // Serve exactly the recorded responses; any URL the pipeline asks for that wasn't
      // recorded is itself a behavior change (different fetch parameters), so fail loudly.
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const key = String(input).replace(/^https?:\/\/[^/]+/, "");
        const body = c.responses[key];
        if (body === undefined) throw new Error(`golden ${c.name}: unrecorded upstream request ${key}`);
        return new Response(Buffer.from(body, "base64"), { status: 200 });
      });

      const params = parseRequest(c.request);
      expect(goldens!.protocolVersion).toBe(WIRE_VERSION);
      expect(params.decoderVersion).toBe(goldens!.protocolVersion);
      // Compare the WIRE text — post-split, newline-joined, the same construction the codec
      // server's /encode returns and verify-container diffs — so the split boundaries and part
      // labels are bit-frozen along with the encoding.
      const { encoded, periods } = await fetchForecast(params, wireCodec);
      expect(splitReplyFor(params, encoded, wireCodec.headerChars).join("\n")).toBe(c.encoded);
      // The tracking side of the result: every reply carries at least one period, and every
      // bucket key is an hours-per-period count.
      const total = Object.values(periods).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(0);
      for (const hours of Object.keys(periods)) expect(Number(hours)).toBeGreaterThan(0);
    });
  }
});
