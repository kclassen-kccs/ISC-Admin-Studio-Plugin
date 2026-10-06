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
      return config;
    },
  },
};
