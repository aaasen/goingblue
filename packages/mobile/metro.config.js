const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Let Metro watch the whole monorepo so it can find workspace packages
config.watchFolders = [workspaceRoot];

// Resolve node_modules from both the app root and the workspace root,
// so pnpm-hoisted packages (react, react-native, etc.) are found correctly
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
