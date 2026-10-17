import { Pool } from 'pg';
import prisma from '../../database/prisma';
import { config } from '../../config';
import logger from '../../utils/logger';
import shopifyService from '../shopify/shopify.service';
import orderService from '../orders/order.service';
import resendService from '../email/resend.service';
import { recordAccountTrailEvent } from '../accounts/account-trail.service';
import { isPrepaidOrder } from '../orders/order-tabs';

export interface ReturnScanRow {
  id: number;
  expected_return_id: number | null;
  scanned_by: number | null;
  scanned_at: Date;
  outcome: string | null;
  issue_label: string | null;
  status: string | null;
  notes: string | null;
  tracking_id_snapshot: string | null;
  order_number_snapshot: string | null;
  marketplace_snapshot: string | null;
  scanned_tracking: string | null;
  forward_tracking_snapshot: string | null;
  return_type_raw_snapshot: string | null;
}

export interface SyncReturnScansResult {
  scansChecked: number;
  matchedOrders: number;
  prepaidRefunded: number;
  codQueued: number;
  alreadyProcessed: number;
  issuesSkipped: number;
  errors: string[];
}

export function isReturnScanClear(scan: { outcome?: string | null; issue_label?: string | null }): boolean {
  const outcome = (scan.outcome || '').trim().toLowerCase();
  const issue = (scan.issue_label || '').trim().toLowerCase();

  // If outcome is marked clear
  if (outcome === 'clear') {
    return true;
  }

  // If issue is "no issue" or empty
  if (issue === 'no issue' || issue === '' || issue === 'clear') {
    return true;
  }

  // User specification: "if flage iron issue not the big deal"
  // Ironing requirement is an operational flag, not a blocker issue
  if (issue.includes('iron')) {
    return true;
  }

  // Any other issue (wrong product, damaged, missing component, sku change) is an issue
  return false;
}

class ReturnScanService {
  private pool: Pool | null = null;

  constructor() {
    this.initPool();
  }

  /**
   * Initializes a read-only PostgreSQL connection pool to RETURN_SCAN_DATABASE.
   * Strictly enforces read-only mode so no data or structure can ever be edited.
   */
  private initPool(): Pool | null {
    if (!config.returnScanDatabase) {
      return null;
    }

    try {
      // Strip query parameters so pg doesn't override our SSL config
      const cleanUrl = config.returnScanDatabase.split('?')[0];
      this.pool = new Pool({
        connectionString: cleanUrl,
        ssl: { rejectUnauthorized: false },
        max: 3,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });

      // Enforce read-only transaction mode on every connection
      this.pool.on('connect', (client) => {
        client.query('SET default_transaction_read_only = true;').catch((err) => {
          logger.warn('Failed to set read-only session on return scan DB connection', { error: err.message });
        });
      });

      this.pool.on('error', (err) => {
        logger.error('Unexpected error on idle return scan DB client', { error: err.message });
      });

      return this.pool;
    } catch (err: any) {
      logger.error('Failed to initialize return scan DB connection pool', { error: err.message });
      return null;
    }
  }

  /**
   * Diagnostic probe to test connectivity to RETURN_SCAN_DATABASE.
   */
  async ping(): Promise<{
    configured: boolean;
    connected: boolean;
    latencyMs: number;
    totalScans?: number;
    error?: string;
  }> {
    if (!config.returnScanDatabase) {
      return { configured: false, connected: false, latencyMs: 0 };
    }

    const pool = this.pool || this.initPool();
    if (!pool) {
      return { configured: true, connected: false, latencyMs: 0, error: 'Connection pool not initialized' };
    }

    const start = Date.now();
    try {
      const res = await pool.query('SELECT COUNT(*) as cnt FROM receipt_scans');
      const latencyMs = Date.now() - start;
      return {
        configured: true,
        connected: true,
        latencyMs,
        totalScans: parseInt(res.rows[0]?.cnt || '0', 10),
      };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      return {
        configured: true,
        connected: false,
        latencyMs,
        error: err.message,
      };
    }
  }

