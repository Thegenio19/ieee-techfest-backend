'use strict';

const { Redis } = require('ioredis');  // ioredis named export, not default
const logger = require('./logger');

// Parse Redis URL from env. Default is local WSL Redis.
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Create the ioredis client.
// ioredis auto-reconnects by default — good for production restarts.
const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,      // if a command fails 3 times, throw (don't hang forever)
  enableReadyCheck: true,       // wait until Redis is fully ready before sending commands
  lazyConnect: false,           // connect immediately on startup, not on first command
                                // this lets us catch a missing Redis BEFORE serving traffic
});

// Listen for connection events so we can log them clearly
redis.on('connect', () => {
  logger.info({ url: redisUrl }, 'Redis connected');
});

redis.on('ready', () => {
  logger.info('Redis ready');
});

// 'error' events MUST be handled or Node.js crashes the process (unhandled EventEmitter error)
redis.on('error', (err) => {
  logger.error({ err }, 'Redis error');
  // We log but don't crash here — ioredis will retry automatically.
  // If Redis is permanently down, commands will start failing with errors, which routes handle.
});

redis.on('reconnecting', (delay) => {
  logger.warn({ delay }, 'Redis reconnecting');
});

/**
 * Verifies Redis is reachable by sending a PING command.
 * Used by the /health endpoint to report Redis status.
 * Returns true if Redis responds, false if it's down.
 */
async function checkRedisHealth() {
  try {
    const result = await redis.ping(); // should return 'PONG'
    return result === 'PONG';
  } catch {
    return false;
  }
}

module.exports = { redis, checkRedisHealth };