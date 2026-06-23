'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { redis } = require('../utils/redis');

// Redis key prefix for refresh tokens.
// Stored as: refreshToken:{userId} = <token string>
// Using a prefix namespace avoids collisions with other Redis keys.
const REFRESH_KEY = (userId) => `refreshToken:${userId}`;

/**
 * hashPassword — bcrypt hash with 10 salt rounds.
 * 10 rounds is the standard balance: ~100ms on modern hardware (slow enough
 * to resist brute force, fast enough not to hurt login UX).
 *
 * ⚠️ Always use bcryptjs — NOT bcrypt. Native bcrypt requires node-gyp and
 * will break on Windows/WSL during npm install. bcryptjs is pure JS.
 */
async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

/**
 * comparePassword — verifies a plaintext password against a stored bcrypt hash.
 * Returns true if match, false if not.
 * bcrypt.compare is timing-safe — it takes the same time regardless of where
 * the mismatch occurs, preventing timing attacks.
 */
async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * generateTokens — creates both access and refresh tokens for a logged-in user.
 *
 * Access token:
 *  - Short-lived (15m) — minimises damage if stolen
 *  - Contains { id, email, role } in payload
 *  - Signed with JWT_ACCESS_SECRET
 *
 * Refresh token:
 *  - Long-lived (7d) — used to get new access tokens without re-login
 *  - Contains only { id } — less data, less damage if decoded
 *  - Signed with JWT_REFRESH_SECRET (separate secret — if access secret leaks,
 *    attacker still can't forge refresh tokens)
 *  - Stored in Redis so we can revoke it on logout
 *
 * @param {{ id: string, email: string, role: string }} user
 * @returns {{ accessToken: string, refreshToken: string }}
 */
async function generateTokens(user) {
  const accessToken = jwt.sign(
    { id: user.id, email: user.email, role: user.role }, // payload
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m' }
  );

  const refreshToken = jwt.sign(
    { id: user.id }, // minimal payload — role can be fetched fresh when needed
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );

  // Store refresh token in Redis.
  // EX = expiry in seconds. 7 * 24 * 3600 = 604800 seconds.
  // When this key expires in Redis, the refresh token is automatically invalidated —
  // no cron job needed to clean up expired tokens.
  const sevenDaysInSeconds = 7 * 24 * 60 * 60;
  await redis.set(REFRESH_KEY(user.id), refreshToken, 'EX', sevenDaysInSeconds);

  return { accessToken, refreshToken };
}

/**
 * verifyRefreshToken — checks that the provided token matches what's stored in Redis.
 *
 * Two checks happen:
 *  1. Redis lookup: does a token exist for this userId?
 *  2. Exact match: is it the same token the client sent?
 *
 * This prevents a stolen-but-expired refresh token from being replayed after
 * the user has already logged out (which deletes the Redis key).
 *
 * @param {string} userId
 * @param {string} token - The refresh token the client sent
 * @returns {boolean}
 */
async function verifyRefreshToken(userId, token) {
  const stored = await redis.get(REFRESH_KEY(userId));

  // stored will be null if the key doesn't exist or has expired
  if (!stored) return false;

  // Constant-time comparison would be ideal here; for a hiring project this is fine.
  // In production you'd use crypto.timingSafeEqual on Buffer.from(stored) vs Buffer.from(token).
  return stored === token;
}

/**
 * deleteRefreshToken — removes the refresh token from Redis on logout.
 * After this, the client's refresh token is dead — they must log in again.
 *
 * @param {string} userId
 */
async function deleteRefreshToken(userId) {
  await redis.del(REFRESH_KEY(userId));
}

module.exports = {
  hashPassword,
  comparePassword,
  generateTokens,
  verifyRefreshToken,
  deleteRefreshToken,
};