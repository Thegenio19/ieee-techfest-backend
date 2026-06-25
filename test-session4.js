'use strict';

require('dotenv').config();
const crypto = require('crypto');

// --- 1. CONFIGURATION ---
const API_URL = 'http://localhost:3000';

const STUDENT_EMAIL = 'student@example.com'; // Replace with a real student in your DB
const STUDENT_PASS = 'password123';

const VOLUNTEER_EMAIL = 'volunteer@example.com'; // Replace with a real volunteer in your DB
const VOLUNTEER_PASS = 'password123';

// Helper to make fetch requests easier
async function req(endpoint, method, body, token = null, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  const res = await fetch(`${API_URL}${endpoint}`, {
    method,
    headers,
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
  });
  
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } 
  catch { return { status: res.status, data: text }; }
}

(async () => {
  console.log('🚀 Starting Session 4 End-to-End Test...\n');

  try {
    // --- 2. STUDENT LOGIN ---
    console.log('1️⃣ Logging in as Student...');
    const loginRes = await req('/auth/login', 'POST', { email: STUDENT_EMAIL, password: STUDENT_PASS });
    if (loginRes.status !== 200) throw new Error(`Login failed: ${JSON.stringify(loginRes.data)}`);
    
    const studentToken = loginRes.data.accessToken;
    // Decode JWT to get student ID (hacky but works for testing)
    const studentId = JSON.parse(Buffer.from(studentToken.split('.')[1], 'base64').toString()).id;
    console.log('✅ Student logged in.\n');

    // --- 3. CREATE PAYMENT ORDER ---
    console.log('2️⃣ Creating Razorpay Order...');
    const orderRes = await req('/payment/create-order', 'POST', null, studentToken);
    if (orderRes.status !== 200) throw new Error(`Order creation failed: ${JSON.stringify(orderRes.data)}`);
    
    const orderId = orderRes.data.orderId;
    console.log(`✅ Order created successfully. Order ID: ${orderId}\n`);

    // --- 4. SIMULATE RAZORPAY WEBHOOK ---
    console.log('3️⃣ Simulating Razorpay Webhook (payment.captured)...');
    const webhookPayload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_test_${Date.now()}`,
            order_id: orderId
          }
        }
      }
    };
    
    const rawBody = JSON.stringify(webhookPayload);
    const signature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    const webhookRes = await req('/payment/webhook', 'POST', rawBody, null, {
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': `evnt_test_${Date.now()}`
    });
    
    if (webhookRes.status !== 200) throw new Error(`Webhook failed: ${webhookRes.data}`);
    console.log('✅ Webhook processed. Payment confirmed and ticket generated.\n');

    // --- 5. GET TICKET ---
    console.log('4️⃣ Fetching Student Ticket...');
    const ticketRes = await req('/ticket', 'GET', null, studentToken);
    if (ticketRes.status !== 200) throw new Error(`Ticket fetch failed: ${JSON.stringify(ticketRes.data)}`);
    
    const registrationId = ticketRes.data.registrationId;
    console.log(`✅ Ticket fetched successfully. Status: ${ticketRes.data.status}\n`);

    // --- 6. VOLUNTEER LOGIN ---
    console.log('5️⃣ Logging in as Volunteer...');
    const volLoginRes = await req('/auth/login', 'POST', { email: VOLUNTEER_EMAIL, password: VOLUNTEER_PASS });
    if (volLoginRes.status !== 200) throw new Error(`Volunteer login failed: ${JSON.stringify(volLoginRes.data)}`);
    
    const volunteerToken = volLoginRes.data.accessToken;
    console.log('✅ Volunteer logged in.\n');

    // --- 7. SIMULATE QR SCAN & CHECK-IN ---
    console.log('6️⃣ Simulating QR Scan & Check-in...');
    
    // We must manually generate the exact payload the QR scanner would output
    const qrData = { studentId, registrationId };
    const qrSignature = crypto
      .createHmac('sha256', process.env.QR_SECRET)
      .update(JSON.stringify(qrData))
      .digest('hex');
      
    const scannedString = JSON.stringify({
      ...qrData,
      timestamp: Date.now(),
      signature: qrSignature
    });

    const checkinRes = await req('/checkin', 'POST', { qrPayload: scannedString }, volunteerToken);
    if (checkinRes.status !== 200) throw new Error(`Check-in failed: ${JSON.stringify(checkinRes.data)}`);
    
    console.log(`✅ Check-in successful! Student ${checkinRes.data.studentName} checked in at ${checkinRes.data.checkedInAt}\n`);
    
    console.log('🎉 SESSION 4 TEST COMPLETE. All systems nominal.');

  } catch (error) {
    console.error(`\n❌ TEST FAILED:\n`, error.message);
  }
})();