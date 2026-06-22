'use strict';

const logger = require('../utils/logger');

/**
 * Global Express error handler.
 * Catches all errors thrown (or passed via next(err)) from routes and middleware.
 * express-async-errors makes sure async throws reach here automatically.
 *
 * IMPORTANT: Must have exactly 4 parameters. Express detects error handlers by arity.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  // Log the full error with trace ID so we can find it in logs
  logger.error({
    err,
    traceId: req.traceId,
    method: req.method,
    url: req.url,
  }, 'Unhandled error');

  // Handle specific known error types with appropriate status codes
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
      traceId: req.traceId,
    });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: err.message,
      traceId: req.traceId,
    });
  }

  // better-sqlite3 throws this when a UNIQUE constraint is violated
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({
      success: false,
      error: 'Duplicate entry — resource already exists',
      traceId: req.traceId,
    });
  }

  // Default: something unexpected went wrong
  const statusCode = err.statusCode || err.status || 500;

  // In production, don't leak internal error messages to the client.
  // Stack traces and DB error messages can reveal system internals to attackers.
  const message = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'Internal server error'
    : err.message || 'Internal server error';

  return res.status(statusCode).json({
    success: false,
    error: message,
    traceId: req.traceId,
  });
}

/**
 * Creates an error with a specific HTTP status code.
 * Use this in routes: throw createError(404, 'User not found')
 * The errorHandler above will pick up the statusCode.
 */
function createError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

module.exports = { errorHandler, createError };