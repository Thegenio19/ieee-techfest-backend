'use strict';

const Razorpay = require('razorpay');
const crypto = require('crypto');
const razorpayBreaker = require('./circuitBreaker');

// Check if we have real keys. If the key contains "dummy", we mock it.
const hasRealKeys = process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_ID.includes('dummy');

let razorpay;
if (hasRealKeys) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

async function createOrder({ amount, currency = 'INR', receipt, notes = {} }) {
  // If no real keys are found, return a mock Razorpay order to bypass the internet
  if (!hasRealKeys) {
    return {
      id: `order_mock_${Date.now()}`,
      entity: 'order',
      amount,
      currency,
      receipt,
      status: 'created'
    };
  }

  const options = { amount, currency, receipt, notes };
  return razorpayBreaker.fire(() => razorpay.orders.create(options));
}

function verifyWebhookSignature(rawBody, signature) {
  if (!rawBody || !signature) return false;

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature);
  const actualBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

module.exports = {
  createOrder,
  verifyWebhookSignature,
};