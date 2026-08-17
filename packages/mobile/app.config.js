// Dynamic Expo config, overlaid on app.json. The development and preview EAS profiles (and any
// local prebuild/run with APP_VARIANT set) get their own bundle ID, Android package and name, so
// those builds can be installed alongside the TestFlight/store app — both platforms identify apps
// by that ID, so with a shared one install replaces the other.
const VARIANTS = {
  development: { suffix: ".dev", label: "Dev" },
  preview: { suffix: ".preview", label: "Preview" },
};

const variant = VARIANTS[process.env.APP_VARIANT];

module.exports = ({ config }) => ({
  ...config,
  name: variant ? `${config.name} ${variant.label}` : config.name,
  ios: {
    ...config.ios,
    bundleIdentifier: variant
      ? `${config.ios.bundleIdentifier}${variant.suffix}`
      : config.ios.bundleIdentifier,
  },
  android: {
    ...config.android,
    package: variant
      ? `${config.android.package}${variant.suffix}`
      : config.android.package,
  },
});
