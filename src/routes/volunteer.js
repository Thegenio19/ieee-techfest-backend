'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { volunteerLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// ─── GET /volunteer/registrations ─────────────────────────────────────────────
/**
 * Returns a paginated list of all registrations.
 * Only volunteers can access this — students cannot see other students' data.
 *
 * Query params:
 *   page  (default 1)   — which page to return
 *   limit (default 20, max 100) — rows per page
 *
 * Why paginate?
 *   If 500 students register, returning all rows in one query means one giant JSON
 *   response and a full table scan every request. Pagination keeps responses small
 *   and lets the volunteer dashboard load fast.
 *
 * Response shape:
 *   { data: [...], pagination: { total, page, limit, totalPages } }
 */
router.get(
  '/registrations',
  requireAuth,
  requireRole('volunteer'),
  volunteerLimiter,
  (req, res) => {
    // Parse and clamp pagination params
    const page = Math.max(1, parseInt(req.query.page, 10) || 1); // minimum page is 1
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20)); // 1–100
    const offset = (page - 1) * limit; // SQL OFFSET: skip first N rows

    // Get total count for pagination metadata — separate fast COUNT query
    // COUNT(*) with an index scan is much cheaper than fetching all rows
    const { total } = db.prepare(`
      SELECT COUNT(*) AS total FROM registrations
    `).get();

    // Main data query: join with users, payments, tickets for full picture
    // LEFT JOIN everywhere — not every registration has a payment or ticket yet
    const rows = db.prepare(`
      SELECT
        r.id               AS registrationId,
        r.status           AS registrationStatus,
        r.created_at       AS registeredAt,
        u.name             AS studentName,
        u.email            AS studentEmail,
        p.status           AS paymentStatus,
        p.amount_paise     AS amountPaise,
        t.id               AS ticketId,
        t.checked_in       AS checkedIn,
        t.checked_in_at    AS checkedInAt
      FROM registrations r
      JOIN  users    u ON u.id = r.user_id          -- INNER JOIN: every registration must have a user
      LEFT JOIN payments p ON p.registration_id = r.id  -- may not have paid yet
      LEFT JOIN tickets  t ON t.registration_id = r.id  -- may not have ticket yet
      ORDER BY r.created_at DESC                    -- newest first
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      data: rows,
      pagination: {
        total,
        page,
        limit,
        totalPages,
      },
    });
  }
);

// ─── GET /volunteer/stats ─────────────────────────────────────────────────────
/**
 * Returns aggregate statistics about the event.
 * Useful for the volunteer dashboard header: "372 paid, 128 pending, 201 checked in"
 *
 * No pagination needed — this is a single aggregated result.
 * No volunteerLimiter here — it's a cheap aggregation query, not a list scan.
 *
 * paymentSuccessRate: what percentage of registrations have been paid?
 *   Calculated as: (paid / total) * 100
 *   Returns 0 if no registrations exist (avoids division by zero).
 */
router.get('/stats', requireAuth, requireRole('volunteer'), (req, res) => {
  // Count registrations grouped by status in a single query
  const registrationCounts = db.prepare(`
    SELECT
      COUNT(*)                                           AS total,
      SUM(CASE WHEN status = 'paid'      THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
    FROM registrations
  `).get();

  // Count checked-in tickets — separate table, separate query (simpler to read)
  const { checkedIn } = db.prepare(`
    SELECT COUNT(*) AS checkedIn FROM tickets WHERE checked_in = 1
  `).get();

  // Avoid division by zero: if no registrations, rate is 0
  const paymentSuccessRate =
    registrationCounts.total > 0
      ? Math.round((registrationCounts.paid / registrationCounts.total) * 100)
      : 0;

  return res.status(200).json({
    total: registrationCounts.total,
    paid: registrationCounts.paid,
    pending: registrationCounts.pending,
    cancelled: registrationCounts.cancelled,
    checkedIn,
    paymentSuccessRate, // integer percentage e.g. 73 means 73%
  });
});

module.exports = router;