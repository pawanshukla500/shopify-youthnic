import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config';
import logger from './utils/logger';
import apiRoutes from './routes/api';
import webhookRoutes from './routes/webhooks';
import delhiveryWebhookRoutes from './routes/delhivery-webhooks';
import scheduler from './jobs/scheduler';

import path from 'path';
import fs from 'fs';

const app = express();

// Security (allow loading images and assets for SPA)
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false,
}));

// CORS
app.use(cors());

// Logging
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

// Serve static logos (Easebuzz, GoKwik, Delhivery)
app.use('/logos', express.static(path.join(__dirname, '../frontend/public/logos')));

// Raw body capture for Shopify webhooks (needed for HMAC verification)
// This must be registered BEFORE the JSON parser for the webhook route
app.use(
  '/webhooks/shopify',
  express.json({
    limit: '10mb',
    verify: (req: any, _res, buf) => {
      // Store raw body for HMAC verification
      req.rawBody = buf.toString('utf8');
    },
  })
);

// JSON and urlencoded parser for all other routes
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/webhooks', webhookRoutes);
app.use('/webhooks', delhiveryWebhookRoutes);
app.use('/api', apiRoutes);

// Static frontend build for production
const clientDist = process.env.CLIENT_DIST_PATH || path.join(__dirname, '../frontend/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/webhooks') || req.path.startsWith('/logos')) {
      return next();
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  // Root API endpoint when frontend is not built locally
  app.get('/', (_req, res) => {
    res.json({
      name: 'Shopify OMS',
      description: 'Automated order management, dispatch, tracking, returns & refunds',
      status: 'running',
      endpoints: {
        health: '/api/health',
        orders: '/api/orders',
        returns: '/api/returns',
        tracking: '/api/tracking/:waybill',
        payments: '/api/payments/summary',
        serviceability: '/api/delhivery/serviceability/:pincode',
        ndr: '/api/delhivery/ndr',
        webhooksShopify: '/webhooks/shopify',
        webhooksDelhivery: '/webhooks/delhivery',
      },
    });
  });
}

// 404 handler for unmatched API routes
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const server = app.listen(config.port, () => {
  logger.info(`Server started on port ${config.port}`, {
    nodeEnv: config.nodeEnv,
    appBaseUrl: config.appBaseUrl,
  });

  const unconfigured: string[] = [];
  if (!config.shopify.accessToken && !(config.shopify.clientId && config.shopify.clientSecret)) {
    unconfigured.push('SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET: Shopify calls will fail');
  }
  if (!config.delhivery.apiToken) {
    unconfigured.push('DELHIVERY_API_TOKEN: shipping calls will fail');
  }
  if (!config.kwikenage.apiKey) {
    unconfigured.push('KWIKENAGE_API_KEY: WhatsApp notifications will fail');
  }
  if (unconfigured.length > 0) {
    logger.warn('Some integrations are not configured', { unconfigured });
  }

  if (config.cronEnabled) {
    scheduler.start();
  } else {
    logger.warn('Scheduler disabled (CRON_ENABLED=false) — no background syncs will run');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  scheduler.stop();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received — shutting down gracefully');
  scheduler.stop();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

export default app;
