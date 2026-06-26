'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();

router.get('/audit/:userId', requireAuth, requireRole('volunteer'), (req, res) => {
  try {
    const { userId } = req.params;

    const events = db.prepare(`
      SELECT id, type as eventType, payload, created_at as createdAt
      FROM events
      WHERE user_id = ?
      ORDER BY created_at ASC
    `).all(userId);

    const parsedEvents = events.map(event => {
      let safePayload = {};
      try {
        if (typeof event.payload === 'string') {
          safePayload = JSON.parse(event.payload);
        } else {
          safePayload = event.payload || {};
        }
      } catch (e) {
        safePayload = { rawString: event.payload }; 
      }
      
      return {
        ...event,
        payload: safePayload
      };
    });

    return res.status(200).json({
      userId,
      events: parsedEvents
    });

  } catch (error) {
    console.error('🔥 FATAL ADMIN AUDIT ERROR:', error);
    return res.status(500).json({ 
      message: 'Server crashed in admin audit', 
      error: error.message 
    });
  }
});

module.exports = router;