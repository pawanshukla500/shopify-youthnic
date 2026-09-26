/**
 * One-off diagnostic: list the distinct payment gateway strings this store uses,
 * so gateway detection and COD vs prepaid classification can be matched to the
 * real values. Read-only.
 *
 * Run with: npx tsx scripts/gateway-survey.ts
 */
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

async function main(): Promise<void> {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN!;
  const tokenResponse = await axios.post(
    `https://${shop}/admin/oauth/access_token`,
    new URLSearchParams({
      client_id: process.env.SHOPIFY_CLIENT_ID!,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET!,
      grant_type: 'client_credentials',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const client = axios.create({
    baseURL: `https://${shop}/admin/api/${process.env.SHOPIFY_API_VERSION || '2026-07'}`,
    headers: { 'X-Shopify-Access-Token': tokenResponse.data.access_token },
    timeout: 30000,
  });

  const response = await client.get('/orders.json', {
    params: {
      status: 'any',
      limit: 250,
      fields: 'id,name,financial_status,payment_gateway_names',
    },
  });

  const orders: any[] = response.data.orders || [];
  const tally = new Map<string, number>();

  for (const order of orders) {
    const gateways: string[] =
      order.payment_gateway_names && order.payment_gateway_names.length > 0
        ? order.payment_gateway_names
        : ['(none)'];
    for (const gateway of gateways) {
      const key = `${gateway}  |  financial_status=${order.financial_status}`;
      tally.set(key, (tally.get(key) || 0) + 1);
    }
  }

  console.log(`Gateway strings across the last ${orders.length} orders:\n`);
  for (const [key, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)} x  ${key}`);
  }
}

main().catch((error: any) => {
  console.error(
    `Failed: HTTP ${error.response?.status || '?'} ` +
      JSON.stringify(error.response?.data || error.message)
  );
  process.exit(1);
});
