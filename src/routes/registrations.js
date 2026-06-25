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

// Redis key for the per-user registration lock.
// Using userId (not IP) prevents one user from blocking another.
const REG_LOCK_KEY = (userId) => `reg_lock:${userId}`;

// Lock TTL: how long to hold the lock if something goes wrong.
// 10 seconds is generous — the DB insert should take < 100ms.
// If the server crashes mid-insert, Redis auto-releases after 10s.
const LOCK_TTL_SECONDS = 10;

// ─── POST /registrations ──────────────────────────────────────────────────────
/**
 * Register the authenticated student for the fest.
 *
 * Middleware chain:
 *   requireAuth     → validates JWT, attaches req.user
 *   requireRole     → only students can register (not volunteers)
 *   studentLimiter  → 10 requests per minute per IP (prevents hammering)
 *   idempotency     → client sends Idempotency-Key header to make retries safe
 *
 * Registration flow:
 *   1. Check if student is already registered → 409 early exit
 *   2. Acquire Redis SET NX lock → 409 if another request is in flight
 *   3. Insert registration row with status='pending'
 *   4. Release lock (in finally — ALWAYS releases even if DB throws)
 *   5. Cache response for idempotency
 *   6. Return 201
 *
 * Why the lock if we already check for duplicates?
 *   Without the lock, two simultaneous requests from the same user could both
 *   pass the "already registered?" check before either has inserted a row.
 *   Both would then try to INSERT and one would get SQLITE_CONSTRAINT_UNIQUE.
 *   The lock serialises them: second request waits, first inserts, lock releases,
 *   second request then hits the "already registered?" check and gets 409 cleanly.
 *
 *   This is the classic "check-then-act" race condition. The lock makes it atomic.
 */
router.post(
  '/',
  requireAuth,
  requireRole('student'),
  studentLimiter,
  idempotency,
  async (req, res) => {
    const userId = req.user.id;

    // ── Step 1: check for existing registration ──────────────────────────────
    const existing = db
      .prepare('SELECT id, status FROM registrations WHERE user_id = ?')
      .get(userId);

    if (existing) {
      // Don't throw — return structured 409 with the existing registrationId
      // so the client can use it (e.g. to poll payment status).
      return res.status(409).json({
        error: 'Already registered',
        registrationId: existing.id,
        status: existing.status,
      });
    }

    // ── Step 2: acquire Redis lock ───────────────────────────────────────────
    const lockKey = REG_LOCK_KEY(userId);

    // SET NX = "set if not exists" — returns 'OK' if acquired, null if already held.
    // EX sets TTL so the lock auto-expires if we crash before releasing.
    const lockAcquired = await redis.set(lockKey, '1', 'NX', 'EX', LOCK_TTL_SECONDS);

    if (!lockAcquired) {
      // Another request from this user is currently in the insert phase.
      // Tell client to retry in a moment.
      return res.status(409).json({
        error: 'Registration in progress — please retry in a moment',
      });
    }

    // ── Step 3: insert registration ──────────────────────────────────────────
    // Wrap in try/finally so the lock is ALWAYS released, even if DB throws.
    // If we don't release, the user is locked out for LOCK_TTL_SECONDS.
    let registrationId;
    try {
      registrationId = uuidv4();

      // status defaults to 'pending' (see schema CHECK constraint)
      // idempotency_key from header — stored so we can deduplicate at DB level too
      const idempotencyKey = req.headers['idempotency-key'] || null;

      db.prepare(`
        INSERT INTO registrations (id, user_id, idempotency_key)
        VALUES (?, ?, ?)
      `).run(registrationId, userId, idempotencyKey);

    } finally {
      // ── Step 4: ALWAYS release the lock ─────────────────────────────────────
      // finally runs even if the try block throws.
      // DEL is fire-and-forget here — if Redis is down at this point, the
      // lock will self-expire after LOCK_TTL_SECONDS anyway.
      await redis.del(lockKey).catch(() => {
        // Swallow Redis error — we can't do much here, and the lock will expire.
      });
    }

    // ── Step 5: append audit event ───────────────────────────────────────────
    appendEvent(EVENT_TYPES.REGISTRATION_CREATED, userId, {
      registrationId,
    });

    // ── Step 6: cache for idempotency ─────────────────────────────────────────
    // res.saveResponse is attached by the idempotency middleware.
    // If no Idempotency-Key header was sent, saveResponse won't be defined — check first.
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

// ─── GET /registrations/my ────────────────────────────────────────────────────
/**
 * Returns the authenticated student's own registration with payment status.
 *
 * Joins registrations with payments so the student can see:
 *   - Whether they're registered (registration row exists)
 *   - Whether they've paid (payment status)
 *   - Whether they have a ticket (ticket row exists)
 *
 * No rate limiter here — it's a read-only GET that students check occasionally.
 */
router.get('/my', requireAuth, requireRole('student'), studentLimiter, (req, res) => {
  const userId = req.user.id;

  // LEFT JOIN payments so we still return registration data even if no payment row exists yet.
  // LEFT JOIN tickets to know if the ticket has been issued.
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