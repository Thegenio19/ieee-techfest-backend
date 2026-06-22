'use strict';

const pino = require('pino');

// pino-pretty is only for dev: makes logs human-readable with colors.
// In production, output raw JSON so log aggregators (Datadog, Loki) can parse it.
const transport = process.env.NODE_ENV !== 'production'
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',   // show local time, not epoch
        ignore: 'pid,hostname',           // cleaner output — we don't need process/host in dev
      },
    }
  : undefined; // undefined = pino uses stdout JSON, which is what production wants

const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info', // default info; set LOG_LEVEL=trace to see SQL queries
    base: {
      service: 'ieee-techfest-api', // every log line includes this — helps in multi-service setups
    },
  },
  transport ? pino.transport(transport) : undefined,
);

module.exports = logger;