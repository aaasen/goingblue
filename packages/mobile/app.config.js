// Dynamic Expo config, overlaid on app.json. The development EAS profile (and any local
// prebuild/run with APP_VARIANT=development) gets its own bundle ID and name so a dev-client
// build can be installed alongside the TestFlight app — iOS identifies apps by bundle ID, so
// with a shared ID one install replaces the other.
const IS_DEV = process.env.APP_VARIANT === "development";

module.exports = ({ config }) => ({
  ...config,
  name: IS_DEV ? "Going Blue Dev" : config.name,
  ios: {
    ...config.ios,
    bundleIdentifier: IS_DEV
      ? `${config.ios.bundleIdentifier}.dev`
      : config.ios.bundleIdentifier,
  },
});
