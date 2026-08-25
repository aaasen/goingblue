import { Asset } from 'expo-asset';
import { Directory, File, Paths } from 'expo-file-system';
import { unzipSync } from 'fflate';

// The map's glyphs (Noto Sans Regular / Medium / Italic as 256-codepoint pbf ranges), shipped in
// the binary as one zip and unpacked once to Documents so labels render on a cold offline start —
// hosted glyphs only cover ranges MapLibre happened to cache. The unpack re-runs when the shipped
// zip changes (the asset hash is stamped next to the files); the style falls back to the hosted
// set if it fails, which costs nothing but the offline cold-start coverage.
//
// The directory names keep their spaces: MapLibre percent-encodes {fontstack} into the request
// URL and the file loader decodes it back before touching the filesystem.

const FONTS_ZIP = require('./assets/basemap/fonts.zip');

export async function ensureGlyphs(): Promise<string> {
  const dir = new Directory(Paths.document, 'glyphs');
  const stamp = new File(dir, '.version');
  const asset = Asset.fromModule(FONTS_ZIP);
  const version = asset.hash ?? 'unhashed';
  if (stamp.exists && stamp.textSync() === version) return dir.uri;

  await asset.downloadAsync();
  if (!asset.localUri) throw new Error('fonts.zip did not resolve');
  const files = unzipSync(await new File(asset.localUri).bytes());
  if (dir.exists) dir.delete();
  dir.create({ intermediates: true });
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith('.pbf')) continue; // directory entries
    const [face, range] = name.split('/');
    const faceDir = new Directory(dir, face);
    if (!faceDir.exists) faceDir.create();
    const out = new File(faceDir, range);
    out.write(bytes);
  }
  stamp.write(version);
  return dir.uri;
}
