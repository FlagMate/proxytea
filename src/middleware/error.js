/**
 * 404 + centralized error handler.
 */
function notFound(req, res) {
  res.status(404).json({ success: false, error: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error('[error]', err);
  }
  res.status(status).json({
    success: false,
    error: err.message || 'Internal server error',
  });
}

module.exports = { notFound, errorHandler };
