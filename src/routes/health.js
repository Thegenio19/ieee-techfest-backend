'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { checkRedisHealth } = require('../utils/redis');

// process.hrtime.bigint() gives nanosecond precision for uptime calculation
const SERVER_START_TIME = process.hrtime.bigint();

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Server health check
 *     description: Returns the health status of the server, database, and Redis.
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: All systems healthy
 *       503:
 *         description: One or more systems are down
 */
router.get('/', async (req, res) => {
  // ─── Database check ─────────────────────────────────────────────────────────
  // We run a lightweight query instead of just checking if the db object exists.
  // The db object can exist but the file could be corrupted or locked.
  let dbStatus = 'ok';
  let dbError = null;
  try {
    // SELECT 1 is the lightest possible query — no table access, just returns 1
    db.prepare('SELECT 1').get();
  } catch (err) {
    dbStatus = 'error';
    dbError = err.message;
  }

  // ─── Redis check ─────────────────────────────────────────────────────────────
  const redisOk = await checkRedisHealth();

  // ─── Memory usage ─────────────────────────────────────────────────────────────
  const mem = process.memoryUsage();
  // rss = Resident Set Size = total memory allocated by Node.js process (including V8 heap)
  // heapUsed = memory currently used by JS objects
  const memoryMB = {
    rss: Math.round(mem.rss / 1024 / 1024),
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
  };

  // ─── Uptime ────────────────────────────────────────────────────────────────────
  // BigInt arithmetic: current time minus start time, converted from nanoseconds to seconds
  const uptimeNs = process.hrtime.bigint() - SERVER_START_TIME;
  const uptimeSeconds = Number(uptimeNs / 1_000_000_000n); // BigInt division

  const allHealthy = dbStatus === 'ok' && redisOk;

  const payload = {
    success: allHealthy,
    status: allHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptimeSeconds,
    services: {
      database: {
        status: dbStatus,
        ...(dbError && { error: dbError }), // only include error field if there is one
      },
      redis: {
        status: redisOk ? 'ok' : 'error',
      },
    },
    memory: memoryMB,
  };

  // Return 503 if any service is down — monitoring tools check the HTTP status code,
  // not the response body. A 200 with "status: degraded" would look healthy to them.
  res.status(allHealthy ? 200 : 503).json(payload);
});

module.exports = router;