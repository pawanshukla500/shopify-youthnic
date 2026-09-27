import dotenv from 'dotenv';

dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

/**
 * Resolve the earliest order creation date this OMS will import.
 *
 * Accepts a plain `YYYY-MM-DD` (interpreted as local midnight, so an Indian
 * server treats it as IST midnight) or any full ISO timestamp. An empty or
 * unparseable value falls back to midnight of the day the process starts, which
 * keeps a fresh install from importing Shopify history.
 */
function parseSyncStartDate(raw: string): Date {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  if (!raw) {
    return startOfToday;
  }

  // Date-only values must be parsed with Indian Standard Time (+05:30) offset
  // so that midnight IST is accurately represented across all host environments (e.g. Docker UTC containers).
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
  const parsed = dateOnly ? new Date(`${raw.trim()}T00:00:00+05:30`) : new Date(raw.trim());

  if (Number.isNaN(parsed.getTime())) {
    // eslint-disable-next-line no-console
    console.warn(
      `ORDER_SYNC_START_DATE="${raw}" is not a valid date, using start of today instead.`
    );
    return startOfToday;
  }

  return parsed;
}

export const config = {
  // Server
  port: parseInt(optional('PORT', '3000'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),
  appBaseUrl: optional('APP_BASE_URL', 'http://localhost:3000'),

  // Database
  databaseUrl: required('DATABASE_URL'),

  // Shopify
  shopify: {
    shopDomain: required('SHOPIFY_SHOP_DOMAIN'),
    // Two authentication modes, one must be configured:
    //   1. Dev Dashboard app client credentials (new apps after Jan 1, 2026):
    //      SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET. Tokens are fetched from
    //      Shopify's token endpoint, last 24 hours, and refresh automatically.
    //   2. Legacy static token (admin-created custom app — no longer creatable):
    //      SHOPIFY_ACCESS_TOKEN. Returned as-is by the token provider.
    clientId: optional('SHOPIFY_CLIENT_ID', ''),
    clientSecret: optional('SHOPIFY_CLIENT_SECRET', ''),
    accessToken: optional('SHOPIFY_ACCESS_TOKEN', ''),
    // Fetch a fresh token this many seconds before the cached one expires.
    tokenRefreshSkew: parseInt(optional('SHOPIFY_TOKEN_REFRESH_SKEW', '300'), 10),
    // Shopify signs webhook bodies with the app's client secret. Dev Dashboard
    // apps have no separate webhook secret, so fall back to the client secret.
    webhookSecret:
      optional('SHOPIFY_WEBHOOK_SECRET', '') || optional('SHOPIFY_CLIENT_SECRET', ''),
    apiVersion: optional('SHOPIFY_API_VERSION', '2026-07'),
    // Hard floor on which orders this OMS will take in. Orders created before
    // this date are never imported, so a fresh database does not pull in months
    // of Shopify history. Orders already in the database keep receiving updates
    // regardless of this date. Set it once (YYYY-MM-DD) and leave it alone:
    // moving it forward would stop updates for orders created before the new
    // value that are not yet in the database. Defaults to the day the process
    // starts, which keeps a brand-new install to today onward.
    syncStartDate: parseSyncStartDate(optional('ORDER_SYNC_START_DATE', '')),
  },

  // Background cron jobs. Disable for local testing to avoid scheduled runs
  // failing against services that are not configured yet.
  cronEnabled: optional('CRON_ENABLED', 'true') === 'true',

  // Delhivery
  delhivery: {
    // Not required at boot so the server can start while other integrations are
    // still being configured. Delhivery calls fail with a clear error instead.
    apiToken: optional('DELHIVERY_API_TOKEN', ''),
    // All B2C APIs use a single base URL in production.
    // Staging uses https://staging-express.delhivery.com
    baseUrl: optional('DELHIVERY_BASE_URL', 'https://track.delhivery.com'),
    apiBaseUrl: optional('DELHIVERY_API_BASE_URL', 'https://track.delhivery.com'),
    // Must be the exact registered warehouse/pickup-location name from Delhivery.
    // Do not use a client profile such as "Domestic" here.
    pickupLocation: required('DELHIVERY_PICKUP_LOCATION'),
    // Shipping mode: Surface or Express
    shippingMode: optional('DELHIVERY_SHIPPING_MODE', 'Surface'),
    // Default label size: A4 or 4R
    labelSize: optional('DELHIVERY_LABEL_SIZE', '4R'),
    // ─── Package dimensions / declared weight ───────────────────────────────
    // Tuned for minimal logistic cost on Youthnic's current product mix
    // (cotton kurtas, light ethnic wear, poly-blend dresses).
    // Single-piece shipment  → 22 × 20 × 3 cm, 500 g (within the 500g slab)
    // Multi-piece shipment   → 22 × 20 × 5 cm, 500 g (capped — most items are
    //                          actually 350-450 g; capping avoids an extra
    //                          weight slab surcharge from Delhivery).
    // Override via env vars if SKU profile changes.
    singleItemLengthCm: parseInt(optional('DELHIVERY_SINGLE_ITEM_LENGTH_CM', '22'), 10),
    singleItemBreadthCm: parseInt(optional('DELHIVERY_SINGLE_ITEM_BREADTH_CM', '20'), 10),
    singleItemHeightCm: parseInt(optional('DELHIVERY_SINGLE_ITEM_HEIGHT_CM', '3'), 10),
    multiItemLengthCm: parseInt(optional('DELHIVERY_MULTI_ITEM_LENGTH_CM', '22'), 10),
    multiItemBreadthCm: parseInt(optional('DELHIVERY_MULTI_ITEM_BREADTH_CM', '20'), 10),
    multiItemHeightCm: parseInt(optional('DELHIVERY_MULTI_ITEM_HEIGHT_CM', '5'), 10),
    declaredWeightGrams: parseInt(optional('DELHIVERY_DECLARED_WEIGHT_GRAMS', '500'), 10),
    // Pickup requests are optional and should be batched per warehouse/day.
    autoPickup: optional('DELHIVERY_AUTO_PICKUP', 'false') === 'true',
    pickupTime: optional('DELHIVERY_PICKUP_TIME', '11:00:00'),
    // Optional shared secret for Delhivery scan-push webhooks.
    // When set, /webhooks/delhivery requires ?secret= or x-delhivery-secret header.
    // When empty (default), webhooks stay open for backward compatibility.
    webhookSecret: optional('DELHIVERY_WEBHOOK_SECRET', ''),
    seller: {
      name: optional('DELHIVERY_SELLER_NAME', 'Store Name'),
      address: optional('DELHIVERY_SELLER_ADDRESS', 'Warehouse Address'),
      city: optional('DELHIVERY_SELLER_CITY', 'Mumbai'),
      state: optional('DELHIVERY_SELLER_STATE', 'Maharashtra'),
      pincode: optional('DELHIVERY_SELLER_PINCODE', '400001'),
      phone: optional('DELHIVERY_SELLER_PHONE', '9999999999'),
    },
  },

  // KwiKenage (WhatsApp)
  kwikenage: {
    apiUrl: optional('KWIKENAGE_API_URL', 'https://api.kwikenage.com'),
    // Not required at boot; WhatsApp sends fail with a clear error when unset.
    apiKey: optional('KWIKENAGE_API_KEY', ''),
    senderPhone: optional('KWIKENAGE_SENDER_PHONE', ''),
    templates: {
      orderConfirmed: optional('KWIKENAGE_TEMPLATE_ORDER_CONFIRMED', 'order_confirmed'),
      orderShipped: optional('KWIKENAGE_TEMPLATE_ORDER_SHIPPED', 'order_shipped'),
      outForDelivery: optional('KWIKENAGE_TEMPLATE_OUT_FOR_DELIVERY', 'out_for_delivery'),
      delivered: optional('KWIKENAGE_TEMPLATE_DELIVERED', 'order_delivered'),
      returnInitiated: optional('KWIKENAGE_TEMPLATE_RETURN_INITIATED', 'return_initiated'),
      refundProcessed: optional('KWIKENAGE_TEMPLATE_REFUND_PROCESSED', 'refund_processed'),
      ndr: optional('KWIKENAGE_TEMPLATE_NDR', 'ndr_attempt'),
    },
  },

  // Kapso AI WhatsApp Platform (REST API)
  kapso: {
    apiUrl: optional('KAPSO_API_URL', 'https://api.kapso.ai'),
    apiKey: optional('KAPSO_API_KEY', ''),
    phoneNumberId: optional('KAPSO_PHONE_NUMBER_ID', ''),
    senderPhone: optional('KAPSO_SENDER_PHONE', '+91 88661 54721'),
    enabled: optional('KAPSO_ENABLED', 'true') === 'true',
    templates: {
      orderConfirmed: optional('KAPSO_TEMPLATE_ORDER_CONFIRMED', 'youthnic_order_confirmed'),
      codConfirmation: optional('KAPSO_TEMPLATE_COD_CONFIRMATION', 'youthnic_cod_confirmation'),
      orderDispatched: optional('KAPSO_TEMPLATE_ORDER_SHIPPED', 'youthnic_order_dispatched'),
      outForDelivery: optional('KAPSO_TEMPLATE_OUT_FOR_DELIVERY', 'youthnic_out_for_delivery'),
      delivered: optional('KAPSO_TEMPLATE_DELIVERED', 'youthnic_order_delivered'),
      ndrAttempt: optional('KAPSO_TEMPLATE_NDR', 'youthnic_ndr_reschedule'),
      rtoInitiated: optional('KAPSO_TEMPLATE_RTO', 'youthnic_rto_alert'),
      returnInitiated: optional('KAPSO_TEMPLATE_RETURN', 'youthnic_return_update'),
      refundProcessed: optional('KAPSO_TEMPLATE_REFUND', 'youthnic_refund_processed'),
    },
  },

  // GoKwik (primary payment gateway)
  gokwik: {
    merchantId: optional('GOKWIK_MERCHANT_ID', ''),
    appId: optional('GOKWIK_APP_ID', ''),
    appSecret: optional('GOKWIK_APP_SECRET', ''),
    apiUrl: optional('GOKWIK_API_URL', 'https://gkx.gokwik.co'),
    // GoKwik does not publish a universal payment-status path for every product.
    // Keep this empty until the account team confirms the endpoint for the merchant.
    statusPath: optional('GOKWIK_STATUS_PATH', ''),
    // Confirmed by GoKwik's public WooCommerce integration.
    refundPath: optional('GOKWIK_REFUND_PATH', '/v3/orders/update'),
    verifyEnabled: optional('GOKWIK_VERIFY_ENABLED', 'false') === 'true',
  },

  // PhonePe (secondary payment gateway)
  phonepe: {
    merchantId: optional('PHONEPE_MERCHANT_ID', ''),
    saltKey: optional('PHONEPE_SALT_KEY', ''),
    saltIndex: optional('PHONEPE_SALT_INDEX', '1'),
    apiUrl: optional('PHONEPE_API_URL', 'https://api.phonepe.com/apis/hermes'),
    env: optional('PHONEPE_ENV', 'PRODUCTION'),
    verifyEnabled: optional('PHONEPE_VERIFY_ENABLED', 'false') === 'true',
  },

  // Resend Email API
  resend: {
    apiKey: optional('RESEND_API_KEY', ''),
    // Display name uses uppercase "Youthnic" for branding; the email address
    // itself is lowercase (RFC-compliant) and routed by SendGrid/Resend/Postmark
    // to delivery@youthnic.com mailbox. Override via RESEND_FROM_EMAIL in .env
    // once the youthnic.com domain is verified in Resend.
    fromEmail: optional('RESEND_FROM_EMAIL', 'Youthnic <delivery@youthnic.com>'),
    apiUrl: optional('RESEND_API_URL', 'https://api.resend.com'),
  },

  // Brand identity — used in customer email templates.
  brand: {
    // Public HTTPS URL to the Youthnic logo PNG stored on Firebase Storage.
    // Many email clients (Outlook desktop, older Outlook for Mac) refuse to
    // render base64 inline images, so the logo must be hosted on a public URL.
    // Re-run scripts/upload-email-logo.ts to refresh the binary; then update
    // BRAND_LOGO_URL or set BRAND_LOGO_URL in the .env.
    logoUrl: optional(
      'BRAND_LOGO_URL',
      'https://storage.googleapis.com/shopify-134b9.firebasestorage.app/public/youthnic-logo.png'
    ),
    // Mobile-friendly copy shown beneath the logo in the email header.
    tagline: optional('BRAND_TAGLINE', 'Modernly Ethnic · Surat Fulfillment Center'),
  },

  // Cron schedules
  cron: {
    orderSync: optional('CRON_ORDER_SYNC', '0 * * * *'),
    trackingSync: optional('CRON_TRACKING_SYNC', '*/30 * * * *'),
    retryFailed: optional('CRON_RETRY_FAILED', '0 * * * *'),
    // Backfill POD / signature / QC / sorter images into Firebase Storage.
    // Every 30 minutes by default; rows already populated are skipped (idempotent).
    delhiveryDocFetch: optional('CRON_DELHIVERY_DOC_FETCH', '*/30 * * * *'),
  },

  // Tracking sync resilience — prevents Delhivery 429 fallback during large backlogs.
  // Stale-first + batch cap + min-interval skip keeps each cron cycle bounded.
  tracking: {
    batchLimit: parseInt(optional('TRACKING_SYNC_BATCH_LIMIT', '200'), 10),
    minIntervalMinutes: parseInt(optional('TRACKING_SYNC_MIN_INTERVAL_MINUTES', '10'), 10),
  },

  // Meta Model API (Muse Spark 1.3 Contributor)
  metaLlm: {
    apiKey: optional('MODEL_API_KEY', '') || optional('META_API_KEY', ''),
    baseUrl: optional('META_LLM_BASE_URL', 'https://api.meta.ai/v1'),
    model: optional('META_LLM_MODEL', 'muse-spark-1.3-contributor'),
    fallbackModel: optional('META_LLM_FALLBACK_MODEL', 'muse-spark-1.3'),
  },

  // Firebase Realtime Database & Cloud Storage
  firebase: {
    rtdbUrl: optional('FIREBASE_RTDB_URL', 'https://shopify-134b9-default-rtdb.firebaseio.com'),
    storageBucket: optional('FIREBASE_STORAGE_BUCKET', 'shopify-134b9.firebasestorage.app'),
    serviceAccountPath: optional('FIREBASE_SERVICE_ACCOUNT_PATH', 'firebase-service-account.json'),
    serviceAccountJson: optional('FIREBASE_SERVICE_ACCOUNT_JSON', ''),
  },

  // Logging
  logLevel: optional('LOG_LEVEL', 'info'),
};
