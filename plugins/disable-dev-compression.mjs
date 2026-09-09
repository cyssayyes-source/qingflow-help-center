/**
 * Development bundles are intentionally unminified and large. Compressing them
 * for every reload blocks webpack-dev-server and substantially delays refreshes.
 * Production assets continue to use the normal Docusaurus compression pipeline.
 */
export default function disableDevCompressionPlugin() {
  return {
    name: 'qingflow-disable-dev-compression',
    configureWebpack() {
      return {
        devServer: {
          compress: false,
        },
      };
    },
  };
}
