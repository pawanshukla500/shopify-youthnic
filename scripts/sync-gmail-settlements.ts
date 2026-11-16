/**
 * Run Gmail Settlement Reconciliation manually from CLI
 *
 * Usage:
 *   npx tsx scripts/sync-gmail-settlements.ts
 *   npx tsx scripts/sync-gmail-settlements.ts --max=50
 *   npx tsx scripts/sync-gmail-settlements.ts --query="label:easebuzz-settelments has:attachment"
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/database/prisma';
import gmailSettlementService from '../src/modules/accounts/gmail-settlement.service';

async function main() {
  console.log('====================================================');
  console.log('  Youthnic OMS - Gmail Settlement Automated Sync');
  console.log('====================================================\n');

  if (!gmailSettlementService.isConfigured()) {
    console.error('â Œ Gmail credentials are not configured in .env.');
    console.error('Please run: npm run gmail:connect');
    process.exit(1);
  }

  // Parse command line arguments
  const args = process.argv.slice(2);
  let maxMessages = 25;
  let query: string | undefined = undefined;
  let force = false;
  let unreadOnly = false;

  for (const arg of args) {
    if (arg.startsWith('--max=')) {
      maxMessages = parseInt(arg.split('=')[1], 10) || 25;
    } else if (arg.startsWith('--query=')) {
      query = arg.split('=')[1];
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--unread-only' || arg === '--unread') {
      unreadOnly = true;
    }
  }

  console.log(`Starting Gmail settlement sync (max: ${maxMessages}, unreadOnly: ${unreadOnly})...\n`);
  const result = await gmailSettlementService.syncSettlementEmails({
    maxMessages,
    query,
    unreadOnly,
    forceReimport: force,
  });

  console.log('\n====================================================');
  console.log('  Sync Summary');
  console.log('====================================================');
  console.log(`Emails Scanned:         ${result.emailsScanned}`);
  console.log(`Emails Processed:       ${result.emailsProcessed}`);
  console.log(`Settlements Imported:   ${result.settlementsImported}`);
  console.log(`Orders Matched:         ${result.matchedOrdersCount}`);
  console.log(`Refunds Debited:        ${result.refundsDebitedCount}`);
  console.log(`Total Amount Settled:   â‚¹${result.totalAmountSettled.toFixed(2)}`);

  if (result.results.length > 0) {
    console.log('\nProcessed Settlements:');
    for (const r of result.results) {
      console.log(`  - [${r.messageId}] ${r.fileName} | UTR: ${r.utr || 'Auto-Detected'} | Matched: ${r.matchedCount}/${r.rowCount}`);
    }
  }

  if (result.errors.length > 0) {
    console.log('\nWarnings / Errors:');
    for (const err of result.errors) {
      console.log(`  âš ï¸  ${err}`);
    }
  }

  console.log('====================================================\n');
}

main()
  .catch((e) => {
    console.error('Fatal sync error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
