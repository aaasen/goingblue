// Shared by record-shot.mts, seed-shots.mts and test/shot-fixtures.test.ts: the fixture file
// format, the request text a shot sends, its replay through the codec server, and the
// AsyncStorage files that put the result into the app.
//
// The codec server is imported by path rather than served: the whole pipeline runs in-process
// with fetch intercepted (to record) or stubbed (to replay), the same way the golden corpus is
// recorded and checked in packages/codec-server.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL_BIT, MODE_AUTO, MODE_DETAIL, MODE_NAMES, MODE_RANGE, WIRE_HEADER_CHARS, WIRE_VERSION,
  reassembleReply, varGroupCodesFor, windLevelsToken, wireCodec, type RequestContext,
} from '@weather/protocol';
import { fetchForecast, parseRequest, splitReplyFor, type ForecastParams } from '../../codec-server/src/forecast.js';
import { offsetHoursAt } from '../timezone';
import { SEED_SETTINGS, SEED_TOKEN, SHOTS, type Shot } from '../screenshots/shots.mjs';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots', 'fixtures');

export interface FixtureRequest {
  // The request exactly as the app would send it, `k:` and `t:` included.
  request: string;
  // Open-Meteo responses, base64 bytes keyed by path+query with the origin stripped, so replay
  // is independent of the upstream base URL.
  responses: Record<string, string>;
}

export interface ShotFixture {
  shot: string;
  recordedAt: string;
  // Informational: replay re-encodes under whichever version is current.
  protocolVersion: number;
  requests: FixtureRequest[];
}

const MODE_TOKEN: Record<number, string> = { [MODE_DETAIL]: 'd', [MODE_AUTO]: 'a', [MODE_RANGE]: 'r' };

export function fixturePath(shot: string): string {
  return join(FIXTURE_DIR, `${shot}.json`);
}

export function shotByName(name: string): Shot {
  const shot = SHOTS.find((s) => s.name === name);
  if (!shot) throw new Error(`unknown shot "${name}" (have: ${SHOTS.map((s) => s.name).join(', ')})`);
  return shot;
}

// The message code a shot's request goes out under: its position across the whole table, so no
// two seeded slots share one. Recorded into the request text, so it survives a later reorder of
// the table until that shot is re-recorded.
export function requestCode(shot: Shot, index: number): number {
  let code = 0;
  for (const s of SHOTS) {
    if (s === shot) return code + index;
    code += s.requests.length;
  }
  throw new Error(`shot "${shot.name}" is not in SHOTS`);
}

// Mirrors HomeScreen's buildMsg token for token; the server parses this back into the context
// the app would have stored, which is what seedSlot recovers.
export function requestText(shot: Shot, index: number, startEpochHour: number): string {
  const { model, vars } = shot.requests[index];
  const allVars = new Set(vars);
  const parts = [`v${WIRE_VERSION}`, `${shot.lat.toFixed(4)},${shot.lon.toFixed(4)}`];
  parts.push(`p:${MODE_TOKEN[shot.mode]}`);
  parts.push(`z:${offsetHoursAt(shot.lat, shot.lon, startEpochHour * 3600000)}`);
  parts.push(`m:${model}`);
  const groupCodes = varGroupCodesFor(allVars);
  if (groupCodes) parts.push(`v:${groupCodes}`);
  const windLevels = windLevelsToken(allVars);
  if (windLevels) parts.push(`w:${windLevels}`);
  parts.push(`d:${shot.device}`);
  if (shot.messages > 1) parts.push(`n:${shot.messages}`);
  parts.push(`u:${SEED_TOKEN}`);
  parts.push(`k:${requestCode(shot, index)}`);
  parts.push(`t:${startEpochHour}`);
  return parts.join(' ');
}

export function upstreamKey(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '');
}

export function loadFixtures(): ShotFixture[] {
  if (!existsSync(FIXTURE_DIR)) return [];
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as ShotFixture);
}

