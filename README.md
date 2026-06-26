# TechFest Registration API

This project is the complete, high-performance Node.js backend for the IEEE Student Branch RVCE Backend Development Hiring Challenge. It serves as the primary system handling a massive surge of student registrations, Razorpay payment processing, and event-day volunteer QR check-ins without buckling under concurrent load.

## Tech Stack

| Technology | Purpose | Why chosen |
| :--- | :--- | :--- |
| Node.js | Runtime | Asynchronous architecture inherently handles high I/O workloads effortlessly. |
| Express | Framework | Industry standard routing that provides massive extensibility with middleware. |
| SQLite (better-sqlite3) | Database | Extremely fast, synchronous wrapper deployed in WAL mode to easily survive spikes, meeting challenge constraints. |
| Redis (ioredis) | Lock / State | Handles sliding-window rate limiting and SET NX idempotency locks across requests. |
| JWT | Auth | Stateless authentication prevents database overhead on every protected route. |
| bcryptjs | Security | Standard, battle-tested cryptographic password hashing algorithm. |
| Razorpay | Payments | Indian transaction processor mapped meticulously using custom webhook protections. |
| qrcode | Utility | On-the-fly Base64 QR code generation; avoids messy persistent image storage. |
| pino | Logging | Minimal overhead JSON logger capable of attaching trace IDs universally. |
| swagger-jsdoc | Docs | Auto-generates living OpenAPI documentation directly from route files. |

## Architecture Overview

The system architecture utilizes a robust layered design approach. Inbound requests traverse an intense middleware layer managing rate limits (Redis sorted sets) and Idempotency keys before hitting route handlers. Complex logic flows downward into dedicated services, protecting external systems (like Razorpay) through mechanisms like circuit breakers. The fundamental pillar of the database design relies completely on event sourcing: instead of mutating user state destructively, critical state transitions log immutable chronologic events allowing full historical audits and zero-loss traceability. There is no frontend; this is strictly a backend API implementation.

## Prerequisites

- Node.js v18+
- Redis (For Windows WSL: `sudo apt install redis-server`, Mac: `brew install redis`, Linux: `sudo apt install redis`)
- Razorpay test account (create at [razorpay.com/docs](https://razorpay.com/docs))

## Getting Started

### 1. Clone and install
```bash
git clone https://github.com/your-username/techfest-backend.git
cd techfest-backend
npm install
```

### 2. Environment setup

```bash
cp env-example.txt .env
```

Fill in the variables:

- `PORT`: Server port (e.g., 3000)
- `NODE_ENV`: 'development' or 'production'
- `DATABASE_PATH`: Path to SQLite (e.g., './data/techfest.db')
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`: Secure randomized strings used for signing tokens
- `QR_SECRET`: HMAC string protecting ticket integrity
- `ADMIN_KEY`: Super secret password allowing volunteer creation
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET`: Dashboard keys
- `REDIS_URL`: Cache URL (e.g., 'redis://localhost:6379')

### 3. Start Redis

- **WSL:** `sudo service redis-server start`
- **Mac:** `brew services start redis`
- **Linux:** `sudo systemctl start redis`

### 4. Run the server

- **Development:** `npm run dev`
- **Production:** `npm start`

### 5. Verify it works

Navigate your browser or Postman to `GET http://localhost:3000/health`.  
Expected: `{ "status": "ok", "db": "connected", "redis": "connected" }`

## Creating a Volunteer Account

Volunteer accounts bypass self-service registration and rely strictly on manual admin provisioning using the `ADMIN_KEY`. This is how judges can create a volunteer to test check-in functionality.

**POST** `/auth/create-volunteer`

```json
{
  "name": "Test Volunteer",
  "email": "volunteer@rvce.edu.in",
  "password": "volunteer123",
  "adminKey": "ieee2026admin"
}
```

## API Documentation

Two distinct ways to explore the API endpoints:

1. **Interactive Docs:** Hit `http://localhost:3000/` and the system instantly redirects to the Swagger UI.
2. **Postman:** Import `postman_collection.json` located in the root repository to test the endpoints.

## API Endpoints Reference

| Method | Path | Auth | Role | Description |
| --- | --- | --- | --- | --- |
| GET | `/health` | None | Any | Verifies Redis, DB, and application uptime. |
| POST | `/auth/register` | None | Any | Registers a new student account. |
| POST | `/auth/login` | None | Any | Authenticates email generating Access & Refresh JWTs. |
| POST | `/auth/refresh` | None | Any | Exchanges a valid Refresh token for a new Access token. |
| POST | `/auth/logout` | Bearer | Any | Invalidates the Refresh Token stored in Redis. |
| GET | `/auth/me` | Bearer | Any | Decodes JWT providing active context without DB hits. |
| POST | `/auth/create-volunteer` | None | Admin | High privilege volunteer creation (requires ADMIN_KEY). |
| POST | `/registrations` | Bearer | Student | Registers student for the fest (Idempotent). |
| GET | `/registrations/my` | Bearer | Student | Fetches combined DB statuses for UI consumption. |
| POST | `/payment/create-order` | Bearer | Student | Reaches to Razorpay, locking registration in DB. |
| POST | `/payment/webhook` | None | System | Consumes raw bytes guaranteeing HMAC integrity checks. |
| GET | `/payment/status` | Bearer | Student | Determines if payment processed asynchronously. |
| GET | `/ticket` | Bearer | Student | Generates strict HMAC signed QR data buffer. |
| GET | `/ticket/verify/:id` | Bearer | Volunteer | Pre-fetches DB status predicting gate success. |
| POST | `/checkin` | Bearer | Volunteer | Redis-locked atomic update marking QR as consumed. |
| GET | `/volunteer/registrations` | Bearer | Volunteer | Paginated SQL offset listing global attendees. |
| GET | `/volunteer/stats` | Bearer | Volunteer | Fast `COUNT` analytical aggregates for frontend. |
| GET | `/volunteer/checkins` | Bearer | Volunteer | Retrieves chronologic list of active attendees. |
| GET | `/admin/audit/:userId` | Bearer | Volunteer | Outputs pure event sourcing payload chronologies. |

## Key Design Decisions

**1. Idempotency keys on registration**  
Why: prevents double registration on network retry or double-tap.  
How: Redis stores the response for 24h keyed by client-sent header.

**2. Redis SET NX for distributed locks**  
Why: prevents race condition when two requests arrive simultaneously for the same user. SET NX is atomic — only one caller wins.

**3. Sliding window rate limiter**  
Why: simple counters can be gamed at window boundaries.  
Sorted sets track actual timestamps for accurate limiting.

**4. Circuit breaker around Razorpay**  
Why: if Razorpay is down, requests to it will hang and exhaust the thread pool. Circuit breaker fails fast after 3 failures, protecting server stability.

**5. HMAC-signed QR codes**  
Why: prevents ticket forgery. The QR contains a signature computed with `QR_SECRET` — any tampered QR fails verification at check-in instantly.

**6. Timing-safe comparison for QR verification**  
Why: standard string comparison leaks timing information that attackers can use to forge signatures bit by bit. `crypto.timingSafeEqual` prevents this.

**7. Event sourcing audit log**  
Why: instead of overwriting status columns, every state change is recorded as an immutable event. Full history of every student's journey is always available.

**8. Raw body for webhook signature**  
Why: Razorpay computes its signature on the raw request bytes. If Express parses JSON first, the raw bytes are gone and verification always fails.

## What I Would Add With More Time

- WebSocket live dashboard for volunteer check-in view
- BullMQ async email worker (currently email is sync)
- Swagger UI with full request/response examples
- Docker + docker-compose for one-command setup
- Automated test suite with Jest and Supertest

## What Broke and What I Learned

**Bug 1:** Redis SET NX lock not releasing on DB error.  
**Fix:** moved lock release to `finally` block — guarantees release even if insert throws.

**Bug 2:** Razorpay webhook signature always failing.  
**Fix:** Express had already parsed the body to JSON before the webhook handler ran. Switched to `express.raw()` before `express.json()` for that specific route.

**Bug 3:** Rate limiter not applied to GET routes.  
**Fix:** discovered `studentLimiter` was only on `POST /registrations`. Added it to `GET /registrations/my` — found this by hammering the endpoint in Postman.

**Bug 4:** Duplicate 409 vs idempotency 200 conflict.  
**Fix:** idempotency middleware must run after duplicate-check so a genuine duplicate returns 409, but a retried successful request returns the cached 200.

## Assumptions

- Payment amount is fixed (set in `.env` as `FEST_AMOUNT_PAISE`)
- One registration per student per fest
- Volunteer accounts are created by admins only, not self-signup
- QR codes are generated on-demand, not stored as files
- All timestamps are Unix epoch (milliseconds)
- Amounts stored in paise throughout (no floating point money)