'use strict';

// dotenv must be loaded before app.js in case app.js imports modules that read env vars.
// app.js also calls dotenv.config() — calling it twice is harmless (it's idempotent).
require('dotenv').config();

const http = require('http');
const { Server: SocketServer } = require('socket.io'); // named import to avoid clash with http.Server
const app = require('./app');
const logger = require('./utils/logger');
const { redis } = require('./utils/redis'); // import to ensure connection is established on startup
const db = require('./db');                  // import to ensure schema is applied on startup

const PORT = parseInt(process.env.PORT || '3000', 10);

// Create a raw HTTP server wrapping our Express app.
// We need the raw server (not app.listen) so we can attach Socket.io to the same port.
const httpServer = http.createServer(app);

// Attach Socket.io to the HTTP server.
// cors: '*' is fine for dev; restrict in production to your frontend domain.
const io = new SocketServer(httpServer, {
  cors: { origin: '*' },
});

// Make `io` available on the app object so routes can emit events without circular imports
app.set('io', io);

// Socket.io connection handler (basic setup — volunteer dashboard built in later session)
io.on('connection', (socket) => {
  logger.info({ socketId: socket.id }, 'Socket.io client connected');

  socket.on('disconnect', (reason) => {
    logger.info({ socketId: socket.id, reason }, 'Socket.io client disconnected');
  });
});

// Start the server
httpServer.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV }, '🚀 Server started');
  logger.info(`📄 Swagger docs: http://localhost:${PORT}/api-docs`);
  logger.info(`❤️  Health check: http://localhost:${PORT}/health`);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
// When the process receives SIGTERM (Docker stop, k8s pod eviction) or SIGINT (Ctrl+C),
// we want to:
// 1. Stop accepting new connections
// 2. Wait for in-flight requests to finish (up to a timeout)
// 3. Close DB and Redis connections cleanly
// This prevents data corruption and dropped requests during deployments.

let isShuttingDown = false; // flag to reject new requests during shutdown

async function gracefulShutdown(signal) {
  if (isShuttingDown) return; // prevent double-shutdown if both SIGTERM and SIGINT fire
  isShuttingDown = true;

  logger.info({ signal }, 'Shutdown signal received — starting graceful shutdown');

  // Stop accepting new HTTP connections
  httpServer.close(async () => {
    logger.info('HTTP server closed');

    try {
      // Disconnect Socket.io clients cleanly
      io.close();
      logger.info('Socket.io closed');

      // Close Redis connection
      await redis.quit();
      logger.info('Redis connection closed');

      // Close SQLite — better-sqlite3 is synchronous, .close() is immediate
      db.close();
      logger.info('SQLite connection closed');

      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during graceful shutdown');
      process.exit(1); // force exit with error code if cleanup fails
    }
  });

  // Force kill after 10 seconds if requests don't finish
  // This prevents a stuck request from blocking shutdown indefinitely
  setTimeout(() => {
    logger.error('Forced shutdown after 10s timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // Docker/k8s sends this
process.on('SIGINT', () => gracefulShutdown('SIGINT'));   // Ctrl+C sends this

// Catch any unhandled promise rejections — these would otherwise silently fail
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled promise rejection');
  // Don't exit — log and continue. In production you might want to exit and let k8s restart.
});

// Catch synchronous uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  process.exit(1); // always exit on uncaught exceptions — process state is unknown
});