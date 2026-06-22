'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');

// We import db lazily inside the function to avoid circular dependency issues during startup.
// (db/index.js imports logger, logger doesn't import db — so it's fine here.)
let db;

/**
 * Appends an immutable event to the events table.
 * Call this after every significant state change: registration, payment, check-in, etc.
 *
 * @param {string} type - Event type constant e.g. "USER_REGISTERED"
 * @param {string|null} userId - The user involved, or null for system events
 * @param {object} payload - Any relevant data. Will be JSON.stringify'd.
 */
function appendEvent(type, userId, payload) {
  // Lazy-load db to avoid circular import on startup
  if (!db) db = require('../db');

  const stmt = db.prepare(`
    INSERT INTO events (id, type, user_id, payload)
    VALUES (?, ?, ?, ?)
  `);

  const id = uuidv4();
  const payloadStr = JSON.stringify(payload);

  try {
    stmt.run(id, type, userId, payloadStr);
    logger.debug({ eventType: type, userId, eventId: id }, 'Event appended');
  } catch (err) {
    // Event logging failure should NEVER crash the main operation.
    // We log the error but don't rethrow. The registration/payment still succeeds.
    // ⚠️ Production warning: in a real system, you'd want alerting here.
    logger.error({ err, type, userId }, 'Failed to append event — audit trail may have gap');
  }
}

// Event type constants — centralised so there are no typos across files
const EVENT_TYPES = {
  USER_REGISTERED: 'USER_REGISTERED',
  USER_LOGIN: 'USER_LOGIN',
  TOKEN_REFRESHED: 'TOKEN_REFRESHED',
  USER_LOGOUT: 'USER_LOGOUT',
  REGISTRATION_CREATED: 'REGISTRATION_CREATED',
  PAYMENT_ORDER_CREATED: 'PAYMENT_ORDER_CREATED',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  TICKET_CREATED: 'TICKET_CREATED',
  TICKET_CHECKIN: 'TICKET_CHECKIN',
  CHECKIN_REJECTED: 'CHECKIN_REJECTED', // duplicate scan attempt
};

module.exports = { appendEvent, EVENT_TYPES };