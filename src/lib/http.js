/**
 * Small HTTP helpers for consistent responses + async route wrapping.
 */

/** Wrap an async route handler so thrown errors go to the error middleware. */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** An error with an attached HTTP status code. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { asyncHandler, HttpError };
