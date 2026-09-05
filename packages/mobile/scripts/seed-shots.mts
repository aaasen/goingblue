// Loads the screenshot set into a simulator: replays every recorded shot through the current
// codec, builds the app's AsyncStorage files, and drops them into the installed app's data
// container. The app itself knows nothing about this; on the next launch it finds an account
// and a past-forecast list the way it would after a week of use.
//
//   pnpm seed-shots                      # from packages/mobile; the booted simulator
//   pnpm seed-shots --device "iPhone 17 Pro Max"
//   pnpm seed-shots --bundle com.laneaasen.weather.dev
//   pnpm seed-shots --out /some/dir      # write the files there instead of a simulator
//
// The app must already be installed on the target; install it with `npx expo run:ios`. The
// forecasts keep their recorded dates.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSeed, loadFixtures } from './shot-fixtures.mjs';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
const device = option('--device') ?? 'booted';
const bundle = option('--bundle') ?? 'com.laneaasen.weather';
const outDir = option('--out');

const fixtures = loadFixtures();
if (fixtures.length === 0) {
  console.error('no fixtures recorded yet: run `pnpm record-shot --all` first');
  process.exit(1);
}
const files = await buildSeed(fixtures);
console.log(`${fixtures.length} shot(s), ${fixtures.reduce((n, f) => n + f.requests.length, 0)} forecast(s)`);

function simctl(...cmd: string[]): string {
  return execFileSync('xcrun', ['simctl', ...cmd], { encoding: 'utf8' }).trim();
}

let dir: string;
if (outDir) {
  dir = outDir;
} else {
  const container = simctl('get_app_container', device, bundle, 'data');
  dir = join(container, 'Library', 'Application Support', bundle, 'RCTAsyncLocalStorage_V1');
  // Not running during the write: AsyncStorage reads the manifest once and writes it back after
  // every mutation, so a live app would overwrite the seed with its own copy.
  try { simctl('terminate', device, bundle); } catch { /* not running */ }
}

// Replace the whole directory: a key the seed does not name must not linger from a previous
// install, and an overflow file for a value that is now inline would shadow it.
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true });
for (const [name, content] of files) writeFileSync(join(dir, name), content);
console.log(`wrote ${files.size} file(s) to ${dir}`);

if (!outDir) {
  simctl('launch', device, bundle);
  console.log(`launched ${bundle} on ${device}`);
}
