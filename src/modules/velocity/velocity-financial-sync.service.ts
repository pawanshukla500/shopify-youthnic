import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { config } from '../../config';
import velocityService, { VelocityService, VelocityShippingChargeEntry, VelocityCodRemittanceEntry } from './velocity.service';
import { findOrderByReference, recordPaymentReceived } from '../accounts/reconciliation.service';
import { type AccountTrailActor } from '../accounts/account-trail.service';
import { isVelocityCourier } from '../../utils/courier';

export interface VelocityFinancialSyncOptions {
  lookbackDays?: number;
  actor?: AccountTrailActor;
  awbs?: string[];
  forceAll?: boolean;
  startDate?: string;
  endDate?: string;
}

export interface MatchedVelocityOrderFinancials {
  orderId: number;
  shopifyOrderName: string;
  waybillNumber: string;
  codAmount?: number;
  remittedAmount?: number;
  utr?: string | null;
  remittanceDate?: string | null;
  remittanceRef?: string | null;
  netBilledCost?: number;
  totalDebited?: number;
  totalCredited?: number;
  billingStatus?: string;
  chargesCount?: number;
  status?: string;
  city?: string;
}

export interface VelocityFinancialSyncResult {
  success: boolean;
  awbsChecked: number;
  matchedCount: number;
  remittancesMatched: number;
  chargesAudited: number;
  totalRemittanceAmount: number;
  totalBilledCharges: number;
  unmatchedAwbs: string[];
  matchedOrders: MatchedVelocityOrderFinancials[];
  summaryReport?: any;
  importId?: number;
  notes: string[];
  durationMs: number;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseValidDate(value?: string | Date | null): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Shared by the bulk and single-order syncs so the order card's ledger rows match either way
function toWalletTransactions(awb: string, charges: any[]) {
  return charges.map((c: any, idx: number) => ({
    txnId: `VEL-CHG-${awb}-${idx + 1}`,
    date: new Date().toISOString(),
    type: (c.amountWithGst >= 0 ? 'debit' : 'credit') as 'debit' | 'credit',
    amount: Math.abs(c.amountWithGst),
    amountWithoutGst: c.amountWithoutGst,
    eventType: c.eventType,
    transactionType: c.transactionType,
    description: `Velocity ${c.transactionType || c.eventType}`,
    source: 'VELOCITY_API',
  }));
}

export class VelocityFinancialSyncService {
  constructor(private vService: VelocityService = velocityService) {}

  /**
   * Apply a single Velocity /cod-remittance entry onto Shipment & Order.
   * Velocity returns `cod_amount` and a scheduled `remittance_date` even for
   * IN_TRANSIT / FAILED / RTO / CANCELLED AWBs, so `codRemitted` and payment receipt
   * are strictly gated on a real bank `utr_no`, and `codCollected` on valid `delivery_date`.
   */
  private async applyCodRemittanceEntry(
    order: any,
    item: VelocityCodRemittanceEntry,
    actor: AccountTrailActor
  ): Promise<{
    collected: boolean;
    remitted: boolean;
    utr: string | null;
    remittedVal: number;
    remittanceDate: string | null;
  }> {
    const utr = item.utrNo?.trim() || null;
    const deliveryDate = parseValidDate(item.deliveryDate);
    const remittanceDate = parseValidDate(item.remittanceDate);

    const statusUpper = String(order.status || '').toUpperCase();
    const shipStatusUpper = String(order.shipment?.currentStatus || '').toUpperCase();
    const isRtoOrCancelled =
      Boolean(order.isCancelled || order.isRto) ||
      statusUpper === 'CANCELLED' ||
      statusUpper === 'RTO' ||
      shipStatusUpper.includes('RTO') ||
      shipStatusUpper.includes('CANCEL');

    const isDelivered = Boolean(deliveryDate && !isRtoOrCancelled);
    const isRemitted = Boolean(utr);

    if (!isDelivered && !isRemitted) {
      return { collected: false, remitted: false, utr: null, remittedVal: 0, remittanceDate: null };
    }

    const remittedVal = item.codAmount ?? order.shipment?.codAmount ?? order.totalAmount;
    const collectedAt = deliveryDate || order.shipment?.codCollectedAt || null;
    const remittedAtDate = isRemitted ? remittanceDate || deliveryDate || new Date() : null;

    if (order.shipment) {
      const shipmentData: Record<string, any> = {
        codCollected: true,
        ...(collectedAt ? { codCollectedAt: collectedAt } : {}),
      };
      if (isRemitted) {
        shipmentData.codRemitted = true;
        shipmentData.codRemittedAt = remittedAtDate;
        shipmentData.codRemittanceRef = utr;
        shipmentData.codRemittedAmount = remittedVal;
      }
      await prisma.shipment.update({
        where: { id: order.shipment.id },
        data: shipmentData,
      });
    }

    if (isDelivered && deliveryDate && !order.deliveredAt) {
      await prisma.order.update({
        where: { id: order.id },
        data: { deliveredAt: deliveryDate },
      });
    }

    if (isRemitted && utr) {
      await recordPaymentReceived(order.id, {
        amount: remittedVal,
        utr,
        ref: utr,
        source: 'VELOCITY_REMITTANCE',
        receivedAt: remittedAtDate!,
        deliveredAt: deliveryDate,
        actor,
      });
    }

    return {
      collected: isDelivered || isRemitted,
      remitted: isRemitted,
      utr,
      remittedVal,
      remittanceDate: remittanceDate
        ? remittanceDate.toISOString().slice(0, 10)
        : item.remittanceDate || null,
    };
  }

  /**
   * Main synchronization routine:
   * 1. Identifies candidate Velocity AWBs (from DB + Velocity Shipments API).
   * 2. Fetches shipment-level COD remittances and bank UTRs via POST /custom/api/v1/cod-remittance.
   * 3. Fetches itemized ledger shipping charges via POST /custom/api/v1/shipping-charges.
   * 4. Updates Shipment and Order records, writes bank receipt & account audit trail.
   * 5. Captures Velocity operational summary reports and logs a ReconciliationImport record.
   */
  async syncVelocityFinancials(
    options: VelocityFinancialSyncOptions = {}
  ): Promise<VelocityFinancialSyncResult> {
    const startTs = Date.now();
    const lookbackDays = options.lookbackDays ?? 45;
    const sinceDate = new Date(Date.now() - lookbackDays * 86400000);
    const notes: string[] = [];
    const unmatchedAwbs: string[] = [];
    const matchedMap = new Map<number, MatchedVelocityOrderFinancials>();

    let remittancesMatched = 0;
    let chargesAudited = 0;
    let totalRemittanceAmount = 0;
    let totalBilledCharges = 0;

    if (!config.velocity.apiToken) {
      return {
        success: false,
        awbsChecked: 0,
        matchedCount: 0,
        remittancesMatched: 0,
        chargesAudited: 0,
        totalRemittanceAmount: 0,
        totalBilledCharges: 0,
        unmatchedAwbs: [],
        matchedOrders: [],
        notes: ['Velocity API token is not configured (VELOCITY_API_TOKEN).'],
        durationMs: Date.now() - startTs,
      };
    }

    logger.info('Starting automated Velocity financial and remittance sync...', {
      lookbackDays,
      explicitAwbs: options.awbs?.length || 0,
    });

    // ── 1. Discover Candidate AWBs ───────────────────────────
    const candidateAwbSet = new Set<string>();
    const codCandidateAwbSet = new Set<string>();

    if (options.awbs && options.awbs.length > 0) {
      options.awbs.forEach((awb) => {
        const cleaned = String(awb || '').trim();
        if (cleaned) {
          candidateAwbSet.add(cleaned);
          codCandidateAwbSet.add(cleaned);
        }
      });
    } else {
      // 1a. Query local database for Velocity shipments needing COD remittance or freight audit
      try {
        const dbShipments = await prisma.shipment.findMany({
          where: {
            waybillNumber: { not: null },
            ...(options.forceAll ? {} : { updatedAt: { gte: sinceDate } }),
            OR: [
              { courier: { contains: 'velocity', mode: 'insensitive' } },
              { courier: { contains: 'Velocity' } },
              { courier: null },
            ],
          },
          include: {
            order: {
              select: {
                id: true,
                shopifyOrderName: true,
                paymentMethod: true,
                paymentGateway: true,
                totalAmount: true,
                status: true,
                paymentReceivedUtr: true,
              },
            },
          },
          take: 1000,
        });

        for (const s of dbShipments) {
          const wb = s.waybillNumber?.trim();
          if (!wb) continue;
          const isVel = isVelocityCourier(s.courier, s.labelUrl, wb);
          const needsRemitAudit = !s.codRemitted || !s.order?.paymentReceivedUtr;
          const needsChargeAudit = s.billingStatus !== 'AUDITED' || !s.netBilledCost;
          if (isVel || needsRemitAudit || needsChargeAudit) {
            candidateAwbSet.add(wb);
            const isPrepaid =
              s.paymentMode === 'Prepaid' ||
              s.paymentMode === 'Pre-paid' ||
              s.order?.paymentMethod === 'PREPAID';
            if (!isPrepaid && (isVel || needsRemitAudit)) {
              codCandidateAwbSet.add(wb);
            }
          }
        }
      } catch (err: any) {
        logger.warn('Failed querying DB shipments for Velocity candidates', { error: err.message });
      }

      // 1b. Query Velocity live shipments API (up to 5 pages) to discover recently manifested orders
      try {
        for (let page = 1; page <= 5; page++) {
          const liveList = await this.vService.getShipmentsList({
            page,
            per_page: 100,
          });

          const list = liveList?.data || [];
          for (const item of list) {
            const attrs = item.attributes;
            const trackingNumber = attrs?.tracking_number?.trim();
            const displayId = attrs?.order?.display_id?.trim();
            const externalId = attrs?.order?.external_id?.trim();

            if (trackingNumber) {
              candidateAwbSet.add(trackingNumber);
              if (attrs?.is_cod !== false) {
                codCandidateAwbSet.add(trackingNumber);
              }

              // If local shipment is missing waybillNumber, link it automatically
              if (displayId || externalId) {
                try {
                  const existingOrder = await findOrderByReference(displayId || externalId);
                  if (existingOrder && !existingOrder.shipment?.waybillNumber) {
                    await prisma.shipment.upsert({
                      where: { orderId: existingOrder.id },
                      create: {
                        orderId: existingOrder.id,
                        waybillNumber: trackingNumber,
                        courier: 'Velocity',
                        paymentMode: attrs?.is_cod ? 'COD' : 'Pre-paid',
                        codAmount: attrs?.cod_amount ? Number(attrs.cod_amount) : 0,
                      },
                      update: {
                        waybillNumber: trackingNumber,
                        courier: 'Velocity',
                        paymentMode: attrs?.is_cod ? 'COD' : 'Pre-paid',
                        codAmount: attrs?.cod_amount ? Number(attrs.cod_amount) : undefined,
                      },
                    });
                  }
                } catch {
                  // non-fatal link attempt
                }
              }
            }
          }

          if (list.length < 100) break;
        }
      } catch (err: any) {
        logger.warn('Velocity live shipments listing failed during discovery', { error: err.message });
      }
    }

    const candidateAwbs = Array.from(candidateAwbSet);
    const codCandidateAwbs = Array.from(codCandidateAwbSet);
    logger.info(`Discovered ${candidateAwbs.length} candidate Velocity AWBs (${codCandidateAwbs.length} COD) for financial sync`);

    if (candidateAwbs.length === 0) {
      return {
        success: true,
        awbsChecked: 0,
        matchedCount: 0,
        remittancesMatched: 0,
        chargesAudited: 0,
        totalRemittanceAmount: 0,
        totalBilledCharges: 0,
        unmatchedAwbs: [],
        matchedOrders: [],
        notes: ['No candidate Velocity AWBs found needing financial sync.'],
        durationMs: Date.now() - startTs,
      };
    }

    // ── 2. Batch Sync COD Remittances & Bank UTRs ─────────────
    const batchSize = 100;
    const actor = options.actor || { name: 'Velocity Financial Auto-Sync' };
    for (let i = 0; i < codCandidateAwbs.length; i += batchSize) {
      const batch = codCandidateAwbs.slice(i, i + batchSize);
      try {
        const remittanceResults = await this.vService.getCodRemittance(batch);

        for (const item of remittanceResults) {
          const awb = item.trackingNumber?.trim();
          if (!awb) continue;

          if (item.error) {
            if (!/prepaid order/i.test(item.error)) {
              unmatchedAwbs.push(`${awb}: ${item.error}`);
            }
            continue;
          }

          const hasUtr = Boolean(item.utrNo && item.utrNo.trim());
          const hasDeliveryDate = Boolean(parseValidDate(item.deliveryDate));
          if (!hasUtr && !hasDeliveryDate) {
            // In-transit / RTO / undelivered without bank UTR — do not mark collected or remitted
            continue;
          }

          const order = await findOrderByReference(awb);
          if (!order) {
            unmatchedAwbs.push(`${awb} (no matching OMS order found)`);
            continue;
          }

          try {
            const applied = await this.applyCodRemittanceEntry(order, item, actor);
            if (!applied.remitted) {
              continue;
            }

            remittancesMatched++;
            totalRemittanceAmount += applied.remittedVal;

            const existing: MatchedVelocityOrderFinancials = matchedMap.get(order.id) || {
              orderId: order.id,
              shopifyOrderName: order.shopifyOrderName,
              waybillNumber: awb,
              city: order.customerCity || undefined,
              status: order.status,
            };

            existing.codAmount = item.codAmount;
            existing.remittedAmount = applied.remittedVal;
            existing.utr = applied.utr;
            existing.remittanceDate = applied.remittanceDate;
            existing.remittanceRef = applied.utr;

            matchedMap.set(order.id, existing);
          } catch (recErr: any) {
            notes.push(`Order ${order.shopifyOrderName} (${awb}): ${recErr.message}`);
          }
        }
      } catch (batchErr: any) {
        logger.error('Failed processing Velocity COD remittance batch', {
          batchSize: batch.length,
          error: batchErr.message,
        });
        notes.push(`COD remittance batch error: ${batchErr.message}`);
      }

      if (i + batchSize < codCandidateAwbs.length) {
        await sleep(500);
      }
    }

    // ── 3. Batch Sync Shipping Charges (Ledger & Net Cost) ───
    for (let i = 0; i < candidateAwbs.length; i += batchSize) {
      const batch = candidateAwbs.slice(i, i + batchSize);
      try {
        const chargesResults = await this.vService.getShippingCharges(batch);

        for (const item of chargesResults) {
          const awb = item.trackingNumber?.trim();
          if (!awb) continue;

          if (item.error) {
            continue;
          }

          const charges = item.charges || [];
          if (charges.length === 0) continue;

          const order = await findOrderByReference(awb);
          if (!order || !order.shipment) continue;

          let debits = 0;
          let credits = 0;
          let forwardFreight = 0;
          let rtoFreight = 0;

          for (const c of charges) {
            const amountWithGst = Number(c.amountWithGst || 0);
            const event = String(c.eventType || '').toLowerCase();
            const txn = String(c.transactionType || '').toLowerCase();

            if (txn.includes('rto') || event.includes('rto')) {
              rtoFreight += Math.abs(amountWithGst);
            } else if (txn.includes('forward') || txn.includes('freight') || event.includes('debit')) {
              forwardFreight += Math.abs(amountWithGst);
            }

            if (amountWithGst >= 0) {
              debits += amountWithGst;
            } else {
              credits += Math.abs(amountWithGst);
            }
          }

          const netCost = Math.round((debits - credits) * 100) / 100;

          const walletTransactions = toWalletTransactions(awb, charges);

          await prisma.shipment.update({
            where: { id: order.shipment.id },
            data: {
              totalDebited: Math.round(debits * 100) / 100,
              totalCredited: Math.round(credits * 100) / 100,
              netBilledCost: netCost,
              forwardCharge: Math.round((forwardFreight || netCost) * 100) / 100,
              rtoCharge: Math.round(rtoFreight * 100) / 100,
              shippingCostSource: 'ACTUAL',
              shippingCostUpdatedAt: new Date(),
              walletTransactions,
              billingStatus: 'AUDITED',
              lastBilledAt: new Date(),
            },
          });

          chargesAudited++;
          totalBilledCharges += netCost;

          const existing: MatchedVelocityOrderFinancials = matchedMap.get(order.id) || {
            orderId: order.id,
            shopifyOrderName: order.shopifyOrderName,
            waybillNumber: awb,
            city: order.customerCity || undefined,
            status: order.status,
          };

          existing.netBilledCost = netCost;
          existing.totalDebited = debits;
          existing.totalCredited = credits;
          existing.billingStatus = 'AUDITED';
          existing.chargesCount = charges.length;

          matchedMap.set(order.id, existing);
        }
      } catch (batchErr: any) {
        logger.error('Failed processing Velocity shipping charges batch', {
          batchSize: batch.length,
          error: batchErr.message,
        });
        notes.push(`Shipping charges batch error: ${batchErr.message}`);
      }

      if (i + batchSize < candidateAwbs.length) {
        await sleep(500);
      }
    }

    // ── 4. Fetch Summary Report for Metrics ───────────────────
    let forwardSummary: any = null;
    try {
      const now = new Date();
      const past30 = new Date(Date.now() - 30 * 86400000);
      forwardSummary = await this.vService.getSummaryReport({
        startDateTime: past30.toISOString(),
        endDateTime: now.toISOString(),
        shipmentType: 'forward',
      });
    } catch (sumErr: any) {
      logger.warn('Could not fetch Velocity summary report during financial sync', {
        error: sumErr.message,
      });
    }

    // ── 5. Record ReconciliationImport Entries (Upsert per UTR batch) ─
    const matchedOrders = Array.from(matchedMap.values());
    const utrGroups = new Map<string, MatchedVelocityOrderFinancials[]>();
    for (const m of matchedOrders) {
      const utrKey = m.utr?.trim();
      if (!utrKey) continue;
      const list = utrGroups.get(utrKey) || [];
      list.push(m);
      utrGroups.set(utrKey, list);
    }

    let importId: number | undefined;
    try {
      for (const [utr, batchOrders] of utrGroups.entries()) {
        const fileName = `Velocity-UTR-${utr}`;
        const existing = await prisma.reconciliationImport.findFirst({
          where: { kind: 'VELOCITY_REMITTANCE', fileName },
          orderBy: { id: 'desc' },
        });

        const prevOrders: MatchedVelocityOrderFinancials[] = Array.isArray((existing?.summary as any)?.matchedOrders)
          ? (existing!.summary as any).matchedOrders
          : [];
        const byWaybill = new Map<string, MatchedVelocityOrderFinancials>();
        for (const p of prevOrders) {
          if (p?.waybillNumber) byWaybill.set(String(p.waybillNumber).trim(), p);
        }
        for (const o of batchOrders) {
          byWaybill.set(o.waybillNumber.trim(), o);
        }
        const mergedOrders = Array.from(byWaybill.values());
        const batchRemitTotal = mergedOrders.reduce(
          (sum, o) => sum + Number(o.remittedAmount ?? o.codAmount ?? 0),
          0
        );
        const batchChargesTotal = mergedOrders.reduce(
          (sum, o) => sum + Number(o.netBilledCost || 0),
          0
        );
        const batchDate =
          mergedOrders.find((o) => o.remittanceDate)?.remittanceDate ||
          new Date().toISOString().slice(0, 10);

        const importData = {
          rowCount: mergedOrders.length,
          matchedCount: mergedOrders.length,
          unmatched: [],
          summary: {
            remittanceNumber: utr,
            remittanceDate: batchDate,
            bankTransactionId: utr,
            utr,
            singleSettlement: true,
            state: 'SETTLED',
            totalRemittance: Math.round(batchRemitTotal * 100) / 100,
            totalBilledCharges: Math.round(batchChargesTotal * 100) / 100,
            remittancesMatched: mergedOrders.length,
            matchedOrders: mergedOrders.slice(0, 500),
            summaryReport: forwardSummary?.summary || null,
            syncedAt: new Date().toISOString(),
            notes,
          } as any,
          uploadedBy: actor.name || 'Velocity Financial Auto-Sync',
        };

        if (existing) {
          const imp = await prisma.reconciliationImport.update({
            where: { id: existing.id },
            data: { ...importData, createdAt: new Date() },
          });
          importId = imp.id;
        } else {
          const imp = await prisma.reconciliationImport.create({
            data: {
              kind: 'VELOCITY_REMITTANCE',
              fileName,
              ...importData,
            },
          });
          importId = imp.id;
        }
      }
    } catch (saveErr: any) {
      logger.warn('Could not persist Velocity reconciliation import record', {
        error: saveErr.message,
      });
    }

    const durationMs = Date.now() - startTs;
    logger.info('Completed Velocity financial and remittance sync', {
      awbsChecked: candidateAwbs.length,
      matchedOrders: matchedOrders.length,
      remittancesMatched,
      chargesAudited,
      totalRemittanceAmount,
      totalBilledCharges,
      durationMs,
    });

    return {
      success: true,
      awbsChecked: candidateAwbs.length,
      matchedCount: matchedOrders.length,
      remittancesMatched,
      chargesAudited,
      totalRemittanceAmount: Math.round(totalRemittanceAmount * 100) / 100,
      totalBilledCharges: Math.round(totalBilledCharges * 100) / 100,
      unmatchedAwbs,
      matchedOrders,
      summaryReport: forwardSummary?.summary || null,
      importId,
      notes:
        notes.length > 0
          ? notes
          : [
              `Successfully synced ${matchedOrders.length} orders from Velocity API (${remittancesMatched} remittances, ${chargesAudited} freight charge audits).`,
            ],
      durationMs,
    };
  }

  /**
   * Health and overview metrics for Velocity financial operations
   */
  async getFinancialOverview(params?: { startDate?: string; endDate?: string }): Promise<{
    configured: boolean;
    lastSync: Date | null;
    matchedCount: number;
    totalRemittance: number | null;
    totalBilledCharges: number | null;
    latestBatch: string | null;
    summaryReport: any;
  }> {
    const configured = Boolean(config.velocity.apiToken);
    let lastRecord: any = null;
    try {
      lastRecord = await prisma.reconciliationImport.findFirst({
        where: { kind: 'VELOCITY_REMITTANCE' },
        orderBy: { createdAt: 'desc' },
      });
    } catch (err: any) {
      logger.warn('Failed reading latest Velocity reconciliation import', { error: err.message });
    }

    let summaryReport: any = null;
    if (configured) {
      try {
        const start = params?.startDate || new Date(Date.now() - 30 * 86400000).toISOString();
        const end = params?.endDate || new Date().toISOString();
        const report = await this.vService.getSummaryReport({
          startDateTime: start,
          endDateTime: end,
          shipmentType: 'forward',
        });
        summaryReport = report?.summary || null;
      } catch {
        summaryReport = (lastRecord?.summary as any)?.summaryReport || null;
      }
    }

    let remittedAgg: any = null;
    let chargesAgg: any = null;
    try {
      const velocityFilter = {
        OR: [
          { courier: { contains: 'velocity', mode: 'insensitive' as const } },
          { courier: { contains: 'Velocity' as const } },
        ],
      };
      if (typeof (prisma.shipment as any).aggregate === 'function') {
        [remittedAgg, chargesAgg] = await Promise.all([
          prisma.shipment.aggregate({
            where: { ...velocityFilter, codRemitted: true },
            _sum: { codRemittedAmount: true },
            _count: { _all: true },
          }),
          prisma.shipment.aggregate({
            where: { ...velocityFilter, billingStatus: 'AUDITED' },
            _sum: { netBilledCost: true },
          }),
        ]);
      }
    } catch (aggErr: any) {
      logger.warn('Failed aggregating Velocity financial overview totals', { error: aggErr.message });
    }

    const dbMatchedCount = remittedAgg?._count?._all;
    const dbTotalRemittance = remittedAgg?._sum?.codRemittedAmount;
    const dbTotalCharges = chargesAgg?._sum?.netBilledCost;

    return {
      configured,
      lastSync: lastRecord?.createdAt || null,
      matchedCount: dbMatchedCount ?? lastRecord?.matchedCount ?? 0,
      totalRemittance: dbTotalRemittance ?? (lastRecord?.summary as any)?.totalRemittance ?? null,
      totalBilledCharges: dbTotalCharges ?? (lastRecord?.summary as any)?.totalBilledCharges ?? null,
      latestBatch: lastRecord?.fileName || null,
      summaryReport,
    };
  }

  /**
   * Syncs all available live Velocity details for a single order:
   * 1. Live Tracking events & delivery status (/custom/api/v1/order-tracking)
   * 2. Itemized shipping charges ledger (/custom/api/v1/shipping-charges)
   * 3. COD collection & remittance status, bank UTR, and remittance date (/custom/api/v1/cod-remittance)
   * 4. Updates Shipment and Order records and writes audit trail
   */
  async syncSingleOrderVelocityDetails(
    orderIdOrWaybill: number | string,
    actor?: AccountTrailActor
  ): Promise<{
    success: boolean;
    orderId: number;
    waybillNumber: string;
    courier: string;
    trackingStatus?: string;
    deliveredDate?: string | null;
    pickupDate?: string | null;
    shippingCharges?: {
      netBilledCost: number;
      forwardFreight: number;
      rtoFreight: number;
      totalDebited: number;
      totalCredited: number;
      billingStatus: string;
    };
    codRemittance?: {
      codCollected: boolean;
      codRemitted: boolean;
      utr?: string | null;
      remittedAmount?: number;
      remittanceDate?: string | null;
    };
    errors?: string[];
    message: string;
  }> {
    const isId = typeof orderIdOrWaybill === 'number' || /^\d+$/.test(String(orderIdOrWaybill));
    const order = await prisma.order.findFirst({
      where: isId ? { id: Number(orderIdOrWaybill) } : { shipment: { waybillNumber: String(orderIdOrWaybill).trim() } },
      include: { shipment: true, items: true },
    });
    if (!order || !order.shipment?.waybillNumber) {
      throw new Error(`Order or waybill not found for Velocity sync: ${orderIdOrWaybill}`);
    }

    const waybill = order.shipment.waybillNumber.trim();
    const syncErrors: string[] = [];
    let trackingStatus = order.shipment.trackingStatus || undefined;
    let deliveredDate: string | null = null;
    let pickupDate: string | null = null;
    let courierToSave = order.shipment.courier || 'Velocity';

    // 1. Live Tracking Sync
    try {
      const vTracking = await this.vService.trackShipment(waybill);
      const mapped = this.vService.mapTrackingToShipmentStatus(vTracking.shipmentStatus || vTracking.currentStatus);
      trackingStatus = mapped.description;
      deliveredDate = vTracking.deliveredDate || null;
      pickupDate = vTracking.pickupDate || null;

      courierToSave = 'Velocity';

      // Appending new tracking logs
      if (vTracking.activities && vTracking.activities.length > 0) {
        const existingLogs = await prisma.trackingLog.findMany({
          where: { shipmentId: order.shipment.id },
          select: { scannedAt: true, status: true },
        });

        const newScans: Array<{ status: string; location: string | null; remark: string | null; scannedAt: Date }> = [];
        for (const act of vTracking.activities) {
          const actDate = new Date(act.date);
          const exists = existingLogs.some(
            (log) => log.status === act.activity && log.scannedAt.getTime() === actDate.getTime()
          );
          if (!exists) {
            newScans.push({
              status: act.activity,
              location: act.location || null,
              remark: null,
              scannedAt: actDate,
            });
          }
        }
        if (newScans.length > 0) {
          await prisma.trackingLog.createMany({
            data: newScans.map((s) => ({
              shipmentId: order.shipment!.id,
              status: s.status,
              location: s.location,
              remark: s.remark,
              scannedAt: s.scannedAt,
            })),
          });
        }
      }

      const updateData: any = {
        trackingStatus: mapped.description,
        trackingLocation: vTracking.activities?.find((a: any) => Boolean(a.location))?.location || vTracking.activities?.[0]?.location || order.shipment.trackingLocation || vTracking.destination || vTracking.origin,
        trackingUpdatedAt: new Date(),
        trackingHistory: vTracking.activities as any,
        courier: courierToSave,
      };

      if (vTracking.pickupDate && !order.shipment.omsManifestedAt) {
        updateData.omsManifestedAt = new Date(vTracking.pickupDate);
      }
      const isCodOrder = order.paymentMethod === 'COD' || order.shipment.paymentMode === 'COD';
      if (vTracking.deliveredDate && isCodOrder) {
        updateData.codCollected = true;
        if (!order.shipment.codCollectedAt) {
          updateData.codCollectedAt = new Date(vTracking.deliveredDate);
        }
      }
      if (mapped.shipmentStatus !== order.shipment.status) {
        updateData.status = mapped.shipmentStatus;
      }

      await prisma.shipment.update({
        where: { id: order.shipment.id },
        data: updateData,
      });

      if (vTracking.deliveredDate && order.status !== 'DELIVERED') {
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'DELIVERED', deliveredAt: new Date(vTracking.deliveredDate) },
        });
      } else if (mapped.shipmentStatus === 'RTO_DELIVERED' && order.status !== 'RTO_DELIVERED') {
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'RTO_DELIVERED' },
        });
      } else if (mapped.shipmentStatus === 'RTO' && order.status !== 'RTO_INITIATED') {
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'RTO_INITIATED' },
        });
      } else if (mapped.shipmentStatus === 'FAILED' && order.status !== 'FAILED_DELIVERY') {
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'FAILED_DELIVERY' },
        });
      }
    } catch (trackErr: any) {
      syncErrors.push(`Tracking: ${trackErr.message}`);
      logger.warn('Velocity single order live tracking failed', { waybill, error: trackErr.message });
    }

    // 2. Shipping Charges Sync
    let chargesSummary: any = undefined;
    try {
      const chargesRes = await this.vService.getShippingCharges([waybill]);
      const item = chargesRes[0];
      if (item && item.charges && item.charges.length > 0) {
        let debits = 0;
        let credits = 0;
        let forwardFreight = 0;
        let rtoFreight = 0;

        for (const c of item.charges) {
          const amountWithGst = Number(c.amountWithGst || 0);
          const event = String(c.eventType || '').toLowerCase();
          const txn = String(c.transactionType || '').toLowerCase();

          if (txn.includes('rto') || event.includes('rto')) {
            rtoFreight += Math.abs(amountWithGst);
          } else if (txn.includes('forward') || txn.includes('freight') || event.includes('debit')) {
            forwardFreight += Math.abs(amountWithGst);
          }

          if (txn.includes('credit') || event.includes('credit') || amountWithGst < 0) {
            credits += Math.abs(amountWithGst);
          } else {
            debits += Math.abs(amountWithGst);
          }
        }

        const netCost = Math.max(0, debits - credits);
        chargesSummary = {
          netBilledCost: Math.round(netCost * 100) / 100,
          forwardFreight: Math.round(forwardFreight * 100) / 100,
          rtoFreight: Math.round(rtoFreight * 100) / 100,
          totalDebited: Math.round(debits * 100) / 100,
          totalCredited: Math.round(credits * 100) / 100,
          billingStatus: 'BILLED',
        };

        await prisma.shipment.update({
          where: { id: order.shipment.id },
          data: {
            initialCost: chargesSummary.forwardFreight,
            netBilledCost: chargesSummary.netBilledCost,
            totalDebited: chargesSummary.totalDebited,
            totalCredited: chargesSummary.totalCredited,
            billingStatus: 'BILLED',
            // Same cost fields the bulk sync writes; the order card reads these, not netBilledCost
            forwardCharge: chargesSummary.forwardFreight || chargesSummary.netBilledCost,
            rtoCharge: chargesSummary.rtoFreight,
            shippingCostSource: 'ACTUAL',
            shippingCostUpdatedAt: new Date(),
            walletTransactions: toWalletTransactions(waybill, item.charges),
          },
        });
      }
    } catch (chargeErr: any) {
      syncErrors.push(`Charges: ${chargeErr.message}`);
      logger.warn('Velocity single order shipping charges failed', { waybill, error: chargeErr.message });
    }

    // 3. COD Remittance Sync
    let codSummary: any = undefined;
    const isCod = order.paymentMethod === 'COD' || order.shipment.paymentMode === 'COD';
    if (isCod) {
      try {
        const remitRes = await this.vService.getCodRemittance([waybill]);
        const rItem = remitRes[0];
        if (rItem && !rItem.error) {
          const applied = await this.applyCodRemittanceEntry(
            order,
            rItem,
            actor || { name: 'Velocity Order Sync' }
          );
          if (applied.collected || applied.remitted) {
            codSummary = {
              codCollected: applied.collected,
              codRemitted: applied.remitted,
              utr: applied.utr,
              remittedAmount: applied.remittedVal,
              remittanceDate: applied.remittanceDate,
            };
          }
        }
      } catch (remitErr: any) {
        syncErrors.push(`Remittance: ${remitErr.message}`);
        logger.warn('Velocity single order COD remittance sync failed', { waybill, error: remitErr.message });
      }
    }

    const hasAnySuccess = Boolean(trackingStatus || chargesSummary || codSummary);
    return {
      success: hasAnySuccess,
      orderId: order.id,
      waybillNumber: waybill,
      courier: courierToSave,
      trackingStatus,
      deliveredDate,
      pickupDate,
      shippingCharges: chargesSummary,
      codRemittance: codSummary,
      errors: syncErrors.length > 0 ? syncErrors : undefined,
      message: hasAnySuccess
        ? `Velocity details synced for ${order.shopifyOrderName} (AWB: ${waybill})${syncErrors.length ? ` (warnings: ${syncErrors.join('; ')})` : ''}`
        : `Velocity sync failed: ${syncErrors.join('; ') || 'No details returned'}`,
    };
  }
}

export const velocityFinancialSyncService = new VelocityFinancialSyncService();
export default velocityFinancialSyncService;
