'use strict';

const { redis } = require('../utils/redis');

// How long to cache a response: 24 hours in seconds
const IDEMPOTENCY_TTL = 24 * 60 * 60;

// Redis key prefix — namespaced to avoid collisions with other keys
const IDEMPOTENCY_KEY = (key) => `idempotency:${key}`;

/**
 * idempotency — middleware that makes POST routes safe to retry.
 *
 * Problem it solves:
 *   A student submits a registration, the network drops before they get the 201.
 *   They retry. Without idempotency, they'd get a 409 (already registered) even
 *   though the first request succeeded. With idempotency, the retry returns the
 *   exact same 201 they would have gotten the first time — no confusion.
 *
 * How it works:
 *   1. Client sends Idempotency-Key: <uuid> header with each request.
 *   2. Middleware checks Redis for that key.
 *   3. If found → return the cached response immediately (replayed).
 *   4. If not found → attach res.saveResponse(data) to the response object.
 *      The route calls res.saveResponse(data) before res.json(data).
 *      Middleware caches it in Redis with 24h TTL.
 *
 * If no Idempotency-Key header: skip silently. Not all routes need this.
 *
 * ⚠️ Production warning:
 *   This implementation stores the response body only (not status code).
 *   Replayed responses always return 200. For this project that's fine —
 *   the only idempotent route (POST /registrations) returns 201 on first call
 *   and we return 200 on replay with the X-Idempotent-Replayed header so the
 *   client knows it's a cached result.
 *   A full implementation would also cache the status code.
 */
async function idempotency(req, res, next) {
  const idempotencyKey = req.headers['idempotency-key'];

  // No header → not an idempotent request, skip
  if (!idempotencyKey) {
    return next();
  }

  const redisKey = IDEMPOTENCY_KEY(idempotencyKey);

  try {
    // Check if we've seen this key before
    const cached = await redis.get(redisKey);

    if (cached) {
      // We have a cached response — replay it
      // Signal to the client that this is a replayed response, not a fresh one
      res.setHeader('X-Idempotent-Replayed', 'true');
      return res.status(200).json(JSON.parse(cached));
    }
  } catch {
    // Redis failure — fail open (proceed without idempotency rather than blocking)
    // ⚠️ Production warning: alert on this; a down Redis means duplicate submissions possible.
    return next();
  }

  /**
   * Attach saveResponse to the res object so routes can call it.
   * Usage in route: res.saveResponse(result); return res.status(201).json(result);
   *
   * We store the data BEFORE sending the response. If storage fails, we still
   * send the response to the client — better to respond than to error because
   * of a cache-write failure.
   */
  res.saveResponse = async function saveResponse(data) {
    try {
      // Store as JSON string with 24h TTL
      await redis.set(redisKey, JSON.stringify(data), 'EX', IDEMPOTENCY_TTL);
    } catch {
      // Cache write failed — not fatal. The request still succeeds.
      // The client might get a duplicate on retry, but that's better than a 500.
    }
  };

  next();
}

module.exports = { idempotency };