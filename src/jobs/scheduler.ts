import cron from 'node-cron';
import { config } from '../config';
import orderService from '../modules/orders/order.service';
import trackingService from '../modules/tracking/tracking.service';
import returnService from '../modules/returns/return.service';
import shopifyService from '../modules/shopify/shopify.service';
import delhiveryDocumentFetcher from '../modules/delhivery/delhivery-document-fetcher.service';
import { runAccountsMaintenance } from '../modules/accounts/accounts.service';
import { backfillMissingRefundTrailEvents } from '../modules/accounts/account-trail.service';
import { sendDueMonthlyReport } from '../modules/accounts/accounts-report.service';
import { estimatePendingShippingCosts } from '../modules/accounts/shipping-cost.service';
import { syncGatewaySettlements } from '../modules/accounts/gateway-settlement.service';
import logger from '../utils/logger';
import { processPickupBatches } from '../modules/delhivery/pickup-batch.service';
import returnScanService from '../modules/returns/return-scan.service';

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
      })
    );

    this.jobs.push(cron.schedule('*/5 * * * *', async () => {
      try { await processPickupBatches(); }
      catch (error: any) { logger.error('[CRON] Pickup batching failed', { error: error.message }); }
    }, { timezone: 'Asia/Kolkata' }));

    // 3. Retry failed syncs/refunds
    this.jobs.push(
      cron.schedule(config.cron.retryFailed, async () => {
        logger.info('[CRON] Running retry failed operations...');
        try {
          await returnService.retryFailedRefunds();
        } catch (error: any) {
          logger.error('[CRON] Retry failed operations error', { error: error.message });
        }
        try {
          // A PROCESSED return whose trail write was lost is retried above
          // never (it is not FAILED); recreate its audit entry instead.
          const backfilled = await backfillMissingRefundTrailEvents();
          if (backfilled > 0) {
            logger.info('[CRON] Backfilled missing refund trail events', { backfilled });
          }
        } catch (error: any) {
          logger.error('[CRON] Refund trail backfill error', { error: error.message });
        }
        try {
          await orderService.retryFailedRtoRefunds();
        } catch (error: any) {
          logger.error('[CRON] Retry failed RTO refunds error', { error: error.message });
        }
        // Accounts: fill delivery dates, close orders that reached Payment
        // Received, and send last month's report if the 8th was missed.
        try {
          await runAccountsMaintenance();
        } catch (error: any) {
          logger.error('[CRON] Accounts closing failed', { error: error.message });
        }
        try {
          await sendDueMonthlyReport();
        } catch (error: any) {
          logger.error('[CRON] Monthly accounts report catch-up failed', { error: error.message });
        }
      })
    );

    // 5. Monthly accounts closing report: last month's orders, emailed on the 8th (IST).
    this.jobs.push(
      cron.schedule(
        config.accounts.reportCron,
        async () => {
          logger.info('[CRON] Sending monthly accounts report...');
          try {
            const month = await sendDueMonthlyReport();
            logger.info('[CRON] Monthly accounts report', { month: month || 'already sent or no recipients' });
          } catch (error: any) {
            logger.error('[CRON] Monthly accounts report failed', { error: error.message });
          }
        },
        { timezone: 'Asia/Kolkata' }
      )
    );

    // 6. Shipping-cost estimates from Delhivery's rate API, a few per run (rate limit).
    this.jobs.push(
      cron.schedule(config.cron.shippingCostEstimate, async () => {
        try {
          await estimatePendingShippingCosts();
        } catch (error: any) {
          logger.error('[CRON] Shipping cost estimates failed', { error: error.message });
        }
      })
    );

    // 7. Gateway settlement UTRs (PhonePe / Easebuzz), when their API keys are set.
    this.jobs.push(
      cron.schedule(
        config.cron.gatewaySettlementSync,
        async () => {
          try {
            await syncGatewaySettlements();
          } catch (error: any) {
            logger.error('[CRON] Gateway settlement sync failed', { error: error.message });
          }
        },
        { timezone: 'Asia/Kolkata' }
      )
    );

    // 8. Return scan sync (reads read-only RETURN_SCAN_DATABASE and updates Return Delivered / auto-refunds)
    this.jobs.push(
      cron.schedule(config.cron.returnScanSync || '*/30 * * * *', async () => {
        logger.info('[CRON] Running warehouse return scan sync...');
        try {
          const res = await returnScanService.syncReturnScans();
          logger.info('[CRON] Return scan sync completed', res);
        } catch (error: any) {
          logger.error('[CRON] Return scan sync failed', { error: error.message });
        }
      })
    );

    // 9. Daily manual COD refund digest to listings@vbexports.co.in (10:00 AM IST)
    this.jobs.push(
      cron.schedule(
        config.cron.codRefundDigest || '0 10 * * *',
        async () => {
          logger.info('[CRON] Running daily manual COD refund digest...');
          try {
            await returnScanService.sendDailyCodManualRefundDigest();
          } catch (error: any) {
            logger.error('[CRON] Daily COD refund digest failed', { error: error.message });
          }
        },
        { timezone: 'Asia/Kolkata' }
      )
    );

    logger.info('Scheduler started successfully', {
      orderSync: config.cron.orderSync,
      trackingSync: config.cron.trackingSync,
      retryFailed: config.cron.retryFailed,
      delhiveryDocFetch: config.cron.delhiveryDocFetch || '*/30 * * * *',
      accountsReport: `${config.accounts.reportCron} (IST)`,
      shippingCostEstimate: config.cron.shippingCostEstimate,
      gatewaySettlementSync: `${config.cron.gatewaySettlementSync} (IST)`,
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
