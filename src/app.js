const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yaml');
const config = require('./config');
const { query } = require('./db');
const { authenticate } = require('./middleware/auth');
const { errorHandler, notFoundRoute } = require('./middleware/errors');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind a proxy, req.ip must come from X-Forwarded-For or every visitor looks the same.
  app.set('trust proxy', config.trustProxy);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
      },
    },
  }));
  app.use(express.json({ limit: '50kb' }));

  app.get('/api/health', async (_req, res) => {
    await query('SELECT 1');
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.use('/api/auth', require('./modules/auth/routes').router);
  app.use('/api/links', authenticate, require('./modules/links/routes').router);
  app.use('/api', require('./modules/stats/routes').router); // authenticates per route

  const spec = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'openapi.yaml'), 'utf8'));
  app.get('/api/openapi.json', (_req, res) => res.json(spec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'Ticker API' }));

  // Peek (/api/peek/:code) and the redirect (/:code) live together.
  const redirect = require('./modules/redirect/routes').router;
  app.use(redirect);
  app.use('/api', notFoundRoute);
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
