import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VelocityService } from '../src/modules/velocity/velocity.service';
import { VelocityFinancialSyncService } from '../src/modules/velocity/velocity-financial-sync.service';
import shippingLabelService from '../src/modules/delhivery/shipping-label.service';
import axios from 'axios';

const { mockAxiosInstance, mockAxiosStatic } = vi.hoisted(() => {
  const instance = {
    get: vi.fn(),
    post: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
    defaults: { headers: {} },
  };
  const stat = {
    create: vi.fn(() => instance),
    get: vi.fn(),
    post: vi.fn(),
  };
  return { mockAxiosInstance: instance, mockAxiosStatic: stat };
});

vi.mock('axios', () => ({
  default: mockAxiosStatic,
  ...mockAxiosStatic,
}));

const mockAxios = mockAxiosStatic;

const { prismaStub, reconStub } = vi.hoisted(() => ({
  prismaStub: {
    shipment: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      upsert: vi.fn(),
    },
    order: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    trackingLog: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    reconciliationImport: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    accountTrailEvent: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (cb: any) => cb(prismaStub)),
  },
  reconStub: {
    findOrderByReference: vi.fn(),
    recordPaymentReceived: vi.fn(),
  },
}));

vi.mock('../src/database/prisma', () => ({ default: prismaStub }));
vi.mock('../src/modules/accounts/reconciliation.service', () => reconStub);
vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { config } from '../src/config';

