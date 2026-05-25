module.exports = {
  webpack(config) {
    config.module.rules.push({
      test: /\.data$/i,
      type: "asset/inline",
      generator: {
        dataUrl(content) {
          return `data:application/octet-stream;base64,${content.toString("base64")}`;
        },
      },
    });

    config.module.rules.push({
      test: /\.(png|jpe?g|gif|svg|woff2?|ttf|eot)$/i,
      type: "asset/inline",
    });

    return config;
  },
};
