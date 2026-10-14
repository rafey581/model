// Metro configuration for this Expo app inside a pnpm workspace.
//
// Expo's default config only looks inside the app folder. In a monorepo the
// packages it depends on live at the workspace root, so Metro has to watch and
// resolve there too: watch the whole workspace and add both node_modules roots.
//
// Hierarchical lookup is deliberately left ON. Expo's monorepo guide turns it off,
// but that guidance assumes a hoisted (npm/yarn-style) node_modules. pnpm keeps a
// package's dependencies beside it in the virtual store, and with the walk-up
// disabled Metro cannot see them ("unable to resolve whatwg-fetch" out of
// @expo/metro-runtime is the symptom).
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules')
]

module.exports = config
