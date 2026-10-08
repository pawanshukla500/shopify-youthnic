/**
 * Shipping cost per AWB and leg (forward, RTO, reverse pickup).
 *
 * Delhivery has no API for billed charges, so each leg first gets Delhivery's
 * own rate-card ESTIMATE from its cost API. Uploading the wallet ledger or an
 * invoice backup (reconciliation.service) replaces it with the ACTUAL charge;
 * an ACTUAL figure is never overwritten by an estimate. Each leg keeps its own
 * source (forward: shippingCostSource, RTO: rtoChargeSource).
 *
 * The cost API allows only ~50 calls per 5 minutes per IP, so each run makes a
 * few spaced calls and leaves the rest for the next run.
 */
import prisma from '../../database/prisma';
import { config } from '../../config';
import logger from '../../utils/logger';
import delhiveryService from '../delhivery/delhivery.service';

type Task =
  | { kind: 'forward' | 'rto'; awb: string; shipmentId: number; pincode: string; cod: boolean; codAmount: number; weight: number }
  | { kind: 'reverse'; awb: string; returnId: number; pincode: string; weight: number };

/** AWBs whose estimate failed recently (bad pincode, API hiccup): retried after a pause. */
const failedAt = new Map<string, number>();
const FAILURE_PAUSE_MS = 12 * 60 * 60 * 1000;

/** AWBs of one leg kind that failed within the pause, to exclude in the query itself. */
function pausedAwbs(kind: Task['kind'], now: number): string[] {
  const awbs: string[] = [];
  for (const [key, at] of failedAt) {
    if (now - at >= FAILURE_PAUSE_MS) {
      failedAt.delete(key);
      continue;
    }
    const [k, awb] = key.split(':');
    if (k === kind) awbs.push(awb);
  }
  return awbs;
}

/**
 * Delhivery (or carrier not recorded). Filtered in the query, not afterwards,
 * so other carriers' shipments can never fill the batch and starve new orders.
 */
const DELHIVERY_COURIER = [{ courier: null }, { courier: { contains: 'delhivery', mode: 'insensitive' as const } }];
const DELHIVERY_CARRIER = [{ carrier: null }, { carrier: { contains: 'delhivery', mode: 'insensitive' as const } }];

/**
 * "Not uploaded as ACTUAL", spelled out per column. A Prisma `not` filter on a
 * nullable column also drops NULL rows (SQL three-valued logic).
 */
const notActual = (column: 'shippingCostSource' | 'rtoChargeSource') => [{ [column]: null }, { [column]: 'ESTIMATE' }];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Estimate the next few legs that have no cost yet.
 * @returns how many legs got an estimate
 */
export async function estimatePendingShippingCosts(
  options: { limit?: number; spacingMs?: number } = {}
): Promise<number> {
  if (!config.delhivery.apiToken) return 0;
  const limit = options.limit ?? 8;
  const spacingMs = options.spacingMs ?? 6500;
  const cutoff = config.shopify.syncStartDate;
  const declared = config.delhivery.declaredWeightGrams || 500;
  const now = Date.now();

  const [forward, rto, reverse] = await Promise.all([
    prisma.shipment.findMany({
      where: {
        waybillNumber: { not: null, notIn: pausedAwbs('forward', now) },
        forwardCharge: null,
        status: { notIn: ['ERROR', 'CANCELLED', 'PENDING'] },
        OR: DELHIVERY_COURIER,
        order: { shopifyCreatedAt: { gte: cutoff } },
      },
      include: { order: { select: { customerPincode: true } } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    }),
    prisma.shipment.findMany({
      where: {
        waybillNumber: { not: null, notIn: pausedAwbs('rto', now) },
        rtoCharge: null,
        status: { in: ['RTO', 'RTO_DELIVERED'] },
        OR: DELHIVERY_COURIER,
        order: { shopifyCreatedAt: { gte: cutoff } },
      },
      include: { order: { select: { customerPincode: true } } },
      take: limit,
    }),
    prisma.return.findMany({
      where: {
        returnWaybillNumber: { not: null, notIn: pausedAwbs('reverse', now) },
        shippingCharge: null,
        returnStatus: { not: 'CANCELLED' },
        OR: DELHIVERY_CARRIER,
        order: { shopifyCreatedAt: { gte: cutoff } },
      },
      include: { order: { select: { customerPincode: true } } },
      take: limit,
    }),
  ]);

  const tasks: Task[] = [
    ...forward.map((s): Task => ({
      kind: 'forward',
      awb: s.waybillNumber!,
      shipmentId: s.id,
      pincode: s.order.customerPincode,
      cod: s.paymentMode === 'COD',
      codAmount: s.codAmount || 0,
      weight: s.billedWeightGrams || declared,
    })),
    ...rto.map((s): Task => ({
      kind: 'rto',
      awb: s.waybillNumber!,
      shipmentId: s.id,
      pincode: s.order.customerPincode,
      cod: false,
      codAmount: 0,
      weight: s.billedWeightGrams || declared,
    })),
    ...reverse.map((r): Task => ({
      kind: 'reverse',
      awb: r.returnWaybillNumber!,
      returnId: r.id,
      pincode: r.order.customerPincode,
      weight: declared,
    })),
  ].slice(0, limit);

  let estimated = 0;
  for (const [index, task] of tasks.entries()) {
    if (index > 0) await sleep(spacingMs);
    try {
      const rate = await delhiveryService.fetchLiveShippingRate({
        mode: config.delhivery.shippingMode === 'Express' ? 'E' : 'S',
        chargeableWeightGrams: task.weight,
        originPincode: config.delhivery.seller.pincode,
        destinationPincode: task.pincode,
        shipmentStatus: task.kind === 'forward' ? 'Delivered' : task.kind === 'rto' ? 'RTO' : 'DTO',
        // RTO and reverse legs carry no cash, so no COD handling charge.
        paymentType: task.kind === 'forward' && task.cod ? 'COD' : 'Pre-paid',
        codAmount: task.kind === 'forward' && task.cod ? task.codAmount : undefined,
      });
      if (task.kind === 'reverse') {
        await prisma.return.updateMany({
          where: { id: task.returnId, shippingCharge: null },
          data: { shippingCharge: rate.total, shippingCostSource: 'ESTIMATE' },
        });
      } else if (task.kind === 'forward') {
        // Conditional on no ACTUAL upload having landed in the meantime.
        await prisma.shipment.updateMany({
          where: { id: task.shipmentId, OR: notActual('shippingCostSource') },
          data: {
            forwardCharge: rate.total,
            shippingCostSource: 'ESTIMATE',
            shippingCostUpdatedAt: new Date(),
            ...(rate.zone ? { chargedZone: rate.zone } : {}),
          },
        });
      } else {
        await prisma.shipment.updateMany({
          where: { id: task.shipmentId, OR: notActual('rtoChargeSource') },
          data: { rtoCharge: rate.total, rtoChargeSource: 'ESTIMATE', shippingCostUpdatedAt: new Date() },
        });
      }
      estimated++;
    } catch (error: any) {
      failedAt.set(`${task.kind}:${task.awb}`, Date.now());
      logger.warn('Shipping cost estimate failed', { awb: task.awb, leg: task.kind, error: error.message });
    }
  }
  return estimated;
}

/** For tests. */
export function resetShippingCostFailures(): void {
  failedAt.clear();
}
