// @sailpoint/ui-plugin-sdk ships strict ESM with extensionless relative
// imports; webpack 5 (CRA) rejects those unless fullySpecified is off.
module.exports = {
  webpack: {
    configure: (config) => {
      config.module.rules.push({
        test: /\.m?js$/,
        include: /node_modules[\\/]@sailpoint/,
        resolve: { fullySpecified: false },
      });
      // The SDK's maps point at TypeScript sources it doesn't ship.
      config.ignoreWarnings = [...(config.ignoreWarnings || []), /Failed to parse source map/];
      return config;
    },
  },
};
