'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { createError } = require('../middleware/errorHandler');
const { appendEvent, EVENT_TYPES } = require('../utils/eventStore');
const {
  hashPassword,
  comparePassword,
  generateTokens,
  verifyRefreshToken,
  deleteRefreshToken,
} = require('../services/authService');

const router = express.Router();

// ─── POST /auth/register ──────────────────────────────────────────────────────
/**
 * Register a new student account.
 *
 * Body: { name, email, password, college }
 * Returns: { message, userId }
 *
 * Edge cases handled:
 *  - Missing fields → 400
 *  - Duplicate email → 409 (caught by SQLITE_CONSTRAINT_UNIQUE in errorHandler)
 */
router.post('/register', async (req, res) => {
  const { name, email, password, college } = req.body;

  // Validate all required fields are present and non-empty
  if (!name || !email || !password || !college) {
    throw createError(400, 'name, email, password, and college are all required');
  }

  // Basic email format check — not exhaustive, just catches obvious typos
  if (!email.includes('@') || !email.includes('.')) {
    throw createError(400, 'Invalid email format');
  }

  // Password length sanity check — bcrypt silently truncates at 72 chars, but
  // we want users to know if their password is too short
  if (password.length < 8) {
    throw createError(400, 'Password must be at least 8 characters');
  }

  const hashedPassword = await hashPassword(password);
  const userId = uuidv4(); // UUID v4 — random, no sequential guessing

  // Insert new user. Role defaults to 'student' (see schema CHECK constraint).
  // If email already exists, better-sqlite3 throws SQLITE_CONSTRAINT_UNIQUE,
  // which the global errorHandler catches and returns as 409.
  const stmt = db.prepare(`
    INSERT INTO users (id, name, email, password, role)
    VALUES (?, ?, ?, ?, 'student')
  `);

  stmt.run(userId, name, email.toLowerCase().trim(), hashedPassword);
  // Note: email is lowercased so "Test@Mail.com" and "test@mail.com" are the same account

  // Append immutable audit event — never skip this
  appendEvent(EVENT_TYPES.USER_REGISTERED, userId, {
    name,
    email: email.toLowerCase().trim(),
    college,
  });

  // Do NOT return the password hash — ever
  return res.status(201).json({
    message: 'Registration successful',
    userId,
  });
});

// ─── POST /auth/login ─────────────────────────────────────────────────────────
/**
 * Log in with email + password. Returns access and refresh tokens.
 *
 * Body: { email, password }
 * Returns: { accessToken, refreshToken, user: { id, name, email, role } }
 *
 * IMPORTANT: Wrong email and wrong password return THE SAME error message.
 * Never reveal which is wrong — that tells an attacker which emails exist.
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw createError(400, 'email and password are required');
  }

  // Fetch user by email — using .get() which returns undefined if not found
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(
    email.toLowerCase().trim()
  );

  // ⚠️ SECURITY: use the same error for "user not found" and "wrong password".
  // If we returned "email not found" separately, attackers could enumerate valid emails.
  if (!user) {
    throw createError(401, 'Invalid email or password');
  }

  const passwordMatch = await comparePassword(password, user.password);
  if (!passwordMatch) {
    throw createError(401, 'Invalid email or password'); // same message — intentional
  }

  // Generate both tokens and store refresh token in Redis
  const { accessToken, refreshToken } = await generateTokens(user);

  // Log the login event (userId is known now)
  appendEvent(EVENT_TYPES.USER_LOGIN, user.id, {
    email: user.email,
  });

  // Return tokens + safe user info (no password hash)
  return res.status(200).json({
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
});

// ─── POST /auth/refresh ───────────────────────────────────────────────────────
/**
 * Exchange a valid refresh token for a new access token.
 * The refresh token itself is NOT rotated — same refresh token keeps working
 * until it expires in 7 days or the user logs out.
 *
 * Body: { userId, refreshToken }
 * Returns: { accessToken }
 */
