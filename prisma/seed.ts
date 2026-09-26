import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Seed default settings
  await prisma.setting.upsert({
    where: { key: 'last_order_sync' },
    create: { key: 'last_order_sync', value: new Date(0).toISOString() },
    update: {},
  });

  await prisma.setting.upsert({
    where: { key: 'auto_dispatch_enabled' },
    create: { key: 'auto_dispatch_enabled', value: 'true' },
    update: {},
  });

  await prisma.setting.upsert({
    where: { key: 'auto_refund_on_qc_approved' },
    create: { key: 'auto_refund_on_qc_approved', value: 'true' },
    update: {},
  });

  console.log('Seed data inserted successfully');
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
