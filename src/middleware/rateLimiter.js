'use strict';

const { redis } = require('../utils/redis');

/**
 * createRateLimiter — factory that returns an Express middleware.
 *
 * Algorithm: sliding window using a Redis sorted set.
 *   - Each request adds an entry: ZADD key <now_ms> <now_ms>
 *     (score = member = timestamp; unique per ms, good enough for rate limiting)
 *   - Remove entries older than the window: ZREMRANGEBYSCORE key 0 <window_start>
 *   - Count remaining entries: ZCARD key
 *   - Set TTL on the key so Redis auto-cleans it: EXPIRE key <windowSeconds>
 *
 * Why sorted set instead of a simple counter?
 *   A simple counter (INCR + EXPIRE) uses a fixed window — if you send 10 requests
 *   at 00:59 and 10 more at 01:01, you bypass a "10 per minute" limit entirely.
 *   A sliding window counts the last N milliseconds from NOW, closing that loophole.
 *
 * Why pipeline (multi/exec)?
 *   ZADD + ZREMRANGEBYSCORE + ZCARD + EXPIRE = 4 round trips without pipeline.
 *   With pipeline they're sent in one batch and executed atomically server-side.
 *   This halves latency and prevents partial state (e.g. ZADD succeeds but EXPIRE fails).
 *
 * @param {{ windowMs: number, max: number }} options
 * @returns Express middleware function
 */
function createRateLimiter({ windowMs, max }) {
  // Convert window to seconds for Redis EXPIRE command
  const windowSeconds = Math.ceil(windowMs / 1000);

  return async function rateLimiterMiddleware(req, res, next) {
    // Use IP as the identity key. X-Forwarded-For would be used behind a proxy,
    // but for this project req.ip (which Express resolves) is fine.
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const key = `ratelimit:${ip}`;

    const now = Date.now(); // milliseconds since epoch
    const windowStart = now - windowMs; // entries older than this are outside the window

    try {
      // Pipeline: send all commands in one round trip
      const pipeline = redis.multi();

      // Add this request's timestamp as both score AND member.
      // Using timestamp as member means two requests in the same millisecond could
      // collide — append a random suffix to make each entry unique.
      const member = `${now}-${Math.random().toString(36).slice(2, 7)}`;
      pipeline.zadd(key, now, member);

      // Remove all entries older than the current window
      // ZREMRANGEBYSCORE key -inf <windowStart> — everything before the window
      pipeline.zremrangebyscore(key, '-inf', windowStart);

      // Count how many entries remain (all within the current window)
      pipeline.zcard(key);

      // Reset TTL to keep the key alive for one full window from last request.
      // Without this, the key lives forever in Redis even after the user stops sending requests.
      pipeline.expire(key, windowSeconds);

      // exec() returns array of results in the same order as the commands above
      const results = await pipeline.exec();

      // results[2] = [error, value] for ZCARD (index matches command order)
      // ioredis pipeline exec returns [[err, val], [err, val], ...]
      const [zaddErr] = results[0];
      const [zcardErr, currentCount] = results[2];

      if (zaddErr || zcardErr) {
        // If Redis fails, fail open (allow the request) rather than blocking everyone.
        // ⚠️ Production warning: you'd want an alert here. Failing open means
        // rate limiting is disabled when Redis is down.
        return next();
      }

      if (currentCount > max) {
        // Calculate how many seconds until the oldest entry (start of window) expires.
        // This gives the client an accurate Retry-After value.
        const oldestScore = await redis.zrange(key, 0, 0, 'WITHSCORES');
        // oldestScore = ['member', 'score'] — we want the score (timestamp)
        const oldestTimestamp = oldestScore.length >= 2 ? parseInt(oldestScore[1], 10) : now;
        const retryAfterMs = oldestTimestamp + windowMs - now;
        const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);

        // Standard HTTP 429 response
        res.setHeader('Retry-After', retryAfterSeconds);
        return res.status(429).json({
          error: 'Too many requests',
          retryAfter: retryAfterSeconds, // seconds until they can try again
        });
      }

      // Under the limit — let the request through
      next();
    } catch (err) {
      // Any unexpected Redis error: fail open (don't crash the server, don't block users)
      // In production: alert on this.
      next();
    }
  };
}

// Pre-configured instances for use in routes.
// studentLimiter is tighter — students shouldn't be hammering the API.
// volunteerLimiter is looser — volunteers need to paginate through registrations.
const studentLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });
const volunteerLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });

module.exports = { createRateLimiter, studentLimiter, volunteerLimiter };