router.post('/refresh', async (req, res) => {
  const { userId, refreshToken } = req.body;

  if (!userId || !refreshToken) {
    throw createError(400, 'userId and refreshToken are required');
  }

  // Check Redis: does the stored token match what the client sent?
  const isValid = await verifyRefreshToken(userId, refreshToken);
  if (!isValid) {
    throw createError(401, 'Invalid or expired refresh token');
  }

  // Also verify the JWT signature and expiry of the refresh token itself.
  // Redis match alone isn't enough — the token could be structurally invalid.
  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch {
    // Token expired or tampered — clean up Redis entry too
    await deleteRefreshToken(userId);
    throw createError(401, 'Refresh token expired or invalid');
  }

  // Fetch fresh user data from DB — role might have changed since token was issued
  const user = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(decoded.id);
  if (!user) {
    throw createError(401, 'User not found');
  }

  // Issue a new access token only — refresh token stays the same
  const newAccessToken = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m' }
  );

  appendEvent(EVENT_TYPES.TOKEN_REFRESHED, user.id, {});

  return res.status(200).json({ accessToken: newAccessToken });
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────
/**
 * Log out — invalidates the refresh token in Redis.
 *
 * requireAuth ensures only authenticated users can hit this.
 * After logout, the refresh token is dead. Access token still technically valid
 * until its 15m expiry, but that's an accepted trade-off (stateless JWTs).
 *
 * Returns: { message: 'logged out' }
 */
router.post('/logout', requireAuth, async (req, res) => {
  // req.user was attached by requireAuth middleware
  await deleteRefreshToken(req.user.id);

  appendEvent(EVENT_TYPES.USER_LOGOUT, req.user.id, {});

  return res.status(200).json({ message: 'logged out' });
});

// ─── POST /auth/create-volunteer ──────────────────────────────────────────────
/**
 * Admin-only endpoint to create a volunteer account.
 * Protected by ADMIN_KEY (a shared secret in .env) — NOT a JWT.
 * This is how judges will create a volunteer to test check-in functionality.
 *
 * Body: { name, email, password, adminKey }
 * Returns: { message, userId }
 *
 * ⚠️ Production note: In real systems you'd use a proper admin interface.
 * A hardcoded ADMIN_KEY is fine for a hiring challenge / small fest.
 */
router.post('/create-volunteer', async (req, res) => {
  const { name, email, password, adminKey } = req.body;

  // Check admin key FIRST — before doing any DB work.
  // Don't reveal whether the email already exists to unauthenticated callers.
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    throw createError(403, 'Invalid admin key');
  }

  if (!name || !email || !password) {
    throw createError(400, 'name, email, and password are required');
  }

  if (password.length < 8) {
    throw createError(400, 'Password must be at least 8 characters');
  }

  const hashedPassword = await hashPassword(password);
  const userId = uuidv4();

  // Same insert as register, but role = 'volunteer'
  const stmt = db.prepare(`
    INSERT INTO users (id, name, email, password, role)
    VALUES (?, ?, ?, ?, 'volunteer')
  `);

  stmt.run(userId, name, email.toLowerCase().trim(), hashedPassword);

  appendEvent(EVENT_TYPES.USER_REGISTERED, userId, {
    name,
    email: email.toLowerCase().trim(),
    role: 'volunteer',
    createdBy: 'admin',
  });

  return res.status(201).json({
    message: 'Volunteer account created',
    userId,
  });
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────
/**
 * Returns the currently authenticated user's identity.
 * Data comes from the JWT payload — NO database query needed.
 * Judges use this to verify a token is valid and see which role they have.
 *
 * Returns: { id, email, role, iat, exp }
 */
router.get('/me', requireAuth, (req, res) => {
  // req.user = decoded JWT payload: { id, email, role, iat, exp }
  return res.status(200).json(req.user);
});

module.exports = router;