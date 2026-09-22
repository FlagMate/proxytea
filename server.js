/**
 * Super Debug Cloud — backend entry point.
 * Express + MongoDB. Listens on config.port (default 3000).
 */
const config = require('./src/config/env');
const { connectDB } = require('./src/config/db');
const { createApp } = require('./src/app');

async function main() {
  const app = createApp();

  // Start HTTP server immediately so health checks, static assets, and CORS proxy
  // are available immediately, even if MongoDB is delayed or temporarily unreachable.
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] Super Debug Cloud API v${config.version} listening on ${config.serverBasePath} (port ${config.port})`);
  });

  // Attempt database connection asynchronously in background (self-healing with retry)
  connectDB().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[server] Initial DB connection attempt encountered error (server still running):', err.message);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[server] Fatal server startup error:', err);
  process.exit(1);
});

