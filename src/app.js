'use strict';

// Load env vars FIRST
require('dotenv').config();

// Patch Express's router for async errors
require('express-async-errors');

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const swaggerUi = require('swagger-ui-express');

// Import the newly decoupled Swagger config
const swaggerSpec = require('./config/swagger');

const logger = require('./utils/logger');
const { requestIdMiddleware } = require('./middleware/requestId');
const { errorHandler } = require('./middleware/errorHandler');
const { studentLimiter } = require('./middleware/rateLimiter'); 

// Route Imports
const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const registrationRouter = require('./routes/registrations');   
const volunteerRouter = require('./routes/volunteer');          
const adminRouter = require('./routes/admin'); // Added Admin router     

// Session 4 Route Imports
const paymentRouter = require('./routes/payments');
const ticketRouter = require('./routes/tickets');
const checkinRouter = require('./routes/checkin');

const app = express();

app.use(helmet());
app.use(cors());

// ─── CRITICAL WEBHOOK MOUNT ───────────────────────────────────────────────────
app.use('/payment', paymentRouter);

// ─── Request parsing ─────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(requestIdMiddleware);

app.use(pinoHttp({
  logger,
  customProps: (req) => ({ traceId: req.traceId }),
  autoLogging: { ignore: (req) => req.url === '/health' },
}));

// Serve Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Redirect root to api-docs for instant visibility during marking
app.get('/', (req, res) => {
  res.redirect('/api-docs');
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/health', healthRouter);
app.use('/auth', studentLimiter, authRouter);
app.use('/registrations', registrationRouter); 
app.use('/volunteer', volunteerRouter);        
app.use('/admin', adminRouter); // Mount Admin Router

app.use('/ticket', ticketRouter);              
app.use('/checkin', checkinRouter);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.originalUrl,
  });
});

app.use(errorHandler);

module.exports = app;