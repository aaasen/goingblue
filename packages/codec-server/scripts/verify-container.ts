/**
 * Verifies a running codec container is bit-identical to the golden corpus — the green light
 * for swapping in a REBUILT frozen image (base-image CVE, dependency patch, upstream shape
 * fix; see VERSIONING.md). Serves the recorded Open-Meteo responses from a local fixture
 * server, POSTs every golden request to the container's /encode, and diffs the exact bytes.
 *
 *   node scripts/verify-container.ts --codec-url http://localhost:9090 [--port 8199]
 *
 * Start the container under test with its upstream pointed at this script, e.g.:
 *   docker run -p 9090:8081 -e OPEN_METEO_BASE_URL=http://host.docker.internal:8199 codec:v1
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "codec-url": { type: "string" },
    port: { type: "string", default: "8199" },
  },
});
const codecUrl = values["codec-url"];
if (!codecUrl) {
  console.error("usage: node scripts/verify-container.ts --codec-url <url> [--port 8199]");
  process.exit(2);
}

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "golden", "goldens.json");
const goldens = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
  protocolVersion: number;
  cases: { name: string; request: string; responses: Record<string, string>; encoded: string }[];
};

// One merged fixture map: a given path+query always carries the same recorded body (all cases
// were recorded at one instant), so collisions across cases are identical by construction. Bodies
// are the raw FlatBuffers response bytes (base64 in the golden file), served verbatim so the
// container's SDK transport decodes exactly what was recorded.
const fixtures = new Map<string, Buffer>();
for (const c of goldens.cases) {
  for (const [key, body] of Object.entries(c.responses)) fixtures.set(key, Buffer.from(body, "base64"));
}

const misses: string[] = [];
const server = createServer((req, res) => {
  const body = fixtures.get(req.url ?? "");
  if (body === undefined) {
    misses.push(req.url ?? "");
    res.writeHead(404).end("no fixture for this request");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(body);
});
await new Promise<void>((r) => server.listen(parseInt(values.port!), r));
console.log(`fixture server on :${values.port} (${fixtures.size} recorded responses)`);
console.log(`verifying ${codecUrl} against ${goldens.cases.length} golden cases (protocol v${goldens.protocolVersion})\n`);

let failures = 0;
for (const c of goldens.cases) {
  let verdict: string;
  try {
    const resp = await fetch(`${codecUrl}/encode`, { method: "POST", body: c.request });
    const encoded = await resp.text();
    if (resp.status !== 200) {
      verdict = `FAIL — HTTP ${resp.status}: ${encoded.slice(0, 120)}`;
    } else if (encoded === c.encoded) {
      verdict = "ok";
    } else {
      verdict = `FAIL — output differs\n    want ${c.encoded}\n    got  ${encoded}`;
    }
  } catch (e) {
    verdict = `FAIL — ${e}`;
  }
  if (verdict !== "ok") failures++;
  console.log(`  ${c.name}: ${verdict}`);
}

server.close();
if (misses.length) {
  failures++;
  console.error(`\nContainer requested ${misses.length} URL(s) with no fixture (its fetch parameters differ from the recording):`);
  for (const m of [...new Set(misses)]) console.error(`  ${m}`);
}
console.log(failures === 0
  ? `\nPASS: bit-identical on all ${goldens.cases.length} cases — safe to deploy.`
  : `\nFAIL: ${failures} problem(s) — do NOT deploy this image.`);
process.exit(failures === 0 ? 0 : 1);
