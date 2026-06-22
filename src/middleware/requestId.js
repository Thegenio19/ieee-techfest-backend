'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * Assigns a unique trace ID to every incoming request.
 * Checks for an existing X-Request-ID header first (set by load balancers/API gateways).
 * If none exists, generates a new UUID.
 *
 * We attach it to req.traceId so any code that has access to req can log it.
 * We also send it back in the response header so clients can report it in bug reports.
 */
function requestIdMiddleware(req, res, next) {
  const traceId = req.headers['x-request-id'] || uuidv4();
  req.traceId = traceId;                    // attach to request object for downstream use
  res.setHeader('X-Request-ID', traceId);   // echo back in response
  next();
}

module.exports = { requestIdMiddleware };