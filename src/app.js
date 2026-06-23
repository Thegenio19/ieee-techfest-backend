'use strict';

// Load env vars FIRST — before any other import that might read process.env
require('dotenv').config();

// This patches Express's router to catch async errors and forward them to error middleware.
// Without this, an `async` route that throws would silently hang the request.
require('express-async-errors');

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const logger = require('./utils/logger');
const { requestIdMiddleware } = require('./middleware/requestId');
const { errorHandler } = require('./middleware/errorHandler');
const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');

const app = express();

// ─── Security middleware ──────────────────────────────────────────────────────
// helmet() sets ~15 security headers in one call:
// X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security, etc.
app.use(helmet());

// Allow cross-origin requests (needed if you add a frontend later, or for Postman)
app.use(cors());

// ─── Request parsing ─────────────────────────────────────────────────────────
app.use(express.json({
  limit: '10kb',          // reject huge JSON bodies (prevents memory exhaustion attacks)
}));

// ─── Request ID middleware ────────────────────────────────────────────────────
// Assigns a unique trace ID to every request. Appears in logs and response headers.
// Makes it easy to trace a single request through all log lines.
app.use(requestIdMiddleware);

// ─── HTTP request logging ─────────────────────────────────────────────────────
// pino-http logs every request: method, URL, status code, response time.
// It uses the same logger instance so all logs go to the same output.
app.use(pinoHttp({
  logger,
  customProps: (req) => ({
    traceId: req.traceId, // attach our trace ID to every log line for this request
  }),
  // Don't log /health requests — they'd flood logs with noise (k8s/uptime monitors hit it constantly)
  autoLogging: {
    ignore: (req) => req.url === '/health',
  },
}));

// ─── Swagger API docs ─────────────────────────────────────────────────────────
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'IEEE RVCE TechFest API',
      version: '1.0.0',
      description: 'Registration backend for IEEE Student Branch RVCE TechFest',
    },
    servers: [{ url: `http://localhost:${process.env.PORT || 3000}` }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
  },
  // glob pattern: scan all route files for JSDoc @swagger comments
  apis: ['./src/routes/*.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Serve Swagger UI at /api-docs
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/health', healthRouter);
app.use('/auth', authRouter);

// TODO: mount remaining routes in later sessions
// app.use('/api/registrations', registrationRouter);
// app.use('/api/tickets', ticketsRouter);
// app.use('/api/checkin', checkinRouter);
// app.use('/api/payments', paymentsRouter);
// app.use('/api/volunteer', volunteerRouter);

// ─── 404 handler ─────────────────────────────────────────────────────────────
// Must come AFTER all routes. Catches any request that didn't match a route.
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.originalUrl,
  });
});

// ─── Global error handler ────────────────────────────────────────────────────
// Must be LAST and must have 4 parameters (err, req, res, next).
// Express identifies error handlers by their 4-argument signature.
app.use(errorHandler);

module.exports = app;