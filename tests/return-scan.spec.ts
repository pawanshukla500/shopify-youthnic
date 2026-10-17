import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prismaStub, shopifyStub, orderStub, resendStub, pgQueryStub } = vi.hoisted(() => ({
  prismaStub: {
    order: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    shipment: { update: vi.fn() },
    return: { update: vi.fn(), create: vi.fn() },
    accountTrailEvent: { create: vi.fn() },
  },
  shopifyStub: {
    updateOrderTags: vi.fn().mockResolvedValue({ success: true, tags: [] }),
    markReturnReceivedOnShopify: vi.fn().mockResolvedValue({ success: true, closedReturnIds: ['gid://shopify/Return/37529714887'], tagsAdded: ['Return Received', 'Return Delivered'], noteUpdated: true, errors: [] }),
    closeShopifyReturn: vi.fn().mockResolvedValue({ success: true, status: 'CLOSED' }),
  },
  orderStub: { processRtoRefund: vi.fn() },
  resendStub: { sendEmail: vi.fn() },
  pgQueryStub: vi.fn(),
}));

vi.mock('../src/database/prisma', () => ({ default: prismaStub }));
vi.mock('../src/modules/shopify/shopify.service', () => ({ default: shopifyStub }));
vi.mock('../src/modules/orders/order.service', () => ({ default: orderStub }));
vi.mock('../src/modules/email/resend.service', () => ({ default: resendStub }));
vi.mock('pg', () => {
  return {
    Pool: vi.fn().mockImplementation(() => ({
      query: pgQueryStub,
      on: vi.fn(),
    })),
  };
});

import { returnScanService, isReturnScanClear } from '../src/modules/returns/return-scan.service';
import { config } from '../src/config';

beforeEach(() => {
  vi.clearAllMocks();
  config.returnScanDatabase = 'postgresql://testuser:testpass@localhost:5432/testdb';
  config.codRefundEmail = 'listings@vbexports.co.in';
  (returnScanService as any).pool = { query: pgQueryStub, on: vi.fn() };
});

describe('isReturnScanClear', () => {
  it('returns true when outcome is clear and issue_label is No issue', () => {
    expect(isReturnScanClear({ outcome: 'clear', issue_label: 'No issue' })).toBe(true);
  });

  it('returns true when issue_label is Iron Send (iron issue is not a blocker)', () => {
    expect(isReturnScanClear({ outcome: 'clear', issue_label: 'Iron Send' })).toBe(true);
    expect(isReturnScanClear({ outcome: 'issue', issue_label: 'Ironing Required' })).toBe(true);
    expect(isReturnScanClear({ outcome: 'issue', issue_label: 'Iron issue' })).toBe(true);
  });

  it('returns false when outcome is issue with blocker issues', () => {
    expect(isReturnScanClear({ outcome: 'issue', issue_label: 'Wrong product' })).toBe(false);
    expect(isReturnScanClear({ outcome: 'issue', issue_label: 'Missing product or component' })).toBe(false);
    expect(isReturnScanClear({ outcome: 'issue', issue_label: 'Damaged product' })).toBe(false);
    expect(isReturnScanClear({ outcome: 'issue', issue_label: 'SKU Change' })).toBe(false);
  });
});

describe('ReturnScanService.syncReturnScans', () => {
  it('processes clear scans, marks order Return Delivered and triggers auto-refund for prepaid', async () => {
    const mockScans = [
      {
        id: 101,
        expected_return_id: 50,
        scanned_at: new Date('2026-10-17T12:00:00Z'),
        outcome: 'clear',
        issue_label: 'No issue',
        tracking_id_snapshot: '30100810010673',
        order_number_snapshot: '#26YOU5839',
        marketplace_snapshot: 'Shopify',
        scanned_tracking: '30100810010673',
      },
    ];

    pgQueryStub.mockResolvedValueOnce({ rows: mockScans });

    prismaStub.order.findFirst.mockResolvedValueOnce({
      id: 5839,
      shopifyOrderId: 'gid://shopify/Order/5839',
      shopifyOrderName: '#26YOU5839',
      status: 'IN_TRANSIT',
      paymentMethod: 'Prepaid',
      financialStatus: 'paid',
      totalAmount: 1299,
      tags: 'Confirmed, Low_RTO',
      shipment: { id: 701, waybillNumber: '30100810010673' },
      returns: [],
    });

    prismaStub.order.update.mockResolvedValueOnce({});
    prismaStub.shipment.update.mockResolvedValueOnce({});
    shopifyStub.updateOrderTags.mockResolvedValueOnce({});
    prismaStub.accountTrailEvent.create.mockResolvedValueOnce({});
    orderStub.processRtoRefund.mockResolvedValueOnce({ success: true, refundId: 're_123' });

    const result = await returnScanService.syncReturnScans(30);

    expect(result.scansChecked).toBe(1);
    expect(result.matchedOrders).toBe(1);
    expect(result.prepaidRefunded).toBe(1);
    expect(result.codQueued).toBe(0);

    // Verify order was marked RTO_DELIVERED
    expect(prismaStub.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5839 },
        data: { status: 'RTO_DELIVERED' },
      })
    );

    // Verify markReturnReceivedOnShopify was called with order details
    expect(shopifyStub.markReturnReceivedOnShopify).toHaveBeenCalledWith(
      'gid://shopify/Order/5839',
      expect.objectContaining({
        scanId: 101,
        tracking: '30100810010673',
      })
    );

    // Verify processRtoRefund was called for prepaid order
    expect(orderStub.processRtoRefund).toHaveBeenCalledWith(5839);
  });

  it('marks COD return delivered and tags with COD_MANUAL_REFUND_DUE without initiating gateway refund', async () => {
    const mockScans = [
      {
        id: 102,
        expected_return_id: 51,
        scanned_at: new Date('2026-10-17T12:00:00Z'),
        outcome: 'clear',
        issue_label: 'Iron Send',
        tracking_id_snapshot: '30100810010743',
        order_number_snapshot: '#26YOU5806',
        marketplace_snapshot: 'Shopify',
        scanned_tracking: '30100810010743',
      },
    ];

    pgQueryStub.mockResolvedValueOnce({ rows: mockScans });

    prismaStub.order.findFirst.mockResolvedValueOnce({
      id: 5806,
      shopifyOrderId: 'gid://shopify/Order/5806',
      shopifyOrderName: '#26YOU5806',
      status: 'IN_TRANSIT',
      paymentMethod: 'COD',
      financialStatus: 'pending',
      totalAmount: 999,
      tags: 'COD_CONFIRMED',
      shipment: { id: 702, waybillNumber: '30100810010743' },
      returns: [],
    });

    prismaStub.order.update.mockResolvedValueOnce({});
    prismaStub.shipment.update.mockResolvedValueOnce({});
    shopifyStub.updateOrderTags.mockResolvedValue({});
    prismaStub.accountTrailEvent.create.mockResolvedValueOnce({});

    const result = await returnScanService.syncReturnScans(30);

    expect(result.scansChecked).toBe(1);
    expect(result.matchedOrders).toBe(1);
    expect(result.prepaidRefunded).toBe(0);
    expect(result.codQueued).toBe(1);

    // processRtoRefund must NOT be called for COD orders
    expect(orderStub.processRtoRefund).not.toHaveBeenCalled();

    // Verify markReturnReceivedOnShopify was called with ironRequired: true
    expect(shopifyStub.markReturnReceivedOnShopify).toHaveBeenCalledWith(
      'gid://shopify/Order/5806',
      expect.objectContaining({
        scanId: 102,
        tracking: '30100810010743',
        ironRequired: true,
      })
    );
  });

  it('skips blocker issues like wrong product without marking delivered or refunding', async () => {
    const mockScans = [
      {
        id: 103,
        outcome: 'issue',
        issue_label: 'Wrong product',
        tracking_id_snapshot: '30100810010999',
        order_number_snapshot: '#26YOU5999',
      },
    ];

    pgQueryStub.mockResolvedValueOnce({ rows: mockScans });

    const result = await returnScanService.syncReturnScans(30);

    expect(result.scansChecked).toBe(1);
    expect(result.issuesSkipped).toBe(1);
    expect(result.matchedOrders).toBe(0);
    expect(prismaStub.order.findFirst).not.toHaveBeenCalled();
    expect(orderStub.processRtoRefund).not.toHaveBeenCalled();
  });
});

describe('ReturnScanService.sendDailyCodManualRefundDigest', () => {
  it('finds return delivered COD orders and sends email digest to listings@vbexports.co.in', async () => {
    prismaStub.order.findMany.mockResolvedValueOnce([
      {
        id: 5806,
        shopifyOrderName: '#26YOU5806',
        customerName: 'Aarav Patel',
        customerPhone: '+919876543210',
        totalAmount: 999,
        paymentReceivedUtr: 'UTR99887766',
        shipment: { waybillNumber: '30100810010743', epodStoragePath: 'gs://bucket/epod-1.jpg' },
        returns: [],
      },
    ]);

    resendStub.sendEmail.mockResolvedValueOnce({ success: true, logId: 99 });
    prismaStub.accountTrailEvent.create.mockResolvedValueOnce({});

    const res = await returnScanService.sendDailyCodManualRefundDigest();

    expect(res.sent).toBe(true);
    expect(res.ordersCount).toBe(1);
    expect(res.recipient).toBe('listings@vbexports.co.in');

    expect(resendStub.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'listings@vbexports.co.in',
        subject: expect.stringContaining('Daily COD Manual Refund Queue'),
        data: expect.objectContaining({
          customHtml: expect.stringContaining('#26YOU5806'),
        }),
      })
    );
  });
});
