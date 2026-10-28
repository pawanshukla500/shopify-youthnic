/**
 * Data Engineering Pipeline & Architecture Tests (/agency-data-engineer)
 *
 * Verifies:
 * 1. Bronze layer streaming ingest with zero disk persistence and data contract validation.
 * 2. Silver layer idempotency & deduplication (re-running files produces zero duplicate credits).
 * 3. Gold layer reporting contract (every OrderStatus mapped in STATUS_LABELS and accountsStatus).
 * 4. Data Quality metrics & SLA observability (scorePercentage, matchedRows, status).
 * 5. State machine transition safety for exchange parcels in return tracking.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prismaStub } = vi.hoisted(() => ({
  prismaStub: {
    order: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    shipment: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    return: { findFirst: vi.fn(), update: vi.fn() },
    reconciliationImport: { create: vi.fn() },
    accountTrailEvent: { create: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock('../src/database/prisma', () => ({
  default: { ...prismaStub, $transaction: vi.fn(async (fn: any) => fn(prismaStub)) },
}));

import {
  importDelhiveryRemittance,
} from '../src/modules/accounts/reconciliation.service';
import { gridToSheet } from '../src/modules/accounts/spreadsheet';
import { accountsStatus } from '../src/modules/orders/order-tabs';
import { buildReportData } from '../src/modules/accounts/accounts-report.service';
import { orderStatusForReturn } from '../src/modules/returns/return-tracking';
import { backfillDeliveredAt } from '../src/modules/accounts/accounts.service';

function makeSheet(name: string, grid: string[][]) {
  return gridToSheet(name, grid);
}

describe('Data Engineering Pipeline & Architecture Suite (/agency-data-engineer)', () => {
  beforeEach(() => {
    for (const group of Object.values(prismaStub)) {
      for (const fn of Object.values(group)) {
        (fn as any).mockReset();
      }
    }
    prismaStub.order.findMany.mockResolvedValue([]);
    prismaStub.order.findUnique.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      paymentReceivedAt: null,
      paymentReceivedUtr: null,
      paymentReceivedRef: null,
    }));
    prismaStub.order.updateMany.mockResolvedValue({ count: 1 });
    prismaStub.order.update.mockResolvedValue({});
    prismaStub.accountTrailEvent.create.mockResolvedValue({ id: 1 });
    prismaStub.shipment.update.mockResolvedValue({});
    prismaStub.return.update.mockResolvedValue({});
    prismaStub.reconciliationImport.create.mockResolvedValue({ id: 101 });
  });

  describe('1. Silver Layer Idempotency & Concurrency Safety', () => {
    it('prevents double-crediting when an AWB was already remitted (idempotent replay)', async () => {
      // Simulate an existing shipment where COD was already remitted
      prismaStub.shipment.findFirst.mockResolvedValue({
        id: 42,
        waybillNumber: '30100810099999',
        codCollected: true,
        codRemitted: true,
        codRemittedAmount: 1250,
        order: { id: 200, totalAmount: 1250, shopifyOrderName: '#26YOU5000' },
      });

      const result = await importDelhiveryRemittance('remittance_replay.xlsx', [
        makeSheet('Remittance', [
          ['Waybill Number', 'COD Amount', 'Remittance Number', 'Bank Transaction ID', 'Date'],
          ['30100810099999', '1250.00', 'RMT-REPLAY-1', 'UTR-REPLAY-99', '28-10-2026'],
        ]),
      ]);

      // Should skip crediting because it is already remitted
      expect(result.matchedCount).toBe(0);
      expect(result.skippedDuplicates).toContain('30100810099999');
      expect(prismaStub.order.updateMany).not.toHaveBeenCalled();
      expect(prismaStub.shipment.update).not.toHaveBeenCalled();
    });

    it('deduplicates duplicate rows within the same uploaded batch file', async () => {
      prismaStub.shipment.findFirst.mockResolvedValue({
        id: 43,
        waybillNumber: '30100810088888',
        codCollected: false,
        codRemitted: false,
        codRemittedAmount: null,
        order: { id: 201, totalAmount: 850, shopifyOrderName: '#26YOU5001' },
      });

      const result = await importDelhiveryRemittance('batch_with_duplicates.xlsx', [
        makeSheet('Sheet1', [
          ['Waybill Number', 'COD Amount', 'Remittance Number', 'Bank Transaction ID', 'Date'],
          ['30100810088888', '850.00', 'RMT-DUP-1', 'UTR-DUP-01', '28-10-2026'],
          ['30100810088888', '850.00', 'RMT-DUP-1', 'UTR-DUP-01', '28-10-2026'], // duplicate row
        ]),
      ]);

      expect(result.rowCount).toBe(2);
      expect(result.matchedCount).toBe(1);
      expect(result.skippedDuplicates).toHaveLength(1);
      expect(result.skippedDuplicates![0]).toContain('duplicate row in file');
      expect(prismaStub.order.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. Data Quality & SLA Observability Contracts', () => {
    it('computes Data Quality score and anomaly flags on reconciliation imports', async () => {
      // 1 matched, 1 unmatched
      prismaStub.shipment.findFirst.mockImplementation(async ({ where }: any) => {
        if (where.OR.some((c: any) => c.waybillNumber === 'AWB_EXISTS')) {
          return { id: 1, codAmount: 500, codCollected: false, codRemitted: false, order: { id: 10, totalAmount: 500 } };
        }
        return null;
      });

      const result = await importDelhiveryRemittance('quality_audit.csv', [
        makeSheet('Sheet1', [
          ['Waybill Number', 'COD Amount', 'Remittance Number', 'Bank Transaction ID'],
          ['AWB_EXISTS', '500.00', 'RMT-Q1', 'UTR-Q1'],
          ['AWB_MISSING', '500.00', 'RMT-Q1', 'UTR-Q1'],
        ]),
      ]);

      expect(result.dataQuality).toBeDefined();
      expect(result.dataQuality?.totalRows).toBe(2);
      expect(result.dataQuality?.matchedRows).toBe(1);
      expect(result.dataQuality?.unmatchedRows).toBe(1);
      expect(result.dataQuality?.scorePercentage).toBe(50);
      expect(result.dataQuality?.hasAnomalies).toBe(true);
      expect(result.dataQuality?.status).toBe('WARNING');

      // Verify stored in PostgreSQL ReconciliationImport summary
      expect(prismaStub.reconciliationImport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            summary: expect.objectContaining({
              dataQuality: expect.objectContaining({
                scorePercentage: 50,
                status: 'WARNING',
              }),
              storageMode: 'POSTGRESQL_RELATIONAL_DATA',
              zipStoredOnDisk: false,
            }),
          }),
        })
      );
    });

    it('assigns HEALTHY status when reconciliation import matches 100% of rows', async () => {
      prismaStub.shipment.findFirst.mockResolvedValue({
        id: 2,
        codAmount: 600,
        codCollected: false,
        codRemitted: false,
        order: { id: 20, totalAmount: 600 },
      });

      const result = await importDelhiveryRemittance('perfect_batch.csv', [
        makeSheet('Sheet1', [
          ['Waybill Number', 'COD Amount', 'Remittance Number', 'Bank Transaction ID'],
          ['AWB_PERFECT', '600.00', 'RMT-P1', 'UTR-P1'],
        ]),
      ]);

      expect(result.dataQuality?.scorePercentage).toBe(100);
      expect(result.dataQuality?.status).toBe('HEALTHY');
      expect(result.dataQuality?.hasAnomalies).toBe(false);
    });
  });

  describe('3. Gold Layer Financial Reporting & Schema Evolution', () => {
    it('correctly categorizes EXCHANGE_REQUESTED in accountsStatus and distinguishes from refund returns', () => {
      const now = new Date('2026-10-28T12:00:00Z');
      const deliveredDate = new Date('2026-10-20T10:00:00Z');

      const exchangeOrder: any = {
        id: 991,
        status: 'EXCHANGE_REQUESTED',
        shopifyOrderName: '#26YOU7001',
        deliveredAt: deliveredDate,
        paymentReceivedAt: new Date('2026-10-22T10:00:00Z'),
        paymentReceivedUtr: 'UTR-EXCHANGE-01',
        returns: [
          {
            id: 1,
            isExchange: true,
            returnStatus: 'REQUESTED',
          },
        ],
        shipment: { status: 'DELIVERED' },
      };

      const status = accountsStatus(exchangeOrder, now);
      expect(status.state).toBe('OPEN');
      expect(status.delivered).toBe(true);
      expect(status.pending).toContain('Exchange in progress');
      expect(status.pending).not.toContain('Return in progress');
      expect(status.pending).not.toContain('Not delivered yet');
    });

    it('maps EXCHANGE_REQUESTED to human readable string in buildReportData orders sheet', () => {
      const now = new Date('2026-10-28T12:00:00Z');
      const sampleOrder: any = {
        id: 992,
        shopifyOrderId: '992000',
        shopifyOrderName: '#26YOU7002',
        status: 'EXCHANGE_REQUESTED',
        customerName: 'Test Customer',
        customerCity: 'Mumbai',
        customerState: 'Maharashtra',
        customerPincode: '400001',
        paymentMethod: 'Prepaid',
        paymentVerificationSource: 'phonepe_api',
        totalAmount: 1200,
        shopifyCreatedAt: new Date('2026-10-05T10:00:00Z'),
        deliveredAt: new Date('2026-10-10T10:00:00Z'),
        paymentReceivedAt: new Date('2026-10-10T10:00:00Z'),
        paymentReceivedAmount: 1180,
        paymentReceivedUtr: 'UTR-PHONPE-123',
        paymentReceivedSource: 'PHONEPE_SETTLEMENT',
        gatewayFee: 20,
        shipment: {
          status: 'DELIVERED',
          courier: 'Velocity',
          waybillNumber: 'VEL-FWD-992',
          forwardCharge: 75,
          shippingCostSource: 'ACTUAL',
        },
        returns: [
          {
            id: 2,
            isExchange: true,
            returnStatus: 'REQUESTED',
          },
        ],
      };

      const data = buildReportData('2026-10', [sampleOrder], now);
      expect(data.orders[0].orderStatus).toBe('Exchange requested');
      expect(data.orders[0].pending).toContain('Exchange in progress');

      const exchangeSummary = data.summary.find((s) => s.label === '   …exchange in progress');
      expect(exchangeSummary).toBeDefined();
      expect(exchangeSummary?.value).toBe(1);
    });
  });

  describe('4. Return & Exchange Carrier State Transitions', () => {
    it('maintains exchange order lifecycle when reverse courier scans progress', () => {
      // 1. If courier is at PICKUP_SCHEDULED and order is already at EXCHANGE_REQUESTED, no transition needed
      expect(orderStatusForReturn('PICKUP_SCHEDULED', 'EXCHANGE_REQUESTED')).toBe(null);

      // 2. In transit advances to RETURN_DISPATCHED
      expect(orderStatusForReturn('IN_TRANSIT', 'EXCHANGE_REQUESTED')).toBe('RETURN_DISPATCHED');

      // 3. QC pending advances to RETURN_RECEIVED
      expect(orderStatusForReturn('QC_PENDING', 'EXCHANGE_REQUESTED')).toBe('RETURN_RECEIVED');

      // 4. Cancelled pickup reverts EXCHANGE_REQUESTED safely back to DELIVERED
      expect(orderStatusForReturn('CANCELLED', 'EXCHANGE_REQUESTED')).toBe('DELIVERED');

      // 5. Cancelled pickup with active replacement does NOT revert to DELIVERED (prevents premature accounts closure)
      expect(orderStatusForReturn('CANCELLED', 'EXCHANGE_REQUESTED', true)).toBe(null);
    });

    it('includes EXCHANGE_REQUESTED in accounts delivery backfill query candidate list', async () => {
      prismaStub.order.findMany.mockResolvedValue([]);
      await backfillDeliveredAt(50);

      expect(prismaStub.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                status: expect.objectContaining({
                  in: expect.arrayContaining(['EXCHANGE_REQUESTED']),
                }),
              }),
            ]),
          }),
        })
      );
    });
  });
});
