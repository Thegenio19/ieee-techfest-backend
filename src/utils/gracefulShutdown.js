'use strict';

const logger = require('./logger');

/**
 * Extracts graceful shutdown logic from server.js.
 * Stops accepting new connections, waits for in-flight requests, 
 * and closes persistent connections (DB, Redis, Sockets) cleanly.
 */
function setupGracefulShutdown(httpServer, io, redisClient, db) {
  let isShuttingDown = false; 

  async function shutdown(signal) {
    if (isShuttingDown) return; // Prevent double-execution if SIGTERM and SIGINT both fire
    isShuttingDown = true;

    logger.info({ signal }, 'Shutdown signal received — starting graceful shutdown');

    // Stop accepting new HTTP connections immediately
    httpServer.close(async () => {
      logger.info('HTTP server closed');

      try {
        if (io) {
          io.close();
          logger.info('Socket.io closed');
        }

        if (redisClient) {
          await redisClient.quit();
          logger.info('Redis connection closed');
        }

        if (db) {
          db.close();
          logger.info('SQLite connection closed');
        }

        logger.info('Graceful shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during graceful shutdown');
        process.exit(1); 
      }
    });

    // Fallback: Force kill after 10 seconds if requests hang
    setTimeout(() => {
      logger.error('Forced shutdown after 10s timeout due to hanging requests');
      process.exit(1);
    }, 10_000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM')); 
  process.on('SIGINT', () => shutdown('SIGINT'));  
}

module.exports = { setupGracefulShutdown };