-- Enable WAL (Write-Ahead Logging) mode for better concurrency.
-- WAL allows readers and one writer to run simultaneously without blocking each other.
-- This is critical for our app: health checks reading while registrations write.
PRAGMA journal_mode = WAL;

-- Enforce foreign key constraints — SQLite disables them by default (design flaw).
-- Without this, you could insert a ticket with a non-existent user_id and SQLite won't complain.
PRAGMA foreign_keys = ON;

-- ─── USERS ───────────────────────────────────────────────────────────────────
-- Stores both students and volunteers. Role is enforced at application layer.
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,              -- UUID, generated in app code (not SQLite auto-int)
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,          -- login identifier, must be unique
  password    TEXT NOT NULL,                 -- bcrypt hash, never plaintext
  role        TEXT NOT NULL DEFAULT 'student'
                CHECK(role IN ('student', 'volunteer')),  -- SQLite CHECK = poor man's enum
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()) -- Unix timestamp (seconds), not ISO string
                                                     -- integers sort faster than text dates
);

-- Index email for fast login lookups (SELECT WHERE email = ?)
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ─── REFRESH TOKENS ───────────────────────────────────────────────────────────
-- We store refresh tokens in DB so we can revoke them (logout, suspicious activity).
-- If we only validated the JWT signature, a stolen refresh token would be valid forever.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT PRIMARY KEY,        -- UUID
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,    -- SHA-256 hash of the actual token, not the raw token.
                                       -- If DB is breached, attacker gets hashes not live tokens.
  expires_at  INTEGER NOT NULL,        -- Unix timestamp
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ─── REGISTRATIONS ────────────────────────────────────────────────────────────
-- One registration per user. The UNIQUE constraint on user_id enforces this at the DB level.
CREATE TABLE IF NOT EXISTS registrations (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                   -- UNIQUE means one student = one registration, enforced by DB not app code
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending', 'paid', 'cancelled')),
  idempotency_key  TEXT UNIQUE,        -- Client-supplied key to make POST /register safe to retry.
                                       -- UNIQUE ensures two requests with same key = one row.
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_registrations_status ON registrations(status);

-- ─── PAYMENTS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id                   TEXT PRIMARY KEY,
  registration_id      TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  razorpay_order_id    TEXT UNIQUE,           -- Razorpay's order ID (prefixed rzp_order_)
  razorpay_payment_id  TEXT UNIQUE,           -- Razorpay's payment ID (set after payment success)
  amount_paise         INTEGER NOT NULL,      -- Amount in paise (never floating point for money!)
  currency             TEXT NOT NULL DEFAULT 'INR',
  status               TEXT NOT NULL DEFAULT 'created'
                         CHECK(status IN ('created', 'paid', 'failed', 'refunded')),
  webhook_event_id     TEXT UNIQUE,           -- Razorpay webhook event ID for idempotency.
                                              -- UNIQUE prevents processing the same webhook twice.
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_payments_registration ON payments(registration_id);
CREATE INDEX IF NOT EXISTS idx_payments_razorpay_order ON payments(razorpay_order_id);

-- ─── TICKETS ──────────────────────────────────────────────────────────────────
-- Ticket is created only after payment is confirmed.
CREATE TABLE IF NOT EXISTS tickets (
  id              TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL UNIQUE REFERENCES registrations(id) ON DELETE CASCADE,
                  -- UNIQUE: one ticket per registration, enforced by DB
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  qr_data         TEXT NOT NULL UNIQUE,    -- The signed payload embedded in the QR image
  qr_image_base64 TEXT,                   -- Cached base64 PNG. Could be regenerated, but caching
                                          -- avoids regenerating on every /ticket GET request.
  checked_in      INTEGER NOT NULL DEFAULT 0,   -- SQLite has no BOOLEAN. 0 = false, 1 = true.
  checked_in_at   INTEGER,               -- NULL until first check-in
  checked_in_by   TEXT REFERENCES users(id), -- Which volunteer scanned this ticket
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_qr ON tickets(qr_data);

-- ─── EVENTS (Immutable Audit Log / Event Sourcing) ────────────────────────────
-- Every significant action is appended here and NEVER updated or deleted.
-- This is the "event sourcing" pattern: you can reconstruct system state by replaying events.
-- Useful for: debugging, fraud detection, compliance, understanding what went wrong.
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,     -- e.g. "USER_REGISTERED", "PAYMENT_CONFIRMED", "TICKET_CHECKIN"
  user_id     TEXT,              -- nullable: some events (webhooks) may not have a user context
  payload     TEXT NOT NULL,     -- JSON string of the event data. TEXT because SQLite has no JSON type.
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  -- NOTE: No foreign keys here intentionally.
  -- We want to keep event records even if a user is deleted (audit trail must be complete).
  -- No UPDATE or DELETE should ever be run on this table.
);

-- Index by type for queries like "show me all TICKET_CHECKIN events today"
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);