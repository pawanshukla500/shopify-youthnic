import prisma from './prisma';
import logger from '../utils/logger';

/**
 * Cleanly purge operational data (orders, items, shipments, tracking, returns, logs)
 * to start fresh from 26-Sep-2026 as commanded.
 * Preserves database table schemas, foreign keys, and application configuration.
 */
export async function clearOperationalDatabase(): Promise<{
  deletedReturns: number;
  deletedShipments: number;
  deletedOrderItems: number;
  deletedOrders: number;
  deletedTrackingLogs: number;
  deletedEmailLogs: number;
  deletedInboundEmails: number;
  deletedNotifications: number;
  deletedSyncLogs: number;
}> {
  logger.info('Initiating database purge for fresh start from 26-Sep-2026...');

  const result = await prisma.$transaction(async (tx) => {
    // 1. Delete Return Items & Returns
    await tx.returnItem.deleteMany({});
    const returns = await tx.return.deleteMany({});

    // 2. Delete Tracking Logs
    const trackingLogs = await tx.trackingLog.deleteMany({});

    // 3. Delete Shipments
    const shipments = await tx.shipment.deleteMany({});

    // 4. Delete Notifications, Email Logs & Inbound Emails
    const notifications = await tx.notification.deleteMany({});
    const emailLogs = await tx.emailLog.deleteMany({});
    const inboundEmails = await tx.inboundEmail.deleteMany({});

    // 5. Delete Order Items
    const orderItems = await tx.orderItem.deleteMany({});

    // 6. Delete Sync Logs
    const syncLogs = await tx.syncLog.deleteMany({});

    // 7. Delete Orders
    const orders = await tx.order.deleteMany({});

    return {
      deletedReturns: returns.count,
      deletedShipments: shipments.count,
      deletedOrderItems: orderItems.count,
      deletedOrders: orders.count,
      deletedTrackingLogs: trackingLogs.count,
      deletedEmailLogs: emailLogs.count,
      deletedInboundEmails: inboundEmails.count,
      deletedNotifications: notifications.count,
      deletedSyncLogs: syncLogs.count,
    };
  });

  logger.info('Database purge completed successfully', result);
  return result;
}

// Allow direct CLI execution
if (require.main === module) {
  clearOperationalDatabase()
    .then((stats) => {
      // eslint-disable-next-line no-console
      console.log('PURGE_SUCCESS:', stats);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('PURGE_FAILED:', err);
      process.exit(1);
    });
}
