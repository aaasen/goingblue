const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

// Opts the Android app into constrained satellite networks. The value is the app's own package,
// which differs between the dev, preview and store builds, so it is read from the config.
module.exports = function withSatelliteDataOptimized(config) {
  return withAndroidManifest(config, (mod) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      app,
      'android.telephony.PROPERTY_SATELLITE_DATA_OPTIMIZED',
      mod.android.package,
    );
    return mod;
  });
};
