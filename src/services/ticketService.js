'use strict';

const crypto = require('crypto');
const qrcode = require('qrcode');

/**
 * Creates a signed payload for the QR code.
 * The timestamp is NOT included in the HMAC input to ensure deterministic signatures
 * (meaning regenerating it later yields the exact same signature string).
 */
function generateQRPayload(studentId, registrationId) {
  const payloadData = { studentId, registrationId };
  
  const signature = crypto
    .createHmac('sha256', process.env.QR_SECRET)
    .update(JSON.stringify(payloadData))
    .digest('hex');

  return {
    ...payloadData,
    timestamp: Date.now(),
    signature
  };
}

/**
 * Generates the Base64 QR code image on demand.
 */
async function generateQRCode(studentId, registrationId) {
  const payload = generateQRPayload(studentId, registrationId);
  const payloadString = JSON.stringify(payload);
  
  const qrDataUrl = await qrcode.toDataURL(payloadString, {
    errorCorrectionLevel: 'H', // High error correction for phone scanning
    margin: 2
  });

  return { qrDataUrl, payload };
}

/**
 * Recomputes and verifies the HMAC from a scanned QR payload.
 */
function verifyQRPayload(payload) {
  try {
    const { studentId, registrationId, signature } = payload;
    
    if (!studentId || !registrationId || !signature) return false;

    const expectedSignature = crypto
      .createHmac('sha256', process.env.QR_SECRET)
      .update(JSON.stringify({ studentId, registrationId }))
      .digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature);
    const actualBuffer = Buffer.from(signature);

    // crypto.timingSafeEqual throws if buffers are not identical lengths
    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  } catch (error) {
    return false; // Malformed payload
  }
}

module.exports = {
  generateQRPayload,
  generateQRCode,
  verifyQRPayload
};