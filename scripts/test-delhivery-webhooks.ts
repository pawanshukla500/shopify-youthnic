/**
 * Test Delhivery Webhook endpoints (Scan Push + EPOD)
 *
 * Verifies both standard (/webhooks/delhivery, /webhooks/delhivery/epod)
 * and root alias (/delhivery, /delhivery/epod) routes.
 *
 * Usage:
 *   npx tsx scripts/test-delhivery-webhooks.ts [baseUrl]
 * Default baseUrl: http://localhost:3000 (or set APP_BASE_URL in .env)
 */
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const baseUrl = (process.argv[2] || process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

async function run(): Promise<void> {
  console.log(`\n── Testing Delhivery Webhooks at: ${baseUrl} ──\n`);

  const client = axios.create({
    baseURL: baseUrl,
    timeout: 10000,
    validateStatus: () => true, // capture all statuses
  });

  // 1. Scan Push - Standard route
  console.log('1. Testing Scan Push standard endpoint: POST /webhooks/delhivery');
  const scanPayload = {
    Shipment: {
      AWB: 'TEST999888111',
      ReferenceNo: 'TEST-ORDER-1',
      Status: {
        Status: 'In Transit',
        StatusType: 'UD',
        StatusLocation: 'Surat_Hub',
        StatusDateTime: new Date().toISOString(),
        Instructions: 'Parcel moving between hubs',
      },
    },
  };
  const scanRes = await client.post('/webhooks/delhivery', scanPayload);
  console.log(`   Response status: ${scanRes.status}`);
  console.log(`   Response data:   ${JSON.stringify(scanRes.data)}\n`);

  // 2. Scan Push - Root alias route
  console.log('2. Testing Scan Push root alias endpoint: POST /delhivery');
  const scanAliasRes = await client.post('/delhivery', scanPayload);
  console.log(`   Response status: ${scanAliasRes.status}`);
  console.log(`   Response data:   ${JSON.stringify(scanAliasRes.data)}\n`);

  // 3. EPOD - Standard route
  console.log('3. Testing EPOD standard endpoint: POST /webhooks/delhivery/epod');
  const epodPayload = {
    waybill: 'TEST999888111',
    orderID: 'TEST-ORDER-1',
    receivedBy: 'Test Recipient',
    timestamp: new Date().toISOString(),
    EPOD: 'https://placehold.co/400x400.png',
  };
  const epodRes = await client.post('/webhooks/delhivery/epod', epodPayload);
  console.log(`   Response status: ${epodRes.status}`);
  console.log(`   Response data:   ${JSON.stringify(epodRes.data)}\n`);

  // 4. EPOD - Root alias route
  console.log('4. Testing EPOD root alias endpoint: POST /delhivery/epod');
  const epodAliasRes = await client.post('/delhivery/epod', epodPayload);
  console.log(`   Response status: ${epodAliasRes.status}`);
  console.log(`   Response data:   ${JSON.stringify(epodAliasRes.data)}\n`);

  console.log('── Webhook probe complete. Check responses above. ──\n');
}

run().catch((err) => {
  console.error('Webhook test runner error:', err.message);
  process.exit(1);
});
