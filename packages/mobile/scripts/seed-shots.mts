// Loads the screenshot set into a simulator or emulator: replays every recorded shot through the
// current codec, builds the app's AsyncStorage contents, and drops them into the installed app's
// data. The app itself knows nothing about this; on the next launch it finds an account and a
// past-forecast list the way it would after a week of use.
//
//   pnpm seed-shots                      # from packages/mobile; the booted iOS simulator
//   pnpm seed-shots --device "iPhone 17 Pro Max"
//   pnpm seed-shots --bundle com.laneaasen.weather.dev
//   pnpm seed-shots --android            # the one running emulator or device (ANDROID_SERIAL
//                                        # or --device <serial> picks among several)
//   pnpm seed-shots --out /some/dir      # write the iOS files there instead of a simulator
//
// The app must already be installed on the target; install it with `npx expo run:ios` or
// `npx expo run:android`. The Android path writes through `run-as`, so the installed build must
// be debuggable (a debug or dev-client build is; a release build is not). The forecasts keep
// their recorded dates.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSeedEntries, loadFixtures, storageFiles, storageSql } from './shot-fixtures.mjs';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
const android = args.includes('--android');
const device = option('--device') ?? (android ? undefined : 'booted');
// One flag for both platforms: the iOS bundle ID and the Android package are the same string.
const bundle = option('--bundle') ?? 'com.laneaasen.weather';
const outDir = option('--out');

const fixtures = loadFixtures();
if (fixtures.length === 0) {
  console.error('no fixtures recorded yet: run `pnpm record-shot --all` first');
  process.exit(1);
}
const entries = await buildSeedEntries(fixtures);
console.log(`${fixtures.length} shot(s), ${fixtures.reduce((n, f) => n + f.requests.length, 0)} forecast(s)`);

function simctl(...cmd: string[]): string {
  return execFileSync('xcrun', ['simctl', ...cmd], { encoding: 'utf8' }).trim();
}

function adb(...cmd: string[]): string {
  const target = device ? ['-s', device] : [];
  return execFileSync('adb', [...target, ...cmd], { encoding: 'utf8' }).trim();
}

if (android) {
  // AsyncStorage on Android is one SQLite file, RKStorage, in the app's databases directory.
  // Built here with the sqlite3 CLI, pushed to a world-readable spot, then copied into place as
  // the app's own user. The journal is removed with it: a stale one would roll the new file back.
  const work = join(tmpdir(), `seed-shots-${process.pid}`);
  mkdirSync(work, { recursive: true });
  const db = join(work, 'RKStorage');
  execFileSync('sqlite3', [db], { input: storageSql(entries) });
  const remote = '/data/local/tmp/RKStorage';
  adb('shell', 'am', 'force-stop', bundle);
  adb('push', db, remote);
  // adb shell joins its arguments and the device re-parses them, so the script is quoted once.
  adb('shell', `run-as ${bundle} sh -c 'mkdir -p databases && cp ${remote} databases/RKStorage && rm -f databases/RKStorage-journal databases/RKStorage-wal databases/RKStorage-shm'`);
  adb('shell', 'rm', remote);
  rmSync(work, { recursive: true });
  console.log(`wrote ${Object.keys(entries).length} key(s) to ${bundle}'s RKStorage`);
  const activity = adb('shell', 'cmd', 'package', 'resolve-activity', '--brief', bundle).split('\n').pop()!;
  adb('shell', 'am', 'start', '-n', activity);
  console.log(`launched ${activity}`);
} else {
  const files = storageFiles(entries);
  let dir: string;
  if (outDir) {
    dir = outDir;
  } else {
    const container = simctl('get_app_container', device!, bundle, 'data');
    dir = join(container, 'Library', 'Application Support', bundle, 'RCTAsyncLocalStorage_V1');
    // Not running during the write: AsyncStorage reads the manifest once and writes it back after
    // every mutation, so a live app would overwrite the seed with its own copy.
    try { simctl('terminate', device!, bundle); } catch { /* not running */ }
  }

  // Replace the whole directory: a key the seed does not name must not linger from a previous
  // install, and an overflow file for a value that is now inline would shadow it.
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true });
  for (const [name, content] of files) writeFileSync(join(dir, name), content);
  console.log(`wrote ${files.size} file(s) to ${dir}`);

  if (!outDir) {
    simctl('launch', device!, bundle);
    console.log(`launched ${bundle} on ${device}`);
  }
}
