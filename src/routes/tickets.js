'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { createError } = require('../middleware/errorHandler');
const { generateQRCode } = require('../services/ticketService');
const db = require('../db/index');

const router = express.Router();

router.get('/', requireAuth, requireRole('student'), async (req, res) => {
  const userId = req.user.id;

  // Note: Following user instructions — ticket validity relies on ticket existence
  // and registration being paid. No 'status' column exists in tickets table.
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

  // Generate QR fresh from deterministic data
  const { qrDataUrl } = await generateQRCode(userId, ticketInfo.registration_id);

  // Compute status for the API response dynamically
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