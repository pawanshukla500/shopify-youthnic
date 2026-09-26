/**
 * Fetch one Shopify order and print the fields the OMS depends on.
 *
 * Usage:
 *   npm run order:fetch -- 26YOU5750        (by order name)
 *   npm run order:fetch -- 1234567890123    (by numeric order id)
 *
 * Reads credentials from .env / the environment. Standalone on purpose, so it
 * runs without a database or the other OMS variables configured.
 *
 * Customer phone and email are partially masked in the output: this script is
 * for verifying access, not for exporting contact details. The unmasked values
 * are what the OMS stores and passes to Delhivery and WhatsApp.
 */
import axios, { AxiosInstance } from 'axios';
import dotenv from 'dotenv';

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

function mask(value: string | null | undefined): string {
  if (!value) {
    return '(empty)';
  }
  if (value.includes('@')) {
    const [local, domain] = value.split('@');
    const head = local.slice(0, 2);
    return `${head}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
  }
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) {
    return '*'.repeat(value.length);
  }
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

async function findOrder(client: AxiosInstance, term: string): Promise<any | null> {
  // Shopify's name filter matches with or without the "#" prefix, so try the
  // raw term first, then the common "#" form.
  for (const name of [term, `#${term}`]) {
    const response = await client.get('/orders.json', {
      params: { name, status: 'any', limit: 50 },
    });
    const orders: any[] = response.data.orders || [];
    if (orders.length > 0) {
      const exact = orders.find(
        (o) => o.name === term || o.name === `#${term}` || String(o.order_number) === term
      );
      return exact || orders[0];
    }
  }

  // Fall back to treating the term as a numeric order id.
  if (/^\d+$/.test(term)) {
    try {
      const response = await client.get(`/orders/${term}.json`);
      return response.data.order || null;
    } catch {
      return null;
    }
  }

  return null;
}

async function main(): Promise<void> {
  const term = process.argv[2];
  if (!term) {
    console.error('Pass an order name or id, e.g. npm run order:fetch -- 26YOU5750');
    process.exit(1);
  }

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
    timeout: 20000,
  });

  console.log(`Searching ${shopDomain} for order "${term}" via Admin API ${apiVersion} ...\n`);

  const order = await findOrder(client, term);
  if (!order) {
    console.error(`No order found matching "${term}".`);
    console.error('Check the exact order name in Shopify admin, including any prefix.');
    process.exit(1);
  }

  const ship = order.shipping_address || {};
  console.log('── Order ──────────────────────────────');
  console.log(`  name:               ${order.name}`);
  console.log(`  id:                 ${order.id}`);
  console.log(`  created_at:         ${order.created_at}`);
  console.log(`  financial_status:   ${order.financial_status}`);
  console.log(`  fulfillment_status: ${order.fulfillment_status || '(unfulfilled)'}`);
  console.log(`  total:              ${order.total_price} ${order.currency}`);
  console.log(`  cancelled_at:       ${order.cancelled_at || '(not cancelled)'}`);

  console.log('\n── Customer (PII access check) ────────');
  const customer = order.customer || {};
  const fullName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
  console.log(`  name:               ${fullName || '(empty)'}`);
  console.log(`  email:              ${mask(order.email || customer.email)}`);
  console.log(`  phone:              ${mask(order.phone || ship.phone || customer.phone)}`);

  console.log('\n── Shipping address ───────────────────');
  console.log(`  line1:              ${ship.address1 || '(empty)'}`);
  console.log(`  line2:              ${ship.address2 || '(empty)'}`);
  console.log(`  city/state/pin:     ${ship.city || '?'} / ${ship.province || '?'} / ${ship.zip || '?'}`);
  console.log(`  country:            ${ship.country || '(empty)'}`);

  console.log('\n── Line items ─────────────────────────');
  for (const item of order.line_items || []) {
    console.log(`  ${item.quantity} x ${item.title}  [sku: ${item.sku || 'none'}]  ${item.price}`);
  }

  console.log('\n── Transactions (gateway detection) ───');
  try {
    const txResponse = await client.get(`/orders/${order.id}/transactions.json`);
    const transactions: any[] = txResponse.data.transactions || [];
    if (transactions.length === 0) {
      console.log('  none — the OMS treats this as COD');
    }
    for (const tx of transactions) {
      console.log(`  gateway=${tx.gateway}  kind=${tx.kind}  status=${tx.status}  amount=${tx.amount}`);
    }

    const primary = transactions.find(
      (t) => t.kind === 'sale' || t.kind === 'capture' || t.kind === 'authorization'
    );
    const isPrepaid = Boolean(primary) && !/cash_on_delivery|(^|_)cod(_|$)/i.test(primary.gateway);
    const captured =
      Boolean(primary) && (primary.status === 'success' || primary.status === 'captured');

    console.log('\n── What the OMS would do ──────────────');
    console.log(`  payment method:     ${isPrepaid ? 'Pre-paid' : 'COD'}`);
    console.log(
      `  dispatch allowed:   ${
        !isPrepaid || captured ? 'yes' : 'no (prepaid payment not captured)'
      }`
    );
  } catch (error: any) {
    console.log(
      `  could not read transactions: HTTP ${error.response?.status || '?'} ` +
        JSON.stringify(error.response?.data || error.message)
    );
  }

  console.log('\nShopify read succeeded.');
}

main().catch((error: any) => {
  console.error(
    `\nFailed: HTTP ${error.response?.status || '?'} ` +
      JSON.stringify(error.response?.data || error.message)
  );
  process.exit(1);
});
