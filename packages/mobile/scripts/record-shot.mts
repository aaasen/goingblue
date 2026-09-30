// Records one screenshot shot's weather: sends each of its requests through the codec server
// against the live Open-Meteo API and keeps the raw upstream bytes, so seed-shots.mts can
// replay them under any later codec version without the weather changing.
//
//   pnpm record-shot denali             # from packages/mobile
//   pnpm record-shot denali eldorado-peak
//   pnpm record-shot --all
//
// Run it when the weather at the location suits the shot; each shot records on its own day and
// keeps that date through the seed. Re-recording replaces only the named shots' files. Commit
// the fixture afterward.
import { mkdirSync, writeFileSync } from 'node:fs';
import { WIRE_VERSION } from '@weather/protocol';
import { SHOTS, isAvalancheShot, requestCount } from '../screenshots/shots.mjs';
import { FIXTURE_DIR, encodeReply, fixturePath, requestText, shotByName, upstreamKey, type FixtureRequest, type ShotFixture } from './shot-fixtures.mjs';
import { parseRequest } from '../../codec-server/src/forecast.js';

const args = process.argv.slice(2);
const shots = args.includes('--all') ? SHOTS : args.map(shotByName);
if (shots.length === 0) {
  console.error('usage: record-shot <shot>... | --all');
  process.exit(1);
}

const realFetch = globalThis.fetch;
let recording: Record<string, string> = {};
// Record by interception so the kept bytes are exactly what the pipeline consumed.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const resp = await realFetch(input as never, init as never);
  // A failed upstream call would record a hole the pipeline papers over (an agreement center
  // quietly dropped), and replay would reproduce the hole forever. Better to stop and rerun.
  if (!resp.ok) throw new Error(`upstream ${resp.status} for ${upstreamKey(String(input))}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  recording[upstreamKey(String(input))] = Buffer.from(bytes).toString('base64');
  return new Response(bytes, { status: resp.status });
}) as typeof fetch;

const startEpochHour = Math.floor(Date.now() / 3600000);
mkdirSync(FIXTURE_DIR, { recursive: true });

for (const shot of shots) {
  const requests: FixtureRequest[] = [];
  for (let i = 0; i < requestCount(shot); i++) {
    // An avalanche shot is requested on its bulletin's day, at the hour the codec anchors `y:` to,
    // so the app dates it with the bulletin rather than with the recording.
    const hour = isAvalancheShot(shot) ? Date.parse(`${shot.day}T19:00:00Z`) / 3600000 : startEpochHour;
    const request = requestText(shot, i, hour);
    const params = parseRequest(request);
    if (params.errors.length) throw new Error(`${shot.name}: ${params.errors.join('; ')}\n  ${request}`);
    recording = {};
    const parts = await encodeReply(params);
    requests.push({ request, responses: recording });
    const what = isAvalancheShot(shot) ? `y:${shot.day}` : `m:${shot.requests[i].model}`;
    console.log(`${shot.name} ${what}: ${parts.length} message(s), ${Object.keys(recording).length} upstream responses`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const fixture: ShotFixture = { shot: shot.name, recordedAt: new Date().toISOString(), protocolVersion: WIRE_VERSION, requests };
  writeFileSync(fixturePath(shot.name), JSON.stringify(fixture, null, 1));
  console.log(`wrote ${fixturePath(shot.name)}`);
}
