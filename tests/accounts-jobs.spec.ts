/**
 * Accounts background jobs: gateway settlement connectors, shipping-cost
 * estimates, and the closing job.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prismaStub, axiosStub, delhiveryStub, shopifyStub } = vi.hoisted(() => ({
  prismaStub: {
    order: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    shipment: { findMany: vi.fn(), updateMany: vi.fn() },
    return: { findMany: vi.fn(), updateMany: vi.fn() },
    reconciliationImport: { create: vi.fn() },
    accountTrailEvent: { create: vi.fn(), findFirst: vi.fn() },
  },
  axiosStub: { get: vi.fn(), post: vi.fn() },
  delhiveryStub: { fetchLiveShippingRate: vi.fn() },
  shopifyStub: { updateOrderTags: vi.fn() },
}));
vi.mock('../src/database/prisma', () => ({ default: { ...prismaStub, $transaction: vi.fn(async (fn: any) => fn(prismaStub)) } }));
vi.mock('axios', () => ({ default: axiosStub }));
vi.mock('../src/modules/delhivery/delhivery.service', () => ({ default: delhiveryStub }));
vi.mock('../src/modules/shopify/shopify.service', () => ({ default: shopifyStub }));

import { config } from '../src/config';
import {
  fetchEasebuzzSettlements,
  phonePeAmountToRupees,
  syncGatewaySettlements,
} from '../src/modules/accounts/gateway-settlement.service';
import { estimatePendingShippingCosts, resetShippingCostFailures } from '../src/modules/accounts/shipping-cost.service';
import { backfillDeliveredAt, closeSettledOrders, deliveredScanTime } from '../src/modules/accounts/accounts.service';

const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  for (const group of [...Object.values(prismaStub), axiosStub, delhiveryStub, shopifyStub]) {
    for (const fn of Object.values(group)) (fn as any).mockReset();
  }
  prismaStub.order.update.mockResolvedValue({});
  prismaStub.accountTrailEvent.create.mockResolvedValue({ id: 1 });
  prismaStub.order.findUnique.mockImplementation(async ({ where }: any) => ({ id: where.id, paymentReceivedAt: null, paymentReceivedUtr: null, paymentReceivedRef: null }));
  prismaStub.order.updateMany.mockResolvedValue({ count: 1 });
  prismaStub.shipment.updateMany.mockResolvedValue({ count: 1 });
  prismaStub.return.updateMany.mockResolvedValue({ count: 1 });
  config.phonepe.clientId = '';
  config.phonepe.clientSecret = '';
  config.easebuzz.key = '';
  config.easebuzz.salt = '';
});

describe('PhonePe settlements', () => {
  it('reads paise as rupees, but keeps a figure that only makes sense in rupees', () => {
    expect(phonePeAmountToRupees(74060, 754.52)).toBe(740.6);
    expect(phonePeAmountToRupees(740.6, 754.52)).toBe(740.6);
    expect(phonePeAmountToRupees(9_999_999, 754.52)).toBeNull();
    expect(phonePeAmountToRupees(1392)).toBe(13.92);
  });

  it('is a no-op without credentials', async () => {
    const result = await syncGatewaySettlements();
    expect(result).toEqual({ phonepe: 0, easebuzz: 0, unmatched: [] });
    expect(axiosStub.post).not.toHaveBeenCalled();
  });

  it('records the settlement UTR and fee on the matched prepaid order', async () => {
    config.phonepe.clientId = 'cid';
    config.phonepe.clientSecret = 'secret';
    axiosStub.post.mockResolvedValue({ data: { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 } });
    axiosStub.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/settlements/v1/range')) {
        return { data: { settlements: [{ settlementId: 'S1', state: 'PROCESSED', utr: 'HDFC0001', date: 1791520000000 }] } };
      }
      return {
        data: {
          utr: 'HDFC0001',
          orders: [
            {
              merchantOrderId: 'GK-26YOU5913',
              transactionId: 'OM123',
              amount: 75452,
              settlementDetails: { settlementAmount: 74060, totalCharges: 1180, totalTax: 212 },
            },
          ],
        },
      };
    });
    prismaStub.order.findMany.mockImplementation(async ({ where }: any) =>
      where.OR.some((c: any) => c.gokwikPaymentId === 'GK-26YOU5913')
        ? [{ id: 70, paymentMethod: 'Pre-paid', totalAmount: 754.52 }]
        : []
    );

    const result = await syncGatewaySettlements();

    expect(result.phonepe).toBe(1);
    const tokenCall = axiosStub.post.mock.calls[0];
    expect(tokenCall[0]).toBe('https://api.phonepe.com/apis/identity-manager/v1/oauth/token');
    expect(String(tokenCall[1])).toContain('grant_type=client_credentials');
    expect(axiosStub.get.mock.calls[0][1].headers.Authorization).toBe('O-Bearer tok');
    expect(prismaStub.order.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 70 },
      data: {
        paymentReceivedUtr: 'HDFC0001',
        paymentReceivedAmount: 740.6,
        gatewayFee: 13.92,
        paymentReceivedRef: 'S1',
        paymentReceivedSource: 'PHONEPE_SETTLEMENT_API',
      },
    });
  });
});

describe('Easebuzz payouts', () => {
  it('signs the request with sha512(key|start|end|salt) and reads each transaction', async () => {
    config.easebuzz.key = 'KEY';
    config.easebuzz.salt = 'SALT';
    axiosStub.post.mockResolvedValue({
      data: {
        payouts_history_data: [
          {
            bank_transaction_id: 'ICIC0009',
            payout_actual_date: '09-10-2026',
            peb_transactions: [{ txnid: 'TXN1', peb_settlement_amount: '736.50', peb_service_charge: '15.00', peb_service_tax: '2.70' }],
          },
        ],
      },
    });

    const from = new Date('2026-10-06T00:00:00.000Z');
    const to = new Date('2026-10-09T00:00:00.000Z');
    const lines = await fetchEasebuzzSettlements(from, to);

    const body = axiosStub.post.mock.calls[0][1];
    expect(body.payout_date).toEqual({ start_date: '06-10-2026', end_date: '09-10-2026' });
    expect(body.hash).toBe(createHash('sha512').update('KEY|06-10-2026|09-10-2026|SALT').digest('hex'));
    expect(lines).toEqual([
      expect.objectContaining({ references: ['TXN1'], utr: 'ICIC0009', amount: 736.5, fee: 17.7 }),
    ]);
  });
});

describe('shipping cost estimates', () => {
  beforeEach(() => {
    resetShippingCostFailures();
    config.delhivery.apiToken = 'token';
  });

  it('estimates forward, RTO and reverse legs with the right Delhivery status and no COD charge on returns', async () => {
    prismaStub.shipment.findMany
      .mockResolvedValueOnce([{ id: 1, waybillNumber: 'F1', courier: 'Delhivery', paymentMode: 'COD', codAmount: 999, billedWeightGrams: null, order: { customerPincode: '560102' } }])
      .mockResolvedValueOnce([{ id: 2, waybillNumber: 'R1', courier: 'Delhivery', paymentMode: 'COD', billedWeightGrams: 750, order: { customerPincode: '110001' } }]);
    prismaStub.return.findMany.mockResolvedValue([{ id: 9, returnWaybillNumber: 'V1', carrier: 'Delhivery', order: { customerPincode: '400001' } }]);
    delhiveryStub.fetchLiveShippingRate.mockResolvedValue({ total: 88.5, zone: 'D' });

    const estimated = await estimatePendingShippingCosts({ spacingMs: 0 });

    expect(estimated).toBe(3);
    const calls = delhiveryStub.fetchLiveShippingRate.mock.calls.map((c: any[]) => c[0]);
    expect(calls[0]).toMatchObject({ shipmentStatus: 'Delivered', paymentType: 'COD', codAmount: 999, destinationPincode: '560102', chargeableWeightGrams: 500 });
    expect(calls[1]).toMatchObject({ shipmentStatus: 'RTO', paymentType: 'Pre-paid', chargeableWeightGrams: 750 });
    expect(calls[2]).toMatchObject({ shipmentStatus: 'DTO', paymentType: 'Pre-paid' });
    // Never overwrites an uploaded ACTUAL cost.
    const forwardWrite = prismaStub.shipment.updateMany.mock.calls[0][0];
    expect(forwardWrite.where.OR).toEqual([{ shippingCostSource: null }, { shippingCostSource: 'ESTIMATE' }]);
    expect(forwardWrite.data).toMatchObject({ forwardCharge: 88.5, shippingCostSource: 'ESTIMATE' });
  });

  it('pauses an AWB whose estimate failed, excluding it in the query so it cannot block the queue', async () => {
    const forward = [{ id: 1, waybillNumber: 'F1', courier: 'Delhivery', paymentMode: 'Prepaid', order: { customerPincode: '000000' } }];
    prismaStub.shipment.findMany.mockImplementation(async ({ where }: any) =>
      where.forwardCharge === null && !where.waybillNumber.notIn.includes('F1') ? forward : []
    );
    prismaStub.return.findMany.mockResolvedValue([]);
    delhiveryStub.fetchLiveShippingRate.mockRejectedValue(new Error('pincode not serviceable'));

    await estimatePendingShippingCosts({ spacingMs: 0 });
    await estimatePendingShippingCosts({ spacingMs: 0 });

    expect(delhiveryStub.fetchLiveShippingRate).toHaveBeenCalledTimes(1);
    const secondForwardQuery = prismaStub.shipment.findMany.mock.calls[2][0].where;
    expect(secondForwardQuery.waybillNumber.notIn).toEqual(['F1']);
  });

  it('filters other carriers in the query, not after it', async () => {
    prismaStub.shipment.findMany.mockResolvedValue([]);
    prismaStub.return.findMany.mockResolvedValue([]);

    await estimatePendingShippingCosts({ spacingMs: 0 });

    const forwardWhere = prismaStub.shipment.findMany.mock.calls[0][0].where;
    expect(forwardWhere.OR).toEqual([{ courier: null }, { courier: { contains: 'delhivery', mode: 'insensitive' } }]);
    expect(prismaStub.return.findMany.mock.calls[0][0].where.OR).toEqual([
      { carrier: null },
      { carrier: { contains: 'delhivery', mode: 'insensitive' } },
    ]);
  });

  it('writes the RTO estimate with its own source, guarded against an uploaded actual', async () => {
    prismaStub.shipment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 2, waybillNumber: 'R1', courier: 'Delhivery', order: { customerPincode: '110001' } }]);
    prismaStub.return.findMany.mockResolvedValue([]);
    delhiveryStub.fetchLiveShippingRate.mockResolvedValue({ total: 64.9 });

    await estimatePendingShippingCosts({ spacingMs: 0 });

    const write = prismaStub.shipment.updateMany.mock.calls[0][0];
    expect(write.where.OR).toEqual([{ rtoChargeSource: null }, { rtoChargeSource: 'ESTIMATE' }]);
    expect(write.data).toMatchObject({ rtoCharge: 64.9, rtoChargeSource: 'ESTIMATE' });
  });
});

describe('closing job', () => {
  it('finds the delivery time in the scan history, ignoring RTO and failed attempts', () => {
    expect(
      deliveredScanTime([
        { status: 'Delivered', dateTime: '2026-10-12T06:00:00.000Z' },
        { status: 'RTO Delivered', dateTime: '2026-10-20T06:00:00.000Z' },
        { status: 'Undelivered', dateTime: '2026-10-11T06:00:00.000Z' },
      ])?.toISOString()
    ).toBe('2026-10-12T06:00:00.000Z');
  });

  it('backfills deliveredAt from the proof of delivery first', async () => {
    prismaStub.order.findMany.mockResolvedValue([
      { id: 1, shipment: { epodReceivedAt: new Date('2026-10-12T06:00:00.000Z'), trackingHistory: [], status: 'DELIVERED' } },
      { id: 2, shipment: { epodReceivedAt: null, trackingHistory: [{ status: 'Delivered', dateTime: '2026-10-13T06:00:00.000Z' }], status: 'DELIVERED' } },
      { id: 3, shipment: null },
    ]);

    expect(await backfillDeliveredAt()).toBe(2);
    expect(prismaStub.order.update.mock.calls.map((c: any[]) => c[0])).toEqual([
      { where: { id: 1 }, data: { deliveredAt: new Date('2026-10-12T06:00:00.000Z') } },
      { where: { id: 2 }, data: { deliveredAt: new Date('2026-10-13T06:00:00.000Z') } },
    ]);
  });

  it('closes settled orders past the return window and tags them on Shopify', async () => {
    const now = new Date('2026-11-08T03:30:00.000Z');
    const base = {
      shopifyOrderId: '555',
      status: 'DELIVERED',
      paymentMethod: 'COD',
      tags: 'COD_CONFIRMED',
      deliveredAt: new Date(now.getTime() - 9 * DAY),
      paymentReceivedAt: new Date(now.getTime() - 2 * DAY),
      paymentReceivedUtr: 'UTIBR52026100800123',
      shipment: { status: 'DELIVERED', waybillNumber: '1', trackingStatus: 'Delivered', trackingUpdatedAt: now },
    };
    prismaStub.order.findMany.mockResolvedValue([
      { ...base, id: 1, returns: [] },
      { ...base, id: 2, returns: [{ returnStatus: 'PICKUP_SCHEDULED' }] },
    ]);
    shopifyStub.updateOrderTags.mockResolvedValue({ success: true, tags: [] });

    expect(await closeSettledOrders(now)).toBe(1);
    expect(prismaStub.order.findMany.mock.calls[0][0].where).toMatchObject({
      accountsClosedAt: null,
      status: 'DELIVERED',
      paymentReceivedAt: { not: null },
      paymentReceivedUtr: { not: null },
      deliveredAt: { not: null, lte: new Date(now.getTime() - 7 * DAY) },
    });
    expect(prismaStub.order.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { accountsClosedAt: now } });
    expect(shopifyStub.updateOrderTags).toHaveBeenCalledWith('555', ['Payment_Received', 'Return_Window_Closed']);
  });
});
