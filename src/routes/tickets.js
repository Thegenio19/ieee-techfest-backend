'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { createError } = require('../middleware/errorHandler');
const { generateQRCode } = require('../services/ticketService');
const db = require('../db/index');

const router = express.Router();

/**
 * @openapi
 * /ticket:
 * get:
 * tags: [Tickets]
 * summary: Get user's own ticket and QR Code
 * security:
 * - bearerAuth: []
 * responses:
 * 200:
 * description: Valid ticket with base64 QR payload
 * 404:
 * description: Ticket not found or payment pending
 */
router.get('/', requireAuth, requireRole('student'), async (req, res) => {
  const userId = req.user.id;

  const ticketInfo = db.prepare(`
    SELECT t.*, r.status as registration_status, u.name as student_name
    FROM tickets t
    JOIN registrations r ON t.registration_id = r.id
    JOIN users u ON t.user_id = u.id
    WHERE t.user_id = ?
  `).get(userId);

  if (!ticketInfo || ticketInfo.registration_status !== 'paid') {
    throw createError(404, 'No valid ticket found. Complete payment first.');
  }

  const { qrDataUrl } = await generateQRCode(userId, ticketInfo.registration_id);
  const computedStatus = ticketInfo.checked_in === 1 ? 'checked_in' : 'active';

  res.status(200).json({
    ticketId: ticketInfo.id,
    studentName: ticketInfo.student_name,
    registrationId: ticketInfo.registration_id,
    qrDataUrl,
    status: computedStatus,
    createdAt: ticketInfo.created_at,
    checkedInAt: ticketInfo.checked_in_at
  });
});


router.get('/verify/:registrationId', requireAuth, requireRole('volunteer'), (req, res) => {
  const { registrationId } = req.params;

  const ticket = db.prepare(`
    SELECT t.checked_in, t.checked_in_at, u.name as student_name
    FROM tickets t
    JOIN users u ON t.user_id = u.id
    WHERE t.registration_id = ?
  `).get(registrationId);

  if (!ticket) {
    throw createError(404, 'Ticket not found for this registration');
  }

  res.status(200).json({
    registrationId,
    studentName: ticket.student_name,
    status: ticket.checked_in === 1 ? 'checked_in' : 'active',
    checkedInAt: ticket.checked_in_at
  });
});

module.exports = router;