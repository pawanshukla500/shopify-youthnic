import cron from 'node-cron';
import { config } from '../config';
import orderService from '../modules/orders/order.service';
import trackingService from '../modules/tracking/tracking.service';
import returnService from '../modules/returns/return.service';
import shopifyService from '../modules/shopify/shopify.service';
import logger from '../utils/logger';

/**
 * Scheduler
 * Manages all background cron jobs for automated sync operations.
 */
class Scheduler {
  private jobs: cron.ScheduledTask[] = [];

  /**
   * Start all scheduled jobs.
   */
  start(): void {
    logger.info('Starting scheduler...');

    // 1. Order sync — fetch new orders from Shopify
    this.jobs.push(
      cron.schedule(config.cron.orderSync, async () => {
        logger.info('[CRON] Running order sync...');
        try {
          const count = await orderService.syncOrdersFromShopify();
          // Auto-dispatch any new orders
          if (count > 0) {
            await orderService.autoDispatchPendingOrders();
          }
        } catch (error: any) {
          logger.error('[CRON] Order sync failed', { error: error.message });
        }
      })
    );

    // 2. Tracking sync — pull tracking updates from Delhivery
    this.jobs.push(
      cron.schedule(config.cron.trackingSync, async () => {
        logger.info('[CRON] Running tracking sync...');
        try {
          await trackingService.syncAllTracking();
        } catch (error: any) {
          logger.error('[CRON] Tracking sync failed', { error: error.message });
        }
      })
    );

    // 3. Retry failed syncs/refunds
    this.jobs.push(
      cron.schedule(config.cron.retryFailed, async () => {
        logger.info('[CRON] Running retry failed operations...');
        try {
          await returnService.retryFailedRefunds();
        } catch (error: any) {
          logger.error('[CRON] Retry failed operations error', { error: error.message });
        }
      })
    );

    logger.info('Scheduler started successfully', {
      orderSync: config.cron.orderSync,
      trackingSync: config.cron.trackingSync,
      retryFailed: config.cron.retryFailed,
    });
  }

  /**
   * Stop all scheduled jobs (for graceful shutdown).
   */
  stop(): void {
    this.jobs.forEach((job) => job.stop());
    this.jobs = [];
    logger.info('Scheduler stopped');
  }
}

export default new Scheduler();
