'use strict';

const swaggerJsdoc = require('swagger-jsdoc');

// OpenAPI 3.0.0 Configuration
// Extracted from app.js to keep the main entry point clean
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'IEEE RVCE TechFest API',
      version: '1.0.0',
      description: 'Registration backend for IEEE Student Branch RVCE TechFest',
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 3000}`,
        description: 'Local Server',
      },
    ],
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
  // Read paths from the dedicated YAML file
  apis: ['./src/config/swagger.yaml'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

module.exports = swaggerSpec;