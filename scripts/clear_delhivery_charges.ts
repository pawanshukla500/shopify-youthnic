import prisma from '../src/database/prisma';

async function main() {
  console.log('--- CLEARING ONLY DELHIVERY SHIPPING CHARGES (WALLET REPORT) ---');

  // 1. Find imports with kind = DELHIVERY_CHARGES
  const imports = await prisma.reconciliationImport.findMany({
    where: { kind: 'DELHIVERY_CHARGES' },
    select: { id: true, fileName: true, createdAt: true, rowCount: true, matchedCount: true },
  });
  console.log(`Found ${imports.length} DELHIVERY_CHARGES import records to delete:`, imports);

  // 2. Delete only DELHIVERY_CHARGES imports
  const deleteResult = await prisma.reconciliationImport.deleteMany({
    where: { kind: 'DELHIVERY_CHARGES' },
  });
  console.log(`Deleted ${deleteResult.count} DELHIVERY_CHARGES import records.`);

  // 3. Reset shipment charges on shipments that had ACTUAL charges
  const resetShipments = await prisma.shipment.updateMany({
    where: {
      OR: [
        { shippingCostSource: 'ACTUAL' },
        { totalDebited: { gt: 0 } },
        { totalCredited: { gt: 0 } },
      ],
    },
    data: {
      shippingCostSource: 'ESTIMATE',
      forwardCharge: null,
      totalDebited: 0,
      totalCredited: 0,
      netBilledCost: 0,
      walletTransactions: undefined,
      billingStatus: 'ESTIMATED',
    },
  });
  console.log(`Reset ${resetShipments.count} shipments to ESTIMATE / clean charges.`);

  // 4. Reset orders with shippingAudited = true
  const resetOrders = await prisma.order.updateMany({
    where: { shippingAudited: true },
    data: {
      shippingAudited: false,
      actualShippingCost: null,
    },
  });
  console.log(`Reset ${resetOrders.count} orders with audited shipping cost.`);

  // 5. Verify remittances are UNTOUCHED
  const remittancesCount = await prisma.reconciliationImport.count({
    where: { kind: 'DELHIVERY_REMITTANCE' },
  });
  console.log(`Verified DELHIVERY_REMITTANCE imports remaining untouched: ${remittancesCount}`);
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
