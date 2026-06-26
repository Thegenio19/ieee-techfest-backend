'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { volunteerLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

router.use(requireAuth, requireRole('volunteer'), volunteerLimiter);

/**
 * @openapi
 * /volunteer/registrations:
 * get:
 * tags: [Volunteer]
 * summary: Get all student registrations (paginated)
 * security:
 * - bearerAuth: []
 * parameters:
 * - in: query
 * name: page
 * schema:
 * type: integer
 * default: 1
 * - in: query
 * name: limit
 * schema:
 * type: integer
 * default: 20
 * responses:
 * 200:
 * description: Paginated list of registrations
 */
router.get('/registrations', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20)); 
  const offset = (page - 1) * limit;

  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM registrations`).get();

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
    JOIN  users    u ON u.id = r.user_id          
    LEFT JOIN payments p ON p.registration_id = r.id  
    LEFT JOIN tickets  t ON t.registration_id = r.id  
    ORDER BY r.created_at DESC                    
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  const totalPages = Math.ceil(total / limit);

  return res.status(200).json({
    data: rows,
    pagination: { total, page, limit, totalPages },
  });
});

/**
 * @openapi
 * /volunteer/stats:
 * get:
 * tags: [Volunteer]
 * summary: Get overall fest statistics
 * security:
 * - bearerAuth: []
 * responses:
 * 200:
 * description: Aggregated statistics for the volunteer dashboard
 */
router.get('/stats', (req, res) => {
  const registrationCounts = db.prepare(`
    SELECT
      COUNT(*)                                         AS total,
      SUM(CASE WHEN status = 'paid'      THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
    FROM registrations
  `).get();

  const { checkedIn } = db.prepare(`SELECT COUNT(*) AS checkedIn FROM tickets WHERE checked_in = 1`).get();

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
    paymentSuccessRate, 
  });
});


router.get('/checkins', (req, res) => {
  const checkins = db.prepare(`
    SELECT 
      u.name AS studentName, 
      u.email, 
      t.registration_id AS registrationId, 
      t.checked_in_at AS checkedInAt
    FROM tickets t
    JOIN users u ON t.user_id = u.id
    WHERE t.checked_in = 1
    ORDER BY t.checked_in_at DESC
  `).all();

  return res.status(200).json(checkins);
});

module.exports = router;