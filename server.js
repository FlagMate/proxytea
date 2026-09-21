/**
 * Super Debug Cloud — backend entry point.
 * Express + MongoDB. Listens on config.port (default 3000).
 */
const config = require('./src/config/env');
const { connectDB } = require('./src/config/db');
const { createApp } = require('./src/app');

async function main() {
  await connectDB();
  const app = createApp();
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] Super Debug Cloud API v${config.version} listening on ${config.serverBasePath} (port ${config.port})`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[server] Failed to start:', err);
  process.exit(1);
});
