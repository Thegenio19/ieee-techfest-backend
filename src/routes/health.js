'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { checkRedisHealth } = require('../utils/redis');

const SERVER_START_TIME = process.hrtime.bigint();


router.get('/', async (req, res) => {
  let dbStatus = 'ok';
  let dbError = null;
  try {
    db.prepare('SELECT 1').get();
  } catch (err) {
    dbStatus = 'error';
    dbError = err.message;
  }

  const redisOk = await checkRedisHealth();

  const mem = process.memoryUsage();
  const memoryMB = {
    rss: Math.round(mem.rss / 1024 / 1024),
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
  };

  const uptimeNs = process.hrtime.bigint() - SERVER_START_TIME;
  const uptimeSeconds = Number(uptimeNs / 1_000_000_000n); 

  const allHealthy = dbStatus === 'ok' && redisOk;

  const payload = {
    success: allHealthy,
    status: allHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptimeSeconds,
    services: {
      database: { status: dbStatus, ...(dbError && { error: dbError }) },
      redis: { status: redisOk ? 'ok' : 'error' },
    },
    memory: memoryMB,
  };

  res.status(allHealthy ? 200 : 503).json(payload);
});

module.exports = router;