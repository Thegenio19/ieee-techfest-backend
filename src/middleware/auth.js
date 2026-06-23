'use strict';

const jwt = require('jsonwebtoken');
const { createError } = require('./errorHandler');

/**
 * requireAuth — verifies the JWT access token on protected routes.
 *
 * Expects the client to send:
 *   Authorization: Bearer <access_token>
 *
 * On success: attaches the decoded payload to req.user and calls next().
 * On failure: throws — express-async-errors routes it to the global error handler,
 *             which returns 401 for JsonWebTokenError / TokenExpiredError.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];

  // Header must exist and start with "Bearer " (note the space)
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw createError(401, 'Missing or malformed Authorization header');
  }

  // Split "Bearer <token>" — index 1 is the token itself
  const token = authHeader.split(' ')[1];

  if (!token) {
    throw createError(401, 'Token missing after Bearer keyword');
  }

  // jwt.verify throws JsonWebTokenError (bad sig) or TokenExpiredError (exp passed).
  // Both are caught by the global errorHandler and returned as 401.
  // We do NOT manually try/catch here — let it propagate cleanly.
  const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);

  // Attach decoded payload to req so downstream handlers/middleware can read it.
  // Payload shape: { id, email, role, iat, exp }
  req.user = decoded;

  next();
}

/**
 * requireRole — RBAC gate. Call AFTER requireAuth.
 *
 * Usage in a route file:
 *   router.get('/admin', requireAuth, requireRole('volunteer'), handler)
 *   router.get('/multi', requireAuth, requireRole('student', 'volunteer'), handler)
 *
 * Returns a middleware function (factory pattern) so we can pass roles as args.
 */
function requireRole(...roles) {
  // The returned function is the actual Express middleware
  return function (req, res, next) {
    // requireAuth must have run first — req.user must exist
    if (!req.user) {
      throw createError(401, 'Not authenticated');
    }

    // Check if the user's role is in the allowed list
    if (!roles.includes(req.user.role)) {
      throw createError(
        403,
        `Access denied — requires role: ${roles.join(' or ')}`
      );
    }

    next();
  };
}

module.exports = { requireAuth, requireRole };