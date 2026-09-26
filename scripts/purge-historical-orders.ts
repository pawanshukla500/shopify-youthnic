/**
 * One-off cleanup: remove orders created before the OMS go-live date so the
 * system only carries today onward. The data remains in Shopify and can be
 * re-imported by moving ORDER_SYNC_START_DATE back, so this is reversible.
 *
 * Run with: npx tsx scripts/purge-historical-orders.ts
 */
import prisma from '../src/database/prisma';

async function main(): Promise<void> {
  const cutoff = new Date('2026-09-23T18:30:00.000Z'); // midnight IST on 2026-09-24
  const before = await prisma.order.count();
  const old = await prisma.order.count({ where: { shopifyCreatedAt: { lt: cutoff } } });
  console.log(`before: ${before} orders, deleting ${old} created before ${cutoff.toISOString()}`);

  const deleted = await prisma.order.deleteMany({
    where: { shopifyCreatedAt: { lt: cutoff } },
  });
  console.log(`deleted: ${deleted.count}`);

  const remaining = await prisma.order.findMany({
    orderBy: { shopifyOrderName: 'desc' },
    select: { shopifyOrderName: true, customerName: true, shopifyCreatedAt: true, financialStatus: true },
  });
  console.log(`remaining: ${remaining.length}`);
  for (const o of remaining) {
    console.log(`  ${o.shopifyOrderName}  ${o.customerName}  ${o.shopifyCreatedAt.toISOString()}  ${o.financialStatus}`);
  }
}

main()
  .catch((e: any) => {
    console.error(e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
