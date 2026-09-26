/**
 * One-off backfill: re-sync the orders that are already in the database so
 * they pick up fields added after the initial import (sales channel / source).
 *
 * Note: fetchOrdersSince filters by updated_at, so it can return orders
 * created before the go-live date. Those are re-synced only when they are
 * already in the database; anything else is skipped, matching the sync floor
 * in order.service.ts.
 *
 * Run with: npx tsx scripts/backfill-order-channel.ts
 */
import { config } from '../src/config';
import prisma from '../src/database/prisma';
import shopifyService from '../src/modules/shopify/shopify.service';

async function main(): Promise<void> {
  const syncStartDate = config.shopify.syncStartDate;
  const orders = await shopifyService.fetchOrdersSince(syncStartDate);
  console.log(`fetched ${orders.length} order(s) updated since ${syncStartDate.toISOString()}`);

  let updated = 0;
  let skipped = 0;
  for (const order of orders) {
    const existing = await prisma.order.findUnique({
      where: { shopifyOrderId: order.id.toString() },
      select: { id: true },
    });
    if (!existing && new Date(order.created_at) < syncStartDate) {
      skipped++;
      continue;
    }
    await shopifyService.syncOrderToDb(order);
    updated++;
  }
  console.log(`re-synced ${updated}, skipped ${skipped} historical order(s)`);

  const rows = await prisma.order.findMany({
    orderBy: { shopifyOrderName: 'desc' },
    select: { shopifyOrderName: true, sourceName: true, salesChannel: true, paymentGateway: true },
  });
  console.log(`\n${rows.length} order(s) in DB after backfill:`);
  for (const row of rows) {
    console.log(`  ${row.shopifyOrderName}  source=${row.sourceName ?? '(none)'}  channel=${row.salesChannel ?? '(unresolved)'}  gateway=${row.paymentGateway ?? '(none)'}`);
  }
}

main()
  .catch((e: any) => {
    console.error('FAIL', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