describe('Velocity Aggregator Integration & Business Rules', () => {
  let velocityService: VelocityService;
  let financialSyncService: VelocityFinancialSyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    config.velocity.apiToken = 'test-velocity-token';

    mockAxiosStatic.create.mockReturnValue(mockAxiosInstance);
    mockAxiosInstance.get.mockReset();
    mockAxiosInstance.post.mockReset();
    mockAxiosStatic.get.mockReset();
    mockAxiosStatic.post.mockReset();

    velocityService = new VelocityService();
    (velocityService as any).client = mockAxiosInstance;
    financialSyncService = new VelocityFinancialSyncService(velocityService);
  });

  describe('Courier Partner Discovery & Rate Calculation', () => {
    it('normalizes multiple courier partners from serviceability check', async () => {
      (velocityService as any).client.post = vi.fn().mockResolvedValueOnce({
        data: {
          status: 'SUCCESS',
          zone: 'Zone B',
          result: {
            serviceability_results: [
              {
                carrier_id: '101',
                carrier_name: 'Amazon Transportation',
                min_weight: 0.1,
                max_weight: 5.0,
                price: 45.5,
                expected_delivery_days: 2,
                cod_available: true,
              },
              {
                carrier_id: '102',
                carrier_name: 'BlueDart Express',
                min_weight: 0.2,
                max_weight: 10.0,
                price: 68.0,
                expected_delivery_days: 1,
                cod_available: false,
              },
            ],
          },
        },
      });

      const res = await velocityService.checkServiceability({
        fromPincode: '395002',
        toPincode: '400001',
        paymentMode: 'cod',
      });

      expect(res.serviceable).toBe(true);
      expect(res.couriers.length).toBe(2);
      expect(res.couriers[0].carrier_name).toBe('Amazon Transportation');
      expect(res.couriers[0].price).toBe(45.5);
      expect(res.couriers[0].expected_delivery_days).toBe(2);
      expect(res.couriers[1].carrier_name).toBe('BlueDart Express');
      expect(res.couriers[1].cod_available).toBe(false);
    });

    it('calculates and normalizes courier rates and SLAs', async () => {
      (velocityService as any).client.post = vi.fn().mockResolvedValueOnce({
        data: {
          payload: [
            {
              carrier_id: 'ats-air',
              carrier_name: 'Amazon Air',
              freight_charge: 55,
              cod_charge: 0,
              total_charge: 55,
              expected_delivery_days: 2,
            },
            {
              carrier_id: 'bluedart-surface',
              carrier_name: 'Blue Dart Surface',
              freight_charge: 42,
              cod_charge: 15,
              total_charge: 57,
              expected_delivery_days: 3,
            },
          ],
        },
      });

      const rates = await velocityService.calculateCourierRates({
        originPincode: '395002',
        destinationPincode: '400001',
        deadWeightGrams: 400,
        lengthCm: 20,
        widthCm: 15,
        heightCm: 3,
        paymentMethod: 'cod',
      });

      expect(rates.length).toBe(2);
      expect(rates[0].carrierName).toBe('Amazon Air');
      expect(rates[0].freightCharge).toBe(55);
      expect(rates[1].carrierName).toBe('Blue Dart Surface');
      expect(rates[1].totalCharge).toBe(57);
    });

    it('passes explicit carrierId to forward order orchestration payload', async () => {
      (velocityService as any).client.post = vi.fn().mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            order_id: '#26YOU6001',
            shipment_id: 'SH-888',
            awb_code: 'VEL-ATS-999',
            courier_name: 'Amazon Transportation',
            courier_company_id: '101',
            label_url: 'https://shazam.velocity.in/labels/VEL-ATS-999.pdf',
          },
        },
      });

      const mockOrder: any = {
        id: 501,
        shopifyOrderId: '6001',
        shopifyOrderName: '#26YOU6001',
        customerName: 'Ananya Sharma',
        customerPhone: '9876543210',
        customerAddress: 'MG Road',
        customerCity: 'Bengaluru',
        customerState: 'Karnataka',
        customerPincode: '560001',
        paymentMethod: 'Prepaid',
        totalAmount: 1899,
        items: [{ id: 1, title: 'Designer Saree', sku: 'SAR-01', quantity: 1, price: 1899 }],
      };

      const result = await velocityService.createForwardShipment(mockOrder, {
        carrierId: '101',
      });

      expect((velocityService as any).client.post).toHaveBeenCalledWith(
        '/custom/api/v1/forward-order-orchestration',
        expect.objectContaining({
          carrier_id: '101',
          order_id: '#26YOU6001',
        })
      );
      expect(result.awbCode).toBe('VEL-ATS-999');
      expect(result.courierName).toBe('Amazon Transportation');
    });
  });

  describe('Official API Labels (Zero Custom HTML Labels)', () => {
    it('probes multiple candidate URLs and returns authentic PDF buffer', async () => {
      // Mock trackShipment to return fresh label_url
      vi.spyOn(velocityService, 'trackShipment').mockResolvedValueOnce({
        awb: 'VEL123456',
        shipmentStatus: 'in_transit',
        currentStatus: 'In Transit',
        activities: [],
        raw: {
          label_url: 'https://s3.amazonaws.com/velocity-labels/VEL123456.pdf',
        },
      });

      const pdfHeaderBytes = Buffer.from('%PDF-1.4 official label content bytes padding with enough bytes to be realistic 1234567890');
      mockAxiosStatic.get.mockResolvedValue({
        status: 200,
        data: pdfHeaderBytes,
      });
      mockAxiosInstance.get.mockResolvedValue({
        status: 200,
        data: pdfHeaderBytes,
      });

      const pdfBuffer = await velocityService.fetchOfficialLabelPdf('VEL123456');

      expect(pdfBuffer).not.toBeNull();
      expect(pdfBuffer!.subarray(0, 4).toString()).toBe('%PDF');
      expect(prismaStub.shipment.updateMany).toHaveBeenCalledWith({
        where: { waybillNumber: 'VEL123456' },
        data: { labelUrl: 'https://s3.amazonaws.com/velocity-labels/VEL123456.pdf' },
      });
    });

    it('generateLabelAndInvoiceHtml renders official PDF canvas and NO custom Delhivery HTML label for Velocity', () => {
      const mockOrder: any = {
        id: 701,
        shopifyOrderName: '#26YOU7001',
        customerName: 'Kavita Desai',
        customerPhone: '9825000000',
        customerAddress: 'Ring Road',
        customerCity: 'Surat',
        customerState: 'Gujarat',
        customerPincode: '395002',
        paymentMethod: 'Prepaid',
        totalAmount: 1200,
        items: [{ id: 1, title: 'Top', quantity: 1, price: 1200, sku: 'TOP-1' }],
        shipment: {
          courier: 'Velocity (Amazon Transportation)',
          waybillNumber: 'VEL7001',
          labelUrl: 'https://shazam.velocity.in/labels/VEL7001.pdf',
        },
      };

      const pdfBuffer = Buffer.from('%PDF-1.4 mock official velocity label bytes for testing thermal printer output');
      const html = shippingLabelService.generateLabelAndInvoiceHtml(mockOrder, 'VEL7001', pdfBuffer);

      // Must contain official PDF canvas & PDF.js embed
      expect(html).toContain('official-label-canvas');
      expect(html).toContain('pdf.min.js');
      expect(html).toContain('data-pdf-base64');
      // Must NOT contain Delhivery barcoded fake custom label
      expect(html).not.toContain('delhivery-barcode');
      expect(html).not.toContain('Delhivery ONE');
      // Must contain 100mm 150mm GST Tax Invoice
      expect(html).toContain('GST Tax Invoice');
      expect(html).toContain('100mm 150mm');
    });
  });

  describe('Single Order Automated Financial & Remittance Sync', () => {
    it('synchronizes live tracking, freight charges, and COD remittance in one call', async () => {
      prismaStub.order.findFirst.mockResolvedValueOnce({
        id: 888,
        shopifyOrderName: '#26YOU8888',
        customerCity: 'Ahmedabad',
        paymentMethod: 'COD',
        totalAmount: 999,
        status: 'DISPATCHED',
        shipment: {
          id: 44,
          waybillNumber: 'VEL88889999',
          courier: 'Velocity',
          paymentMode: 'COD',
          codAmount: 999,
          status: 'CREATED',
        },
      });

      vi.spyOn(velocityService, 'trackShipment').mockResolvedValueOnce({
        awb: 'VEL88889999',
        shipmentStatus: 'delivered',
        currentStatus: 'Delivered',
        deliveredDate: '2026-10-22T10:00:00Z',
        activities: [{ date: '2026-10-22T10:00:00Z', activity: 'Delivered', location: 'Ahmedabad' }],
        raw: { courier_name: 'Amazon Transportation' },
      });

      vi.spyOn(velocityService, 'getShippingCharges').mockResolvedValueOnce([
        {
          trackingNumber: 'VEL88889999',
          charges: [
            { eventType: 'forward_delivery', transactionType: 'freight_debit', amountWithoutGst: 42, amountWithGst: 49.56 },
            { eventType: 'cod_fee', transactionType: 'cod_debit', amountWithoutGst: 15, amountWithGst: 17.7 },
          ],
        },
      ]);

      vi.spyOn(velocityService, 'getCodRemittance').mockResolvedValueOnce([
        {
          trackingNumber: 'VEL88889999',
          deliveryDate: '2026-10-22',
          codAmount: 999,
          remittanceDate: '2026-10-22T14:30:00Z',
          utrNo: 'HDFC-VEL-998877',
        },
      ]);

      const result = await financialSyncService.syncSingleOrderVelocityDetails(888);

      expect(result.success).toBe(true);
      expect(result.courier).toBe('Velocity (Amazon Transportation)');
      expect(result.deliveredDate).toBe('2026-10-22T10:00:00Z');
      expect(result.shippingCharges?.netBilledCost).toBe(67.26);
      expect(result.codRemittance?.codRemitted).toBe(true);
      expect(result.codRemittance?.utr).toBe('HDFC-VEL-998877');

      // Verify DB updates
      expect(prismaStub.shipment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 44 },
          data: expect.objectContaining({
            netBilledCost: 67.26,
            billingStatus: 'BILLED',
          }),
        })
      );
      expect(prismaStub.shipment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 44 },
          data: expect.objectContaining({
            codRemitted: true,
            codRemittanceRef: 'HDFC-VEL-998877',
          }),
        })
      );
      expect(reconStub.recordPaymentReceived).toHaveBeenCalledWith(
        888,
        expect.objectContaining({
          amount: 999,
          utr: 'HDFC-VEL-998877',
          source: 'Velocity',
        })
      );
    });
  });
});
