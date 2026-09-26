/**
 * One-off diagnostic: prove the dispatch gate blocks orders that Shopify
 * considers voided, refunded, or cancelled, using the exact production gate
 * logic (blockedDispatchReason from payment.service.ts).
 *
 * Reports how many of those orders would have been handed to the courier under
 * the old gate (COD orders and captured prepaid orders passed automatically).
 * Read-only: nothing is written to the database or to Shopify.
 *
 * Run with: npx tsx scripts/verify-dispatch-gate.ts
 */
import axios, { AxiosInstance } from 'axios';
import dotenv from 'dotenv';
import paymentService, { blockedDispatchReason } from '../src/modules/payments/payment.service';

dotenv.config();

async function getToken(shopDomain: string): Promise<string> {
  const legacy = process.env.SHOPIFY_ACCESS_TOKEN;
  if (legacy) {
    return legacy;
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env');
  }

  const response = await axios.post(
    `https://${shopDomain}/admin/oauth/access_token`,
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  return response.data.access_token;
}

interface SurveyedOrder {
  name: string;
  financialStatus: string;
  cancelledAt: string | null;
  gateways: string[];
  txSummary: string;
  detectedGateway: string;
  isPrepaid: boolean;
  paymentCaptured: boolean;
  oldGateWouldShip: boolean;
  newGateReason: string | null;
}

async function survey(
  client: AxiosInstance,
  financialStatus: string,
  limit: number
): Promise<SurveyedOrder[]> {
  const response = await client.get('/orders.json', {
    params: {
      status: 'any',
      financial_status: financialStatus,
      limit,
      fields: 'id,name,financial_status,cancelled_at,payment_gateway_names',
    },
  });

  const orders: any[] = response.data.orders || [];
  const surveyed: SurveyedOrder[] = [];

  for (const order of orders) {
    let detected = { gateway: 'COD', isPrepaid: false, paymentCaptured: true };
    let txSummary = 'none';

    try {
      const txResponse = await client.get(`/orders/${order.id}/transactions.json`);
      const transactions: any[] = txResponse.data.transactions || [];
      detected = paymentService.detectGateway(transactions);
      txSummary =
        transactions.map((t) => `${t.gateway}/${t.kind}/${t.status}`).join(', ') || 'none';
    } catch (error: any) {
      txSummary = `transactions unreadable (HTTP ${error.response?.status || '?'})`;
    }

    // Old gate: COD always passed regardless of captured state; prepaid passed
    // only when its transaction showed captured.
    const oldGateWouldShip = !detected.isPrepaid || detected.paymentCaptured;

    // New gate: order state is checked before anything else. An order synced
    // into our DB starts as NEW, so we test with 'NEW' — the financial status
    // alone must block it.
    const newGateReason = blockedDispatchReason(order.financial_status, 'NEW');

    surveyed.push({
      name: order.name,
      financialStatus: order.financial_status,
      cancelledAt: order.cancelled_at || null,
      gateways: order.payment_gateway_names || [],
      txSummary,
      detectedGateway: detected.gateway,
      isPrepaid: detected.isPrepaid,
      paymentCaptured: detected.paymentCaptured,
      oldGateWouldShip,
      newGateReason,
    });
  }

  return surveyed;
}

async function main(): Promise<void> {
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  if (!shopDomain) {
    console.error('SHOPIFY_SHOP_DOMAIN is not set.');
    process.exit(1);
  }

  const apiVersion = process.env.SHOPIFY_API_VERSION || '2026-07';
  const token = await getToken(shopDomain);
  const client = axios.create({
    baseURL: `https://${shopDomain}/admin/api/${apiVersion}`,
    headers: { 'X-Shopify-Access-Token': token },
    timeout: 30000,
  });

  console.log(`Checking the dispatch gate on ${shopDomain} (Admin API ${apiVersion}) ...\n`);

  let previouslyShipped = 0;
  let nowBlocked = 0;
  let nowAllowed = 0;

  for (const status of ['voided', 'refunded']) {
    const surveyed = await survey(client, status, 250);
    console.log(`── financial_status=${status}: ${surveyed.length} order(s)`);
    for (const s of surveyed) {
      if (s.newGateReason) {
        nowBlocked++;
        if (s.oldGateWouldShip) {
          previouslyShipped++;
        }
      } else {
        nowAllowed++;
      }
      console.log(
        `  ${s.name.padEnd(10)} cancelled_at=${s.cancelledAt ? 'yes' : 'no'.padEnd(3)} ` +
          `gateways=[${s.gateways.join(', ') || 'none'}]  tx: ${s.txSummary}`
      );
      console.log(
        `      NEW GATE: ${s.newGateReason ? 'BLOCKED' : 'allowed'.padEnd(6)} ` +
          `(${s.newGateReason || `gateway ${s.detectedGateway}, captured=${s.paymentCaptured}`})` +
          `${s.oldGateWouldShip && s.newGateReason ? '   ← would have shipped under the old gate' : ''}`
      );
    }
  }

  // Control group: paid orders must NOT be blocked.
  const control = await survey(client, 'paid', 3);
  console.log(`\n── control: financial_status=paid (first ${control.length})`);
  for (const s of control) {
    if (s.newGateReason) {
      nowBlocked++;
    } else {
      nowAllowed++;
    }
    console.log(
      `  ${s.name.padEnd(10)} gateways=[${s.gateways.join(', ') || 'none'}]  tx: ${s.txSummary}`
    );
    console.log(
      `      NEW GATE: ${s.newGateReason ? 'BLOCKED' : 'allowed'} ` +
        `(${s.newGateReason || `gateway ${s.detectedGateway}, captured=${s.paymentCaptured}`})`
    );
  }

  console.log('\n── Summary ──────────────────────────────────────');
  console.log(`  orders now blocked by the gate:   ${nowBlocked}`);
  console.log(`  orders still allowed:             ${nowAllowed}`);
  console.log(`  of the blocked, previously shipped under the old gate: ${previouslyShipped}`);
}

main().catch((error: any) => {
  console.error(
    `\nFailed: HTTP ${error.response?.status || '?'} ` +
      JSON.stringify(error.response?.data || error.message)
  );
  process.exit(1);
});
