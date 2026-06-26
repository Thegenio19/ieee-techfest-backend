'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { createError } = require('../middleware/errorHandler');
const { appendEvent, EVENT_TYPES } = require('../utils/eventStore');
const { studentLimiter } = require('../middleware/rateLimiter');
const { idempotency } = require('../middleware/idempotency');
const { redis } = require('../utils/redis');

const router = express.Router();

const REG_LOCK_KEY = (userId) => `reg_lock:${userId}`;
const LOCK_TTL_SECONDS = 10;


router.post(
  '/',
  requireAuth,
  requireRole('student'),
  studentLimiter,
  idempotency,
  async (req, res) => {
    const userId = req.user.id;

    const existing = db
      .prepare('SELECT id, status FROM registrations WHERE user_id = ?')
      .get(userId);

    if (existing) {
      return res.status(409).json({
        error: 'Already registered',
        registrationId: existing.id,
        status: existing.status,
      });
    }

    const lockKey = REG_LOCK_KEY(userId);
    const lockAcquired = await redis.set(lockKey, '1', 'NX', 'EX', LOCK_TTL_SECONDS);

    if (!lockAcquired) {
      return res.status(409).json({
        error: 'Registration in progress — please retry in a moment',
      });
    }

    let registrationId;
    try {
      registrationId = uuidv4();
      const idempotencyKey = req.headers['idempotency-key'] || null;

      db.prepare(`
        INSERT INTO registrations (id, user_id, idempotency_key)
        VALUES (?, ?, ?)
      `).run(registrationId, userId, idempotencyKey);
    } finally {
      await redis.del(lockKey).catch(() => {});
    }

    appendEvent(EVENT_TYPES.REGISTRATION_CREATED, userId, { registrationId });

    const result = {
      registrationId,
      status: 'pending',
      message: 'Registration created. Proceed to payment.',
    };

    if (typeof res.saveResponse === 'function') {
      await res.saveResponse(result);
    }

    return res.status(201).json(result);
  }
);


router.get('/my', requireAuth, requireRole('student'), studentLimiter, (req, res) => {
  const userId = req.user.id;

  const registration = db.prepare(`
    SELECT
      r.id               AS registrationId,
      r.status           AS registrationStatus,
      r.created_at       AS registeredAt,
      p.status           AS paymentStatus,
      p.amount_paise     AS amountPaise,
      p.razorpay_order_id AS razorpayOrderId,
      t.id               AS ticketId,
      t.checked_in       AS checkedIn,
      t.checked_in_at    AS checkedInAt
    FROM registrations r
    LEFT JOIN payments p ON p.registration_id = r.id
    LEFT JOIN tickets  t ON t.registration_id = r.id
    WHERE r.user_id = ?
  `).get(userId);

  if (!registration) {
    throw createError(404, 'No registration found — you have not registered yet');
  }

  return res.status(200).json(registration);
});

module.exports = router;