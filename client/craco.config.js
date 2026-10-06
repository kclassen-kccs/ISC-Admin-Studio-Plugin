// @sailpoint/ui-plugin-sdk ships native ESM with extension-less relative
// imports; webpack 5 rejects those in "type": "module" packages unless
// fully-specified resolution is turned off.
module.exports = {
  webpack: {
    configure: (config) => {
      config.module.rules.push({
        test: /\.m?js$/,
        resolve: { fullySpecified: false },
      });
      // The SDK's source maps point at .ts files that aren't published.
      config.ignoreWarnings = [...(config.ignoreWarnings || []), /Failed to parse source map/];
      return config;
    },
  },
};
