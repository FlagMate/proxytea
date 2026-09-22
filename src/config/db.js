/**
 * MongoDB connection via Mongoose with non-blocking auto-reconnect.
 */
const mongoose = require('mongoose');
const config = require('./env');

mongoose.set('strictQuery', true);

let isConnecting = false;
let retryTimer = null;

async function connectDB() {
  if (mongoose.connection.readyState === 1) {
    return;
  }
  if (isConnecting) return;
  isConnecting = true;

  try {
    const maskedUri = (config.mongoUri || '').replace(/:[^:@]+@/, ':****@');
    // eslint-disable-next-line no-console
    console.log(`[db] Connecting to MongoDB (${maskedUri})...`);
    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    // eslint-disable-next-line no-console
    console.log('[db] Connected to MongoDB');
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[db] MongoDB connection error:', err.message);
    // Auto-retry in background every 10s without throwing or crashing the server process
    if (!retryTimer) {
      retryTimer = setInterval(() => {
        connectDB().catch(() => {});
      }, 10000);
      if (retryTimer.unref) retryTimer.unref();
    }
  } finally {
    isConnecting = false;
  }
}

mongoose.connection.on('disconnected', () => {
  // eslint-disable-next-line no-console
  console.warn('[db] MongoDB disconnected. Scheduling reconnect...');
  if (!retryTimer) {
    retryTimer = setInterval(() => {
      connectDB().catch(() => {});
    }, 10000);
    if (retryTimer.unref) retryTimer.unref();
  }
});

module.exports = { connectDB, mongoose };

