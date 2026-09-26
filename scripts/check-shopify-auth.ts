/**
 * Standalone Shopify auth check.
 *
 * Verifies that SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET can obtain an access
 * token for SHOPIFY_SHOP_DOMAIN, and reports the granted scopes. Reads values
 * from .env / the environment so no secret is ever typed on a command line.
 *
 * Intentionally does not import src/config, so it runs without a database or
 * any of the other OMS environment variables configured.
 *
 * Run with: npm run auth:check
 */
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const REQUIRED_SCOPES = ['read_orders', 'write_orders'];

async function main(): Promise<void> {
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const legacyToken = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!shopDomain) {
    fail('SHOPIFY_SHOP_DOMAIN is not set.');
  }

  if (legacyToken) {
    console.log('SHOPIFY_ACCESS_TOKEN is set, so the OMS will use that legacy token');
    console.log('and skip the client credentials grant. Unset it to test client credentials.\n');
  }

  if (!clientId || !clientSecret) {
    fail('Set both SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env first.');
  }

  console.log(`Requesting an access token for ${shopDomain} ...`);

  let token: string;
  try {
    const response = await axios.post(
      `https://${shopDomain}/admin/oauth/access_token`,
      new URLSearchParams({
        client_id: clientId!,
        client_secret: clientSecret!,
        grant_type: 'client_credentials',
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      }
    );

    token = response.data.access_token;
    const grantedScopes: string[] = (response.data.scope || '')
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean);

    console.log('Token acquired.');
    console.log(`  expires_in: ${response.data.expires_in} seconds`);
    console.log(`  scopes:     ${grantedScopes.join(', ') || '(none)'}`);

    // A write_<resource> scope implies read_<resource>, so treat it as covering
    // the matching read scope.
    const missing = REQUIRED_SCOPES.filter((scope) => {
      if (grantedScopes.includes(scope)) {
        return false;
      }
      const implied = scope.startsWith('read_')
        ? `write_${scope.slice('read_'.length)}`
        : null;
      return !(implied && grantedScopes.includes(implied));
    });
    if (missing.length > 0) {
      console.log(`\nMissing required scope(s): ${missing.join(', ')}`);
      console.log('Add them to your app version in the Dev Dashboard, release the version,');
      console.log('then approve the scope change on the store.');
    }
  } catch (error: any) {
    const body = JSON.stringify(error.response?.data || error.message);
    if (body.includes('shop_not_permitted')) {
      fail(
        'shop_not_permitted — the app and the store are not in the same Shopify ' +
          'organization. Confirm the store is listed under "Dev stores" in the same ' +
          'Dev Dashboard organization as the app.'
      );
    }
    fail(`Token request failed (HTTP ${error.response?.status || '?'}): ${body}`);
  }

  // Confirm the token can actually read orders through the configured API version.
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2026-07';
  console.log(`\nReading one order via Admin API ${apiVersion} ...`);
  try {
    const orders = await axios.get(
      `https://${shopDomain}/admin/api/${apiVersion}/orders.json`,
      {
        params: { limit: 1, status: 'any' },
        headers: { 'X-Shopify-Access-Token': token! },
        timeout: 15000,
      }
    );
    const count = (orders.data.orders || []).length;
    console.log(`Order read succeeded. Orders returned: ${count}`);
    console.log('\nShopify authentication is working.');
  } catch (error: any) {
    fail(
      `Order read failed (HTTP ${error.response?.status || '?'}): ` +
        JSON.stringify(error.response?.data || error.message)
    );
  }
}

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

main();
