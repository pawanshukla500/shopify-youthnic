import prisma from '../src/database/prisma';
import logger from '../src/utils/logger';
import { normalizeLegacyShipmentCouriers } from '../src/utils/courier';

async function main() {
  logger.info('Starting manual legacy courier normalization script...');
  await normalizeLegacyShipmentCouriers(prisma);
  const counts = await prisma.shipment.groupBy({
    by: ['courier'],
    _count: { id: true },
  });
  console.log('Normalized shipment counts by courier:', counts);
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
