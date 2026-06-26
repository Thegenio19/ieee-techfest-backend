'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { volunteerLimiter } = require('../middleware/rateLimiter');
const { createError } = require('../middleware/errorHandler');
const { verifyQRPayload } = require('../services/ticketService');
const { appendEvent } = require('../utils/eventStore');
const { redis } = require('../utils/redis');
const db = require('../db/index');

const router = express.Router();


router.post('/', requireAuth, requireRole('volunteer'), volunteerLimiter, async (req, res) => {
  const { qrPayload } = req.body;
  if (!qrPayload) throw createError(400, 'qrPayload is required');

  let parsedPayload;
  try {
    parsedPayload = JSON.parse(qrPayload);
  } catch (err) {
    throw createError(400, 'Invalid QR payload format');
  }

  if (!verifyQRPayload(parsedPayload)) {
    throw createError(401, 'Invalid or forged QR code');
  }

  const { registrationId } = parsedPayload;

  const ticket = db.prepare(`
    SELECT t.*, u.name as student_name
    FROM tickets t
    JOIN users u ON t.user_id = u.id
    WHERE t.registration_id = ?
  `).get(registrationId);

  if (!ticket) throw createError(404, 'Ticket not found in system');
  if (ticket.checked_in === 1) throw createError(409, `Already checked in at timestamp ${ticket.checked_in_at}`);

  const lockKey = `checkin:lock:${registrationId}`;
  const acquired = await redis.set(lockKey, '1', 'NX', 'EX', 30);

  if (!acquired) throw createError(409, 'Check-in currently in progress');

  try {
    const info = db.prepare(`
      UPDATE tickets SET checked_in = 1, checked_in_at = unixepoch(), checked_in_by = ?
      WHERE id = ? AND checked_in = 0
    `).run(req.user.id, ticket.id);

    if (info.changes === 0) {
      throw createError(409, 'Race condition: Already checked in by another volunteer');
    }

    appendEvent('TICKET_CHECKIN', ticket.user_id, { ticketId: ticket.id, volunteerId: req.user.id });

    res.status(200).json({
      message: 'Check-in successful',
      studentName: ticket.student_name,
      checkedInAt: Date.now() 
    });
  } finally {
    await redis.del(lockKey);
  }
});

module.exports = router;