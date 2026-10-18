import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VelocityFinancialSyncService } from '../src/modules/velocity/velocity-financial-sync.service';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prismaStub, velocityServiceStub, reconStub } = vi.hoisted(() => ({
  prismaStub: {
    shipment: {
      findMany: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    order: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    reconciliationImport: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    accountTrailEvent: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (cb: any) => cb(prismaStub)),
  },
  velocityServiceStub: {
    getCodRemittance: vi.fn(),
    getShippingCharges: vi.fn(),
    getShipmentsList: vi.fn(),
    getSummaryReport: vi.fn(),
  },
  reconStub: {
    findOrderByReference: vi.fn(),
    recordPaymentReceived: vi.fn(),
  },
}));

import { config } from '../src/config';

vi.mock('../src/database/prisma', () => ({ default: prismaStub }));
vi.mock('../src/modules/velocity/velocity.service', () => ({ default: velocityServiceStub }));
vi.mock('../src/modules/accounts/reconciliation.service', () => reconStub);

describe('VelocityFinancialSyncService', () => {
  let service: VelocityFinancialSyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    config.velocity.apiToken = 'test-velocity-token';
    service = new VelocityFinancialSyncService();
  });

  describe('syncVelocityFinancials', () => {
    it('synchronizes COD remittances, bank UTRs, and freight charges onto orders and shipments', async () => {
      // 1. Mock DB candidate shipments
      prismaStub.shipment.findMany.mockResolvedValueOnce([
        {
          id: 101,
          waybillNumber: 'VEL123456789',
          courier: 'Velocity',
          codRemitted: false,
          billingStatus: 'ESTIMATED',
          order: {
            id: 1,
            shopifyOrderName: '#26YOU1001',
            totalAmount: 1200,
            status: 'DELIVERED',
          },
        },
      ]);

      // 2. Mock Velocity shipments discovery API
      velocityServiceStub.getShipmentsList.mockResolvedValueOnce({
        data: [],
      });

      // 3. Mock COD remittance API response
      velocityServiceStub.getCodRemittance.mockResolvedValueOnce([
        {
          trackingNumber: 'VEL123456789',
          deliveryDate: '2026-10-16',
          codAmount: 1200,
          remittanceDate: '2026-10-17',
          utrNo: 'AXISN0987654321',
          error: null,
        },
      ]);

      // 4. Mock Shipping charges API response
      velocityServiceStub.getShippingCharges.mockResolvedValueOnce([
        {
          trackingNumber: 'VEL123456789',
          charges: [
            {
              eventType: 'shipment_debit',
              transactionType: 'forward_freight',
              amountWithoutGst: 60,
              amountWithGst: 70.8,
            },
            {
              eventType: 'platform_fee',
              transactionType: 'platform_fee',
              amountWithoutGst: 5,
              amountWithGst: 5.9,
            },
          ],
          error: null,
        },
      ]);

      // 5. Mock Summary Report API response
      velocityServiceStub.getSummaryReport.mockResolvedValueOnce({
        summary: {
          delivered: { count: 12, sum_of_cod_orders: 14400, sum_of_prepaid_orders: 0 },
          in_transit: { count: 5, sum_of_cod_orders: 6000, sum_of_prepaid_orders: 0 },
          total_shipments: 17,
        },
      });

      // 6. Mock findOrderByReference & recordPaymentReceived
      const mockOrder = {
        id: 1,
        shopifyOrderName: '#26YOU1001',
        totalAmount: 1200,
        customerCity: 'Mumbai',
        status: 'DELIVERED',
        shipment: {
          id: 101,
          waybillNumber: 'VEL123456789',
          codAmount: 1200,
        },
      };
      reconStub.findOrderByReference.mockResolvedValue(mockOrder);
      prismaStub.shipment.update.mockResolvedValue({});
      prismaStub.reconciliationImport.create.mockResolvedValue({ id: 99 });

      const result = await service.syncVelocityFinancials({ lookbackDays: 30 });

      expect(result.success).toBe(true);
      expect(result.awbsChecked).toBe(1);
      expect(result.remittancesMatched).toBe(1);
      expect(result.chargesAudited).toBe(1);
      expect(result.totalRemittanceAmount).toBe(1200);
      expect(result.totalBilledCharges).toBe(76.7); // 70.8 + 5.9

      // Verify Shipment COD remittance update
      expect(prismaStub.shipment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 101 },
          data: expect.objectContaining({
            codCollected: true,
            codRemitted: true,
            codRemittanceRef: 'AXISN0987654321',
            codRemittedAmount: 1200,
          }),
        })
      );

      // Verify Shipment Shipping Charges update
      expect(prismaStub.shipment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 101 },
          data: expect.objectContaining({
            netBilledCost: 76.7,
            totalDebited: 76.7,
            billingStatus: 'AUDITED',
            shippingCostSource: 'ACTUAL',
          }),
        })
      );

      // Verify Order Payment Received & UTR record call
      expect(reconStub.recordPaymentReceived).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          amount: 1200,
          utr: 'AXISN0987654321',
          source: 'Velocity',
        })
      );

      // Verify ReconciliationImport persistence
      expect(prismaStub.reconciliationImport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: 'VELOCITY_REMITTANCE',
            matchedCount: 1,
            summary: expect.objectContaining({
              totalRemittance: 1200,
              totalBilledCharges: 76.7,
              bankTransactionId: 'AXISN0987654321',
            }),
          }),
        })
      );
    });

    it('gracefully handles non-existent AWBs returned with error from Velocity API', async () => {
      velocityServiceStub.getCodRemittance.mockResolvedValueOnce([
        {
          trackingNumber: 'UNKNOWN_AWB',
          error: 'AWB UNKNOWN_AWB does not exist in your account.',
        },
      ]);
      velocityServiceStub.getShippingCharges.mockResolvedValueOnce([
        {
          trackingNumber: 'UNKNOWN_AWB',
          error: 'AWB UNKNOWN_AWB does not exist in your account.',
        },
      ]);
      velocityServiceStub.getSummaryReport.mockResolvedValueOnce({ summary: {} });
      prismaStub.reconciliationImport.create.mockResolvedValue({ id: 100 });

      const result = await service.syncVelocityFinancials({ awbs: ['UNKNOWN_AWB'] });

      expect(result.success).toBe(true);
      expect(result.unmatchedAwbs).toContain('UNKNOWN_AWB: AWB UNKNOWN_AWB does not exist in your account.');
      expect(result.remittancesMatched).toBe(0);
      expect(result.chargesAudited).toBe(0);
    });

    it('links newly manifested Velocity shipment to OMS order if waybill is missing', async () => {
      prismaStub.shipment.findMany.mockResolvedValueOnce([]);
      velocityServiceStub.getShipmentsList.mockResolvedValueOnce({
        data: [
          {
            attributes: {
              tracking_number: 'VEL999888',
              is_cod: true,
              cod_amount: '899',
              order: {
                display_id: '#26YOU999',
                external_id: '1234567890',
              },
            },
          },
        ],
      });

      const mockOrder = {
        id: 42,
        shopifyOrderName: '#26YOU999',
        shipment: null, // missing shipment
      };
      reconStub.findOrderByReference.mockResolvedValue(mockOrder);
      prismaStub.shipment.upsert.mockResolvedValue({});
      velocityServiceStub.getCodRemittance.mockResolvedValueOnce([]);
      velocityServiceStub.getShippingCharges.mockResolvedValueOnce([]);
      velocityServiceStub.getSummaryReport.mockResolvedValueOnce({ summary: {} });

      const result = await service.syncVelocityFinancials();

      expect(prismaStub.shipment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderId: 42 },
          create: expect.objectContaining({
            orderId: 42,
            waybillNumber: 'VEL999888',
            courier: 'Velocity',
            paymentMode: 'COD',
            codAmount: 899,
          }),
        })
      );
      expect(result.awbsChecked).toBe(1);
    });
  });

  describe('getFinancialOverview', () => {
    it('returns latest reconciliation summary and operational summary report', async () => {
      prismaStub.reconciliationImport.findFirst.mockResolvedValueOnce({
        id: 77,
        createdAt: new Date('2026-10-18T10:00:00Z'),
        matchedCount: 25,
        fileName: 'Velocity-Auto-Sync-2026-10-18',
        summary: {
          totalRemittance: 35000,
          totalBilledCharges: 1850,
        },
      });

      velocityServiceStub.getSummaryReport.mockResolvedValueOnce({
        summary: {
          delivered: { count: 20 },
          in_transit: { count: 5 },
          total_shipments: 25,
        },
      });

      const overview = await service.getFinancialOverview();

      expect(overview.configured).toBe(true);
      expect(overview.matchedCount).toBe(25);
      expect(overview.totalRemittance).toBe(35000);
      expect(overview.totalBilledCharges).toBe(1850);
      expect(overview.summaryReport.delivered.count).toBe(20);
    });
  });
});
