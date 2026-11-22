
export default {
  basePath: '/',
  allowedHosts: [
  "pos.pantheras.io"
],
  supportedLocales: {
  "en-US": ""
},
  entryPoints: {
    '': () => import('./main.server.mjs')
  },
};
