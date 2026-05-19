/**
 * Bootstrap script to make Node.js respect HTTP_PROXY / HTTPS_PROXY.
 * Load via NODE_OPTIONS='--require ./scripts/proxy-bootstrap.cjs'
 *
 * Usage:
 *   HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 \
 *   NODE_OPTIONS='--require ./scripts/proxy-bootstrap.cjs' npm run dev
 */
if (process.env.HTTP_PROXY && !process.env.GLOBAL_AGENT_HTTP_PROXY) {
  process.env.GLOBAL_AGENT_HTTP_PROXY = process.env.HTTP_PROXY;
}
if (process.env.HTTPS_PROXY && !process.env.GLOBAL_AGENT_HTTPS_PROXY) {
  process.env.GLOBAL_AGENT_HTTPS_PROXY = process.env.HTTPS_PROXY;
}

const { bootstrap } = require("global-agent");
bootstrap();

if (process.env.GLOBAL_AGENT_HTTP_PROXY) {
  console.log(
    `[proxy-bootstrap] routing HTTP traffic through ${process.env.GLOBAL_AGENT_HTTP_PROXY}`
  );
}
