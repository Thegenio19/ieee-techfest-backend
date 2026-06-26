'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireRole } = require('../middleware/auth');
const { studentLimiter } = require('../middleware/rateLimiter');
const { createError } = require('../middleware/errorHandler');
const paymentService = require('../services/paymentService');
const { generateQRPayload } = require('../services/ticketService');
const { appendEvent } = require('../utils/eventStore');
const { redis } = require('../utils/redis');
const db = require('../db/index'); 
const logger = require('../utils/logger');

const router = express.Router();


router.post('/create-order', requireAuth, requireRole('student'), studentLimiter, async (req, res) => {
  const userId = req.user.id;

  const registration = db.prepare(`SELECT * FROM registrations WHERE user_id = ?`).get(userId);
  if (!registration) throw createError(404, 'Registration not found');
  if (registration.status === 'paid') throw createError(409, 'Already paid');
  if (registration.status !== 'pending') throw createError(400, 'Invalid registration status');

  const amountPaise = 50000; 
  const paymentId = uuidv4();

  const razorpayOrder = await paymentService.createOrder({
    amount: amountPaise,
    receipt: registration.id,
    notes: { studentId: userId, registrationId: registration.id }
  });

  db.prepare(`
    INSERT INTO payments (id, registration_id, razorpay_order_id, amount_paise, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(paymentId, registration.id, razorpayOrder.id, amountPaise, 'created');

  appendEvent('PAYMENT_ORDER_CREATED', userId, { paymentId, razorpayOrderId: razorpayOrder.id });

  res.status(200).json({
    orderId: razorpayOrder.id,
    amount: amountPaise,
    currency: 'INR',
    keyId: process.env.RAZORPAY_KEY_ID
  });
});


router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  
  // Bypass signature check ONLY if running in local development
  const isValid = process.env.NODE_ENV === 'development' 
    ? true 
    : paymentService.verifyWebhookSignature(req.body.toString(), signature);

  if (!isValid) {
    logger.warn('Invalid Razorpay webhook signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const payload = JSON.parse(req.body.toString());
  if (payload.event !== 'payment.captured') return res.status(200).send('OK');

  const rzpPaymentEntity = payload.payload.payment.entity;
  const razorpayOrderId = rzpPaymentEntity.order_id;
  const razorpayPaymentId = rzpPaymentEntity.id;
  const webhookEventId = req.headers['x-razorpay-event-id'];

  const processedKey = `webhook:processed:${webhookEventId}`;
  const isProcessed = await redis.get(processedKey);
  if (isProcessed) return res.status(200).send('OK');

  const lockKey = `webhook:lock:${webhookEventId}`;
  const acquired = await redis.set(lockKey, '1', 'NX', 'EX', 30);
  if (!acquired) return res.status(409).send('Processing');

  try {
    const payment = db.prepare(`SELECT * FROM payments WHERE razorpay_order_id = ?`).get(razorpayOrderId);
    if (!payment) return res.status(404).send('Payment not found');

    if (payment.status === 'paid') {
      await redis.set(processedKey, '1', 'EX', 86400); 
      return res.status(200).send('OK');
    }

    const registration = db.prepare(`SELECT * FROM registrations WHERE id = ?`).get(payment.registration_id);
    const ticketId = uuidv4();
    const qrPayload = generateQRPayload(registration.user_id, registration.id);

    const processPaymentTx = db.transaction(() => {
      db.prepare(`
        UPDATE payments SET status = 'paid', razorpay_payment_id = ?, webhook_event_id = ?, updated_at = unixepoch()
        WHERE id = ?
      `).run(razorpayPaymentId, webhookEventId, payment.id);

      db.prepare(`UPDATE registrations SET status = 'paid', updated_at = unixepoch() WHERE id = ?`).run(registration.id);

      db.prepare(`
        INSERT INTO tickets (id, registration_id, user_id, qr_data) VALUES (?, ?, ?, ?)
      `).run(ticketId, registration.id, registration.user_id, JSON.stringify(qrPayload));
    });

    processPaymentTx();
    appendEvent('PAYMENT_CONFIRMED', registration.user_id, { paymentId: payment.id, ticketId });

    await redis.set(processedKey, '1', 'EX', 86400);
    return res.status(200).send('OK');
  } catch (error) {
    logger.error({ err: error, razorpayOrderId }, 'Webhook processing failed');
    await redis.del(lockKey);
    throw error;
  } finally {
    await redis.del(lockKey);
  }
});


router.get('/status', requireAuth, requireRole('student'), (req, res) => {
  const userId = req.user.id;
  const registration = db.prepare(`SELECT id, status FROM registrations WHERE user_id = ?`).get(userId);
  if (!registration) return res.status(404).json({ error: 'Registration not found' });

  const payment = db.prepare(`
    SELECT status, amount_paise FROM payments WHERE registration_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(registration.id);

  res.status(200).json({
    registrationStatus: registration.status,
    paymentStatus: payment ? payment.status : 'not_initiated'
  });
});

module.exports = router;