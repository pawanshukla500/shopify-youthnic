import cron from 'node-cron';
import { config } from '../config';
import orderService from '../modules/orders/order.service';
import trackingService from '../modules/tracking/tracking.service';
import returnService from '../modules/returns/return.service';
import shopifyService from '../modules/shopify/shopify.service';
import delhiveryDocumentFetcher from '../modules/delhivery/delhivery-document-fetcher.service';
import delhiveryService from '../modules/delhivery/delhivery.service';
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
          logger.info('[CRON] Order sync completed', { count });
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
        try {
          const pickup = await delhiveryService.ensureDailyWarehousePickup();
          if (!pickup.skipped) {
            logger.info('[CRON] Warehouse pickup', { message: pickup.message, pickupId: pickup.pickupId });
          }
        } catch (error: any) {
          logger.error('[CRON] Warehouse pickup failed', { error: error.message });
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

    // 4. Delhivery document backfill (EPOD / signature / QC / sorter → Firebase Storage)
    // Runs every 30 minutes by default. Idempotent — only fetches rows missing the artifact.
    this.jobs.push(
      cron.schedule(config.cron.delhiveryDocFetch || '*/30 * * * *', async () => {
        logger.info('[CRON] Running Delhivery document fetcher...');
        try {
          await delhiveryDocumentFetcher.runAll();
        } catch (error: any) {
          logger.error('[CRON] Delhivery document fetcher failed', { error: error.message });
        }
      })
    );

    logger.info('Scheduler started successfully', {
      orderSync: config.cron.orderSync,
      trackingSync: config.cron.trackingSync,
      retryFailed: config.cron.retryFailed,
      delhiveryDocFetch: config.cron.delhiveryDocFetch || '*/30 * * * *',
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
