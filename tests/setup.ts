/**
 * Vitest setup — runs before any spec file imports.
 *
 * Populates the env vars that `src/config/index.ts` requires at import time.
 * The real values are placeholders; tests don't actually connect to anything.
 */

// Anything in `required()` in config/index.ts must be set, even for tests
// that don't open a DB connection.
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test_db';
process.env.SHOPIFY_SHOP_DOMAIN ||= 'test.myshopify.com';
process.env.SHOPIFY_CLIENT_ID ||= 'test_client_id';
process.env.SHOPIFY_CLIENT_SECRET ||= 'test_client_secret';
process.env.SHOPIFY_API_VERSION ||= '2026-07';
process.env.SHOPIFY_WEBHOOK_SECRET ||= 'test_webhook_secret';
process.env.DELHIVERY_API_TOKEN ||= 'test_delhivery_token';
process.env.DELHIVERY_PICKUP_LOCATION ||= 'Test Warehouse';
process.env.NODE_ENV ||= 'test';
process.env.VELOCITY_API_TOKEN = '';
process.env.VELOCITY_WEBHOOK_SECRET = '';