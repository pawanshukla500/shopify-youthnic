import { describe, it, expect, vi, beforeEach } from 'vitest';
import { importGatewaySettlement } from '../src/modules/accounts/reconciliation.service';
import type { ParsedSheet } from '../src/modules/accounts/spreadsheet';
import prisma from '../src/database/prisma';

vi.mock('../src/database/prisma', () => {
  const m = {
    order: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    shipment: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    return: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    accountTrailEvent: {
      create: vi.fn(),
    },
    reconciliationImport: {
      create: vi.fn(),
    },
    $transaction: vi.fn((callback) => callback(m)),
  };
  return { default: m };
});

describe('GoKwik Gateway Settlement & Refund Reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('correctly matches GoKwik payment row via Platform Order Id and records net credit and fee', async () => {
    const sheet: ParsedSheet = {
      name: 'Settlement',
      headers: [
        'S. No.', 'Transaction Type', 'Payment Id', 'Order Id', 'Amount', 'Currency',
        'Tax', 'Fee', 'Debit', 'Credit', 'Merchant Order Id', 'Platform Order Id',
        'Settlement UTR', 'Settlement Date', 'Settled By', 'Payment Mode'
      ],
      rows: [
        {
          'S. No.': '37',
          'Transaction Type': 'Payment',
          'Payment Id': 'KWIK4N5UVO1U8834172MP',
          'Order Id': 'KWIK01F4ULNN8834079',
          'Amount': '2105.0400',
          'Currency': 'INR',
          'Tax': '9.4700',
          'Fee': '52.6300',
          'Debit': '0.0000',
          'Credit': '2042.9400',
          'Merchant Order Id': '18916477927623',
          'Platform Order Id': '#26YOU5809',
          'Settlement UTR': 'YESF262746240190',
          'Settlement Date': '1/10/2026 05:30 AM',
          'Settled By': 'easebuzz',
          'Payment Mode': 'cc'
        }
      ]
    };

    (prisma.order.findMany as any).mockResolvedValueOnce([
      {
        id: 1631,
        shopifyOrderId: '18916477927623',
        shopifyOrderName: '#26YOU5809',
        totalAmount: 2105.04,
        paymentMethod: 'Pre-paid',
        paymentReceivedAt: null,
        paymentReceivedUtr: null,
        paymentReceivedRef: null,
      }
    ]);
    (prisma.order.findUnique as any).mockResolvedValueOnce({
      id: 1631,
      totalAmount: 2105.04,
      paymentMethod: 'Pre-paid',
      financialStatus: 'paid',
      paymentReceivedAt: null,
      paymentReceivedAmount: null,
      paymentReceivedUtr: null,
      paymentReceivedRef: null,
      paymentReceivedSource: null,
      gatewayFee: null,
      deliveredAt: null,
    });
    (prisma.order.updateMany as any).mockResolvedValueOnce({ count: 1 });
    (prisma.accountTrailEvent.create as any).mockResolvedValueOnce({ id: 101 });
    (prisma.reconciliationImport.create as any).mockResolvedValueOnce({
      id: 50,
      kind: 'GOKWIK_SETTLEMENT',
      fileName: 'test-settlement.csv',
      rowCount: 1,
      matchedCount: 1,
      unmatched: [],
    });

    const res = await importGatewaySettlement(
      'test-settlement.csv',
      [sheet],
      'accounts@youthnic.com',
      'GOKWIK_SETTLEMENT'
    );

    expect(res.matchedCount).toBe(1);
    expect(res.columns.order).toBe('Platform Order Id');
    expect(res.columns.amount).toBe('Credit');
    expect(res.totalRemittance).toBe(2042.94);
    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentReceivedAmount: 2042.94,
          paymentReceivedUtr: 'YESF262746240190',
          gatewayFee: 62.1, // 52.63 fee + 9.47 tax
          paymentVerified: true,
        })
      })
    );
  });

  it('correctly handles GoKwik refund debit rows without creating conflicting UTR error', async () => {
    const sheet: ParsedSheet = {
      name: 'Settlement',
      headers: [
        'S. No.', 'Transaction Type', 'Payment Id', 'Order Id', 'Amount', 'Currency',
        'Tax', 'Fee', 'Debit', 'Credit', 'Merchant Order Id', 'Platform Order Id',
        'Settlement UTR', 'Settlement Date', 'Settled By', 'Payment Mode'
      ],
      rows: [
        {
          'S. No.': '198',
          'Transaction Type': 'Refund',
          'Payment Id': 'RKWIKGTD27GL46904296MP',
          'Order Id': 'KWIK00FTA9KR8768968',
          'Amount': '1369.0600',
          'Currency': 'INR',
          'Tax': '0.0000',
          'Fee': '0.0000',
          'Debit': '1369.0600',
          'Credit': '0.0000',
          'Merchant Order Id': '18942340923591',
          'Platform Order Id': '#26YOU5967',
          'Settlement UTR': 'YESF263006461969',
          'Settlement Date': '27/10/2026 05:30 AM',
          'Settled By': 'easebuzz',
          'Payment Mode': 'upi-ba'
        }
      ]
    };

    (prisma.order.findMany as any).mockResolvedValueOnce([
      {
        id: 1780,
        shopifyOrderId: '18942340923591',
        shopifyOrderName: '#26YOU5967',
        totalAmount: 1369.06,
        paymentMethod: 'Pre-paid',
        paymentReceivedAt: new Date('2026-10-12'),
        paymentReceivedUtr: 'YESF262857105016',
        paymentReceivedRef: 'YESF262857105016',
      }
    ]);
    (prisma.return.findFirst as any).mockResolvedValueOnce({
      id: 55,
      orderId: 1780,
      refundStatus: 'PENDING',
      refundAmount: 1369.06,
    });
    (prisma.return.update as any).mockResolvedValueOnce({ id: 55, refundStatus: 'PROCESSED' });
    (prisma.accountTrailEvent.create as any).mockResolvedValueOnce({ id: 102 });
    (prisma.reconciliationImport.create as any).mockResolvedValueOnce({
      id: 51,
      kind: 'GOKWIK_SETTLEMENT',
      fileName: 'test-refund-debit.csv',
      rowCount: 1,
      matchedCount: 1,
      unmatched: [],
    });

    const res = await importGatewaySettlement(
      'test-refund-debit.csv',
      [sheet],
      'accounts@youthnic.com',
      'GOKWIK_SETTLEMENT'
    );

    expect(res.matchedCount).toBe(1);
    expect(res.matchedOrders?.[0].status).toBe('Gateway refund debited');
    expect(res.matchedOrders?.[0].amount).toBe(-1369.06);
    expect(res.matchedOrders?.[0].utr).toBe('YESF263006461969');
    expect(prisma.return.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 55 },
        data: expect.objectContaining({
          refundStatus: 'PROCESSED',
          refundAmount: 1369.06,
        })
      })
    );
    expect(prisma.accountTrailEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'REFUND_SETTLED',
          status: 'COMPLETED',
          amount: 1369.06,
          externalReference: 'YESF263006461969',
        })
      })
    );
  });
});