// One request through the pipeline with fetch serving the recorded bytes. A URL the current
// codec asks for that the recording lacks is the one legitimate reason to re-record a shot, so
// it fails by name instead of falling through to a live fetch.
export async function replay(fixture: ShotFixture, entry: FixtureRequest): Promise<{ params: ForecastParams; wire: string }> {
  const params = parseRequest(entry.request);
  if (params.errors.length) throw new Error(`${fixture.shot}: request rejected: ${params.errors.join('; ')}`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const key = upstreamKey(String(input));
    const body = entry.responses[key];
    if (body === undefined) throw new Error(`${fixture.shot}: unrecorded upstream request ${key} (re-record this shot)`);
    return new Response(Buffer.from(body, 'base64'), { status: 200 });
  }) as typeof fetch;
  try {
    const { encoded } = await fetchForecast(params, wireCodec);
    return { params, wire: splitReplyFor(params, encoded, wireCodec.headerChars).join('\n') };
  } finally {
    globalThis.fetch = realFetch;
  }
}

// Moves a recorded start forward by whole days to the last such instant at or before `now`.
// Whole days keep the local hour, and with it the period layout the decoder rebuilds from the
// stored context; only the calendar date moves.
export function rebaseStart(recordedMs: number, nowMs: number): number {
  const DAY = 86400000;
  const days = Math.floor((nowMs - recordedMs) / DAY);
  return recordedMs + Math.max(0, days) * DAY;
}

// The persisted shape of a cache.ts Slot: vars as an array, everything else as stored.
export interface SeedSlot {
  code: number;
  context: Omit<RequestContext, 'vars'> & { vars: string[] };
  label: string;
  requestedAt: number;
  encoded: string;
  savedAt: number;
}

// What the app would have stored for this request had it sent it, the reply attached the way
// attachResponse does (reassembled, not split), and the date rebased to `nowMs`.
export function seedSlot(params: ForecastParams, wire: string, nowMs: number): SeedSlot {
  const mask = params.modelsMask;
  const model = Math.log2(mask & -mask);
  const modelName = Object.keys(MODEL_BIT).find((k) => MODEL_BIT[k] === model) ?? 'BEST';
  const start = rebaseStart(params.startEpochHour * 3600000, nowMs);
  return {
    code: params.code,
    context: {
      mode: params.mode,
      utcOffsetHours: params.utcOffsetHours,
      model,
      vars: [...params.vars],
      lat: params.lat!,
      lon: params.lon!,
      start,
      device: params.device,
    },
    label: `${MODE_NAMES[params.mode]} · ${modelName}`,
    // Minutes after the hour by code, so the past list (newest first) orders the slots the way
    // the table does rather than by a tie.
    requestedAt: start + (5 + params.code) * 60000,
    encoded: reassembleReply(wire, () => WIRE_HEADER_CHARS),
    savedAt: start + (10 + params.code) * 60000,
  };
}

export const STORE_KEY = `forecast_store_v1:${SEED_TOKEN}`;

// Every AsyncStorage key → value for a seeded install.
export function seedEntries(slots: SeedSlot[]): Record<string, string> {
  const codes = new Set<number>();
  for (const s of slots) {
    if (codes.has(s.code)) throw new Error(`two seeded requests share message code ${s.code}`);
    codes.add(s.code);
  }
  return {
    user_token: SEED_TOKEN,
    ...SEED_SETTINGS,
    [STORE_KEY]: JSON.stringify({ nextCode: (Math.max(-1, ...codes) + 1) % 128, slots }),
  };
}

// The files AsyncStorage keeps on iOS: manifest.json holds every key, with values up to the
// inline threshold stored in place and larger ones as null pointing at a sibling file named by
// the MD5 of the key. Returns filename → content.
export const INLINE_VALUE_THRESHOLD = 1024;

export function storageFiles(entries: Record<string, string>): Map<string, string> {
  const files = new Map<string, string>();
  const manifest: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value.length <= INLINE_VALUE_THRESHOLD) {
      manifest[key] = value;
    } else {
      manifest[key] = null;
      files.set(createHash('md5').update(key, 'utf8').digest('hex'), value);
    }
  }
  files.set('manifest.json', JSON.stringify(manifest));
  return files;
}

// Fixtures → the files, end to end. `now` is what the dates rebase to.
export async function buildSeed(fixtures: ShotFixture[], nowMs: number): Promise<Map<string, string>> {
  const slots: SeedSlot[] = [];
  for (const fixture of fixtures) {
    for (const entry of fixture.requests) {
      const { params, wire } = await replay(fixture, entry);
      slots.push(seedSlot(params, wire, nowMs));
    }
  }
  return storageFiles(seedEntries(slots));
}