  /**
   * Syncs return scans from RETURN_SCAN_DATABASE into the OMS.
   *
   * Logic:
   * 1. Reads receipt_scans from RETURN_SCAN_DATABASE (READ ONLY).
   * 2. Evaluates if scan is received without issue (clear or iron issue).
   * 3. For matching OMS orders:
   *    - Marks order as Return Delivered (RTO_DELIVERED / RETURN_RECEIVED).
   *    - Adds "Return Delivered" tag on Shopify.
   *    - If Prepaid: initiates automatic refund via Shopify.
   *    - If COD: marks return delivered, flags for manual refund, and queues for daily digest email.
   */
  async syncReturnScans(lookbackDays = 30): Promise<SyncReturnScansResult> {
    const result: SyncReturnScansResult = {
      scansChecked: 0,
      matchedOrders: 0,
      prepaidRefunded: 0,
      codQueued: 0,
      alreadyProcessed: 0,
      issuesSkipped: 0,
      errors: [],
    };

    if (!config.returnScanDatabase) {
      logger.debug('RETURN_SCAN_DATABASE is not configured, skipping return scan sync');
      return result;
    }

    const pool = this.pool || this.initPool();
    if (!pool) {
      result.errors.push('Could not establish connection to RETURN_SCAN_DATABASE');
      return result;
    }

    try {
      // Query recent scans for Shopify / YOU orders or scans with tracking
      const cutoff = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);
      const query = `
        SELECT 
          id, expected_return_id, scanned_by, scanned_at, outcome, issue_label, status, notes,
          tracking_id_snapshot, order_number_snapshot, marketplace_snapshot, scanned_tracking,
          forward_tracking_snapshot, return_type_raw_snapshot
        FROM receipt_scans
        WHERE (
          marketplace_snapshot ILIKE '%Shopify%' 
          OR order_number_snapshot ILIKE '%YOU%' 
          OR order_number_snapshot ILIKE '#%'
          OR scanned_tracking IS NOT NULL
        )
        AND scanned_at >= $1
        ORDER BY id ASC
      `;

      const scansRes = await pool.query(query, [cutoff]);
      const scans: ReturnScanRow[] = scansRes.rows;
      result.scansChecked = scans.length;

      logger.info('Fetched return scans from RETURN_SCAN_DATABASE', {
        count: scans.length,
        since: cutoff.toISOString(),
      });

      for (const scan of scans) {
        try {
          // Check if scan is clear (no issue or iron issue)
          if (!isReturnScanClear(scan)) {
            result.issuesSkipped++;
            continue;
          }

          // Resolve order by tracking or order number
          const tracking = (scan.scanned_tracking || scan.tracking_id_snapshot || scan.forward_tracking_snapshot || '').trim();
          const orderNumberRaw = (scan.order_number_snapshot || '').trim();
          const orderNumberClean = orderNumberRaw.replace(/^#/, '');

          const order = await prisma.order.findFirst({
            where: {
              OR: [
                ...(orderNumberRaw ? [
                  { shopifyOrderName: orderNumberRaw },
                  { shopifyOrderName: `#${orderNumberClean}` },
                  { shopifyOrderName: orderNumberClean },
                ] : []),
                ...(tracking ? [
                  { shipment: { waybillNumber: tracking } },
                  { returns: { some: { returnWaybillNumber: tracking } } },
                ] : []),
              ],
            },
            include: { shipment: true, returns: true },
          });

          if (!order) {
            continue;
          }

          result.matchedOrders++;

          // Check if already marked delivered & refunded
          const isAlreadyDelivered = order.status === 'RTO_DELIVERED' || order.status === 'RETURN_RECEIVED' || order.status === 'REFUNDED';
          const isPrepaid = isPrepaidOrder(order);

          // 1. Mark order Return Delivered if not already marked
          if (!isAlreadyDelivered) {
            const newStatus = order.returns?.length ? 'RETURN_RECEIVED' : 'RTO_DELIVERED';
            await prisma.order.update({
              where: { id: order.id },
              data: { status: newStatus },
            });

            // Update shipment if forward AWB
            if (order.shipment) {
              await prisma.shipment.update({
                where: { id: order.shipment.id },
                data: {
                  status: 'RTO_DELIVERED',
                  trackingStatus: 'Return Delivered (Scanned at Warehouse)',
                  trackingUpdatedAt: scan.scanned_at || new Date(),
                },
              });
            }

            // Update associated return record if customer return
            if (order.returns?.length) {
              for (const ret of order.returns) {
                if (ret.returnStatus !== 'RECEIVED' && ret.returnStatus !== 'REFUNDED') {
                  await prisma.return.update({
                    where: { id: ret.id },
                    data: {
                      returnStatus: 'RECEIVED',
                      qcStatus: 'APPROVED',
                      qcRemark: scan.issue_label || 'Verified without issue (Warehouse scan)',
                      receivedAt: scan.scanned_at || new Date(),
                    },
                  });
                }
              }
            }

            // Tag on Shopify
            try {
              const existingTags = (order.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
              const tagSet = new Set(existingTags);
              tagSet.add('Return Delivered');
              tagSet.add('RTO_DELIVERED');
              if (scan.issue_label && scan.issue_label.toLowerCase().includes('iron')) {
                tagSet.add('Iron Required');
              }
              await shopifyService.updateOrderTags(order.shopifyOrderId, Array.from(tagSet));
            } catch (tagErr: any) {
              logger.warn('Failed to update Return Delivered tags on Shopify', {
                orderId: order.id,
                error: tagErr.message,
              });
            }

            // Record audit trail event
            await recordAccountTrailEvent({
              orderId: order.id,
              eventType: 'RETURN_DELIVERED',
              actorType: 'SYSTEM',
              actor: { name: 'Warehouse Return Scan', role: 'SYSTEM' },
              source: 'RETURN_SCAN_DATABASE',
              status: 'COMPLETED',
              externalReference: tracking || `SCAN_${scan.id}`,
              note: `Return package verified received at warehouse without blocker issue (Scan #${scan.id}, Issue: ${scan.issue_label || 'No issue'}). Marked Return Delivered.`,
              metadata: {
                scanId: scan.id,
                scannedAt: scan.scanned_at,
                issueLabel: scan.issue_label,
                tracking,
              },
            }).catch((err) => logger.warn('Failed to record return delivery trail', { error: err.message }));
          }

          // 2. Prepaid Refund Automation
          if (isPrepaid) {
            if (order.financialStatus === 'refunded' || order.status === 'REFUNDED') {
              result.alreadyProcessed++;
              continue;
            }

            try {
              const refundRes = await orderService.processRtoRefund(order.id);
              if (refundRes.success) {
                result.prepaidRefunded++;
                logger.info('Initiated automatic refund for prepaid return delivered order', {
                  orderId: order.id,
                  orderName: order.shopifyOrderName,
                  refundId: refundRes.refundId,
                });
              }
            } catch (refErr: any) {
              logger.error('Failed to process automatic refund for prepaid return order', {
                orderId: order.id,
                orderName: order.shopifyOrderName,
                error: refErr.message,
              });
              result.errors.push(`Refund failed for ${order.shopifyOrderName}: ${refErr.message}`);
            }
          } else {
            // 3. COD Manual Refund Queue
            result.codQueued++;
            // Tag order as requiring manual refund
            try {
              const existingTags = (order.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
              if (!existingTags.includes('COD_MANUAL_REFUND_DUE')) {
                existingTags.push('COD_MANUAL_REFUND_DUE');
                await shopifyService.updateOrderTags(order.shopifyOrderId, existingTags);
                await prisma.order.update({
                  where: { id: order.id },
                  data: { tags: existingTags.join(', ') },
                });
              }
            } catch (tErr: any) {
              logger.warn('Failed to add COD_MANUAL_REFUND_DUE tag', { error: tErr.message });
            }
          }
        } catch (itemErr: any) {
          logger.error('Error processing individual return scan', { scanId: scan.id, error: itemErr.message });
          result.errors.push(`Scan #${scan.id}: ${itemErr.message}`);
        }
      }

      logger.info('Return scan sync completed', result);
      return result;
    } catch (err: any) {
      logger.error('Failed to execute return scan sync', { error: err.message });
      result.errors.push(err.message);
      return result;
    }
  }

  /**
   * Sends the daily digest email to listings@vbexports.co.in listing all COD orders
   * that were returned and delivered to warehouse without issue and require manual refund.
   */
  async sendDailyCodManualRefundDigest(): Promise<{
    sent: boolean;
    ordersCount: number;
    recipient: string;
    message: string;
  }> {
    const recipient = config.codRefundEmail || 'listings@vbexports.co.in';

    // Find all COD orders marked return delivered where refund has not yet been processed
    const codOrders = await prisma.order.findMany({
      where: {
        paymentMethod: 'COD',
        status: { in: ['RTO_DELIVERED', 'RETURN_RECEIVED'] },
        financialStatus: { not: 'refunded' },
        shopifyCreatedAt: { gte: config.shopify.syncStartDate },
      },
      include: {
        shipment: true,
        returns: true,
      },
      orderBy: { shopifyCreatedAt: 'desc' },
      take: 100,
    });

    if (!codOrders.length) {
      logger.info('No pending COD returns requiring manual refund digest today');
      return {
        sent: false,
        ordersCount: 0,
        recipient,
        message: 'No pending COD returns requiring manual refund found today.',
      };
    }

    const todayDate = new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeZone: 'Asia/Kolkata',
    }).format(new Date());

    // Build modern HTML email
    const rowsHtml = codOrders.map((order, idx) => {
      const awb = order.returns?.[0]?.returnWaybillNumber || order.shipment?.waybillNumber || 'N/A';
      const orderUrl = `${config.appBaseUrl}/orders/${order.id}`;
      const epodUrl = order.shipment?.epodStoragePath
        ? `https://storage.googleapis.com/${config.firebase.storageBucket}/${order.shipment.epodStoragePath.replace(/^gs:\/\/[^/]+\//, '')}`
        : `${config.appBaseUrl}/api/orders/${order.id}/epod`;
      const amount = (order.totalAmount || 0).toLocaleString('en-IN', { style: 'currency', currency: 'INR' });
      const utr = order.paymentReceivedUtr ? `UTR: <code>${order.paymentReceivedUtr}</code>` : '<span style="color:#d97706;">Remittance Pending</span>';

      return `
        <tr style="border-bottom: 1px solid #e2e8f0; ${idx % 2 === 1 ? 'background-color: #f8fafc;' : ''}">
          <td style="padding: 12px 10px; font-weight: 600;">
            <a href="${orderUrl}" style="color: #0284c7; text-decoration: none;">${order.shopifyOrderName}</a>
          </td>
          <td style="padding: 12px 10px;">
            <div style="font-weight: 600; color: #1e293b;">${order.customerName}</div>
            <div style="font-size: 11px; color: #64748b;">${order.customerPhone}</div>
          </td>
          <td style="padding: 12px 10px; font-family: monospace; font-size: 12px;">
            ${awb}
          </td>
          <td style="padding: 12px 10px; font-weight: 700; color: #0f172a;">
            ${amount}
          </td>
          <td style="padding: 12px 10px; font-size: 12px;">
            ${utr}
          </td>
          <td style="padding: 12px 10px; font-size: 12px;">
            <a href="${epodUrl}" target="_blank" style="display: inline-block; padding: 4px 8px; background: #e0f2fe; color: #0369a1; border-radius: 4px; text-decoration: none; font-size: 11px; font-weight: 600;">View Proof / EPOD</a>
          </td>
        </tr>
      `;
    }).join('');

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #0f172a; margin: 0; padding: 24px; background: #f1f5f9; }
          .container { max-width: 900px; margin: 0 auto; background: #ffffff; border-radius: 10px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
          .header { background: #0f172a; color: #ffffff; padding: 24px; }
          .header h1 { margin: 0 0 6px; font-size: 20px; font-weight: 700; }
          .header p { margin: 0; font-size: 13px; color: #94a3b8; }
          .body { padding: 24px; }
          .alert { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 4px; font-size: 13px; color: #92400e; margin-bottom: 20px; }
          table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
          th { background: #f8fafc; padding: 10px; text-align: left; font-size: 11px; font-weight: 700; color: #475569; text-transform: uppercase; border-bottom: 2px solid #e2e8f0; }
          .footer { padding: 18px 24px; background: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Youthnic Fulfillment Center · Surat</h1>
            <p>Daily Action Required: Manual COD Customer Refund Queue — ${todayDate}</p>
          </div>
          <div class="body">
            <div class="alert">
              <strong>Notice for Listings & Finance Team:</strong> The following <strong>${codOrders.length} COD order(s)</strong> have been returned and verified received at the warehouse with <strong>NO ISSUE</strong>. Because payment was collected in cash upon delivery, an automated gateway reversal cannot be done. Please review customer details and payment proofs below to initiate the manual bank/UPI refund.
            </div>

            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Return Tracking AWB</th>
                  <th>Amount</th>
                  <th>Courier Settlement / UTR</th>
                  <th>Payment Screenshot / POD</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>
          <div class="footer">
            Youthnic Order Management System · Generated automatically from Return Scan Database sync.
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const emailRes = await resendService.sendEmail({
        to: recipient,
        templateType: 'CUSTOM',
        subject: `[Action Required] Daily COD Manual Refund Queue — ${codOrders.length} Orders Delivered (${todayDate})`,
        data: {
          orderName: `COD Queue (${codOrders.length} orders)`,
          customerName: 'Listings & Accounts Team',
          customHtml: html,
        },
      });

      // Audit trail record for each order
      for (const order of codOrders) {
        await recordAccountTrailEvent({
          orderId: order.id,
          eventType: 'COD_MANUAL_REFUND_NOTIFIED',
          actorType: 'SYSTEM',
          actor: { name: 'OMS Notification Engine', role: 'SYSTEM' },
          source: 'DAILY_COD_REFUND_DIGEST',
          status: 'COMPLETED',
          note: `Included in daily manual COD refund digest emailed to ${recipient}.`,
          metadata: { recipient, emailLogId: emailRes?.logId },
        }).catch(() => {});
      }

      logger.info('Daily COD manual refund digest emailed successfully', {
        recipient,
        ordersCount: codOrders.length,
      });

      return {
        sent: true,
        ordersCount: codOrders.length,
        recipient,
        message: `Digest email sent successfully to ${recipient} with ${codOrders.length} orders.`,
      };
    } catch (err: any) {
      logger.error('Failed to send daily COD manual refund digest email', {
        error: err.message,
        recipient,
      });
      return {
        sent: false,
        ordersCount: codOrders.length,
        recipient,
        message: `Failed to send email: ${err.message}`,
      };
    }
  }
}

export const returnScanService = new ReturnScanService();
export default returnScanService;
