const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Let Metro watch the whole monorepo so it can find workspace packages
config.watchFolders = [workspaceRoot];

// ...but not the corpus. data/ holds the SQLite corpus (tens of GB, WAL mode) plus generated
// benchmark reports, and Metro doesn't read .gitignore — it crawls and watches whatever is under
// watchFolders. A running collect commits to corpus.db-wal every few seconds, and each write
// looks to Metro like a source change, so the app reloads on a loop while the pull runs. Nothing
// under data/ is importable, so blocking it costs nothing and also keeps Metro from stat-ing a
// 30 GB file at startup. Anchored to the workspace root so a `data/` directory inside some
// package's node_modules is unaffected.
const escapedRoot = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
config.resolver.blockList = [new RegExp(`^${escapedRoot}/data/`)];

// The bundled basemap archives (assets/basemap) ship as binary assets.
config.resolver.assetExts.push('pmtiles');

// Resolve node_modules from both the app root and the workspace root,
// so pnpm-hoisted packages (react, react-native, etc.) are found correctly
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
