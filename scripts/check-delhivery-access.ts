/**
 * Delhivery access + webhook checklist.
 *
 * Validates env usage/limits without leaking secrets, then performs live
 * probes (serviceability + TAT) when DELHIVERY_API_TOKEN is present.
 *
 * Run with: npm run delhivery:check
 * No database required — reads .env only.
 */
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

function present(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function mask(value: string | undefined): string {
  if (!value) return '(missing)';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-2)} (len ${value.length})`;
}

async function main(): Promise<void> {
  console.log('── Delhivery env ──');
  const token = process.env.DELHIVERY_API_TOKEN || '';
  const baseUrl = process.env.DELHIVERY_BASE_URL || 'https://track.delhivery.com';
  const pickup = process.env.DELHIVERY_PICKUP_LOCATION || '';
  const sellerPin = process.env.DELHIVERY_SELLER_PINCODE || '395002';
  const appBase = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const webhookSecret = process.env.DELHIVERY_WEBHOOK_SECRET || '';

  console.log(`DELHIVERY_API_TOKEN:      ${mask(token)}`);
  console.log(`DELHIVERY_BASE_URL:       ${baseUrl}`);
  console.log(`DELHIVERY_PICKUP_LOCATION:${pickup || '(missing — REQUIRED, exact warehouse name)'}`);
  console.log(`SELLER: ${process.env.DELHIVERY_SELLER_NAME || '(default)'} / ${process.env.DELHIVERY_SELLER_CITY || '(default)'} ${sellerPin}`);
  console.log(`APP_BASE_URL:             ${appBase} ${/^https:\/\//i.test(appBase) ? '(HTTPS OK)' : '(NOT HTTPS — webhooks will fail)'}`);
  console.log(`DELHIVERY_WEBHOOK_SECRET: ${webhookSecret ? 'set (share with Delhivery team)' : '(empty — webhook open)'}`);
  console.log(`TRACKING LIMITS: batch ${process.env.TRACKING_SYNC_BATCH_LIMIT || '200'}/cycle, skip-fresh ${process.env.TRACKING_SYNC_MIN_INTERVAL_MINUTES || '10'}min, bulk-track 50/req, webhook 500/req`);

  console.log('\n── Expected webhook URLs (give these to providers) ──');
  console.log(`Shopify (auto via POST /api/setup/webhooks): ${appBase}/webhooks/shopify`);
  console.log(`Delhivery scan-push (email to lastmile-integration@delhivery.com): ${appBase}/webhooks/delhivery${webhookSecret ? '?secret=****' : ''}`);
  console.log(`Delhivery EPOD push (email to lastmile-integration@delhivery.com): ${appBase}/webhooks/delhivery/epod${webhookSecret ? '?secret=****' : ''}`);
  console.log(`WhatsApp inbound (public, GET+POST): ${appBase}/api/webhooks/whatsapp`);

  if (!token) {
    console.log('\nNo DELHIVERY_API_TOKEN — skipping live probes. Add the production token to .env.');
    process.exit(pickup ? 0 : 1);
  }

  const client = axios.create({
    baseURL: baseUrl,
    headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
    timeout: 20000,
  });

  console.log('\n── Live probes ──');
  try {
    const svc = await client.get('/c/api/pin-codes/json/', { params: { filter_codes: sellerPin } });
    const codes = svc.data?.delivery_codes || [];
    console.log(`Serviceability ${sellerPin}: ${codes.length ? 'OK' : 'NSZ (not serviceable)'} (${codes.length} codes)`);
  } catch (e: any) {
    console.log(`Serviceability probe failed (HTTP ${e.response?.status || '?'}): ${e.message}`);
  }

  try {
    const tat = await client.get('/api/dc/expected_tat', {
      params: { origin_pin: sellerPin, destination_pin: '400001', mot: 'S' },
    });
    console.log(`TAT probe: OK (${JSON.stringify(tat.data).slice(0, 120)}…)`);
  } catch (e: any) {
    console.log(`TAT probe failed (HTTP ${e.response?.status || '?'}): ${e.message}`);
  }

  if (!pickup) {
    console.log('\nFAIL: DELHIVERY_PICKUP_LOCATION is required (exact registered warehouse name).');
    process.exit(1);
  }
  console.log('\nDelhivery access check complete.');
}

main();
