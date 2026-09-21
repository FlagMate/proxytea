/**
 * MongoDB connection via Mongoose.
 */
const mongoose = require('mongoose');
const config = require('./env');

mongoose.set('strictQuery', true);

async function connectDB() {
  try {
    await mongoose.connect(config.mongoUri);
    // eslint-disable-next-line no-console
    console.log('[db] Connected to MongoDB');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[db] MongoDB connection error:', err.message);
    throw err;
  }
}

module.exports = { connectDB, mongoose };
