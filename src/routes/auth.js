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


router.post('/register', async (req, res) => {
  const { name, email, password, college } = req.body;

  if (!name || !email || !password || !college) throw createError(400, 'name, email, password, and college are all required');
  if (!email.includes('@') || !email.includes('.')) throw createError(400, 'Invalid email format');
  if (password.length < 8) throw createError(400, 'Password must be at least 8 characters');

  const hashedPassword = await hashPassword(password);
  const userId = uuidv4(); 

  const stmt = db.prepare(`
    INSERT INTO users (id, name, email, password, role)
    VALUES (?, ?, ?, ?, 'student')
  `);
  stmt.run(userId, name, email.toLowerCase().trim(), hashedPassword);

  appendEvent(EVENT_TYPES.USER_REGISTERED, userId, {
    name, email: email.toLowerCase().trim(), college,
  });

  return res.status(201).json({ message: 'Registration successful', userId });
});


router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) throw createError(400, 'email and password are required');

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user) throw createError(401, 'Invalid email or password');

  const passwordMatch = await comparePassword(password, user.password);
  if (!passwordMatch) throw createError(401, 'Invalid email or password'); 

  const { accessToken, refreshToken } = await generateTokens(user);
  appendEvent(EVENT_TYPES.USER_LOGIN, user.id, { email: user.email });

  return res.status(200).json({
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});


router.post('/refresh', async (req, res) => {
  const { userId, refreshToken } = req.body;

  if (!userId || !refreshToken) throw createError(400, 'userId and refreshToken are required');

  const isValid = await verifyRefreshToken(userId, refreshToken);
  if (!isValid) throw createError(401, 'Invalid or expired refresh token');

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch {
    await deleteRefreshToken(userId);
    throw createError(401, 'Refresh token expired or invalid');
  }

  const user = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(decoded.id);
  if (!user) throw createError(401, 'User not found');

  const newAccessToken = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m' }
  );

  appendEvent(EVENT_TYPES.TOKEN_REFRESHED, user.id, {});
  return res.status(200).json({ accessToken: newAccessToken });
});


router.post('/logout', requireAuth, async (req, res) => {
  await deleteRefreshToken(req.user.id);
  appendEvent(EVENT_TYPES.USER_LOGOUT, req.user.id, {});
  return res.status(200).json({ message: 'logged out' });
});


router.post('/create-volunteer', async (req, res) => {
  const { name, email, password, adminKey } = req.body;

  if (!adminKey || adminKey !== process.env.ADMIN_KEY) throw createError(403, 'Invalid admin key');
  if (!name || !email || !password) throw createError(400, 'name, email, and password are required');
  if (password.length < 8) throw createError(400, 'Password must be at least 8 characters');

  const hashedPassword = await hashPassword(password);
  const userId = uuidv4();

  const stmt = db.prepare(`
    INSERT INTO users (id, name, email, password, role)
    VALUES (?, ?, ?, ?, 'volunteer')
  `);
  stmt.run(userId, name, email.toLowerCase().trim(), hashedPassword);

  appendEvent(EVENT_TYPES.USER_REGISTERED, userId, {
    name, email: email.toLowerCase().trim(), role: 'volunteer', createdBy: 'admin',
  });

  return res.status(201).json({ message: 'Volunteer account created', userId });
});


router.get('/me', requireAuth, (req, res) => {
  return res.status(200).json(req.user);
});

module.exports = router;