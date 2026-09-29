import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isDelhiveryCourier, normalizeCourierName } from '../src/utils/courier';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock axios for shopify client
vi.mock('axios', () => {
  const client = {
    interceptors: { request: { use: vi.fn() } },
    get: vi.fn(async () => ({ data: {} })),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
  };
  return { default: { create: vi.fn(() => client) } };
});

const { delhiveryStub } = vi.hoisted(() => ({
  delhiveryStub: {
    trackShipment: vi.fn(),
    mapTrackingToShipmentStatus: vi.fn((_type: string, desc: string) => {
      if (/delivered/i.test(desc)) return 'DELIVERED';
      if (/in transit|dispatched/i.test(desc)) return 'IN_TRANSIT';
      return 'CREATED';
    }),
    fetchPackagesByRefIds: vi.fn(),
  },
}));
vi.mock('../src/modules/delhivery/delhivery.service', () => ({ default: delhiveryStub }));

vi.mock('../src/modules/notifications/notification.service', () => ({
  default: {
    notifyOrderConfirmed: vi.fn(async () => undefined),
    notifyOutForDelivery: vi.fn(async () => undefined),
    notifyDelivered: vi.fn(async () => undefined),
    notifyNDR: vi.fn(async () => undefined),
    sendCustomMessage: vi.fn(async () => undefined),
  },
}));

vi.mock('../src/modules/payments/payment.service', () => ({
  default: {
    verifyPayment: vi.fn(async () => undefined),
  },
}));

const { prismaStub } = vi.hoisted(() => ({
  prismaStub: {
    order: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    shipment: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    syncLog: { create: vi.fn() },
    trackingLog: { findMany: vi.fn(), create: vi.fn() },
  },
}));
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));

import orderService from '../src/modules/orders/order.service';
import shopifyService from '../src/modules/shopify/shopify.service';

describe('External Fulfillment & Courier Normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('normalizeCourierName and isDelhiveryCourier', () => {
    it('normalizes Delhivery variants correctly', () => {
      expect(isDelhiveryCourier('Delhivery Surface', null, '1411234567890')).toBe(true);
      expect(normalizeCourierName('Delhivery Surface', null, '1411234567890')).toBe('Delhivery Surface');

      expect(isDelhiveryCourier('delhivery express', null, '1411234567890')).toBe(true);
      expect(normalizeCourierName('delhivery express', null, '1411234567890')).toBe('Delhivery Express');

      expect(isDelhiveryCourier('DELHIVERY', null, '1411234567890')).toBe(true);
      expect(normalizeCourierName('DELHIVERY', null, '1411234567890')).toBe('Delhivery');
    });

    it('infers Delhivery for generic OMS / OMS Guru when waybill is 12-15 digits', () => {
      expect(isDelhiveryCourier('OMS Guru', null, '1411234567890')).toBe(true);
      expect(normalizeCourierName('OMS Guru', null, '1411234567890')).toBe('Delhivery');

      expect(isDelhiveryCourier('omsguru', null, '123456789012')).toBe(true);
      expect(normalizeCourierName('omsguru', null, '123456789012')).toBe('Delhivery');

      expect(isDelhiveryCourier('', null, '1411234567890')).toBe(true);
      expect(normalizeCourierName('', null, '1411234567890')).toBe('Delhivery');

      expect(isDelhiveryCourier('Other', null, '1411234567890')).toBe(true);
      expect(normalizeCourierName('Other', null, '1411234567890')).toBe('Delhivery');
    });

    it('preserves and formats known third-party couriers', () => {
      expect(isDelhiveryCourier('blue dart', null, '78912345678')).toBe(false);
      expect(normalizeCourierName('blue dart', null, '78912345678')).toBe('Blue Dart');

      expect(isDelhiveryCourier('ekart', null, 'FMPP0012345678')).toBe(false);
      expect(normalizeCourierName('ekart', null, 'FMPP0012345678')).toBe('Ekart');

      expect(isDelhiveryCourier('DTDC', null, 'D12345678')).toBe(false);
      expect(normalizeCourierName('DTDC', null, 'D12345678')).toBe('DTDC');

      expect(isDelhiveryCourier('shadowfax', null, 'SFX12345678')).toBe(false);
      expect(normalizeCourierName('shadowfax', null, 'SFX12345678')).toBe('Shadowfax');

      expect(isDelhiveryCourier('xpressbees', null, '1234567890')).toBe(false);
      expect(normalizeCourierName('xpressbees', null, '1234567890')).toBe('Xpressbees');
    });
  });

  describe('orderService.fetchAndReconcileOrderFulfillment', () => {
    it('retrieves fulfillment from Shopify when processed via external OMS Guru', async () => {
      const mockOrder = {
        id: 101,
        shopifyOrderId: '6200000000001',
        shopifyOrderName: '#26YOU5701',
        shopifyOrderNumber: 5701,
        totalAmount: 1499,
        paymentMethod: 'Pre-paid',
        status: 'DISPATCH_PENDING',
        fulfillmentStatus: null,
        shipment: null,
      };

      prismaStub.order.findUnique.mockResolvedValueOnce(mockOrder);

      // Shopify returns order with fulfillment created by OMS Guru
      const fetchOrderSpy = vi.spyOn(shopifyService, 'fetchOrder').mockResolvedValueOnce({
        id: 6200000000001,
        name: '#26YOU5701',
        number: 5701,
        created_at: '2026-09-28T10:00:00Z',
        total_price: '1499.00',
        fulfillment_status: 'fulfilled',
        fulfillments: [
          {
            id: 88881,
            status: 'success',
            tracking_number: '1411234567891',
            tracking_company: 'OMS Guru',
            tracking_url: 'https://www.delhivery.com/track/package/1411234567891',
            shipment_status: 'in_transit',
            created_at: '2026-09-28T12:00:00Z',
          },
        ],
      } as any);

      const syncOrderToDbSpy = vi.spyOn(shopifyService, 'syncOrderToDb').mockResolvedValueOnce(undefined);

      // Mock DB reload with updated shipment
      const updatedOrder = {
        ...mockOrder,
        status: 'IN_TRANSIT',
        fulfillmentStatus: 'fulfilled',
        shipment: {
          id: 501,
          orderId: 101,
          waybillNumber: '1411234567891',
          courier: 'Delhivery',
          status: 'IN_TRANSIT',
        },
      };
      prismaStub.order.findUnique.mockResolvedValueOnce(updatedOrder);

      const result = await orderService.fetchAndReconcileOrderFulfillment(101);

      expect(fetchOrderSpy).toHaveBeenCalledWith('6200000000001');
      expect(syncOrderToDbSpy).toHaveBeenCalled();
      expect(result.found).toBe(true);
      expect(result.source).toBe('shopify');
      expect(result.waybillNumber).toBe('1411234567891');
      expect(result.courier).toBe('Delhivery');
    });

    it('retrieves fulfillment from Delhivery ONE Packages API when manifested directly in portal and pushes to Shopify', async () => {
      const mockOrder = {
        id: 102,
        shopifyOrderId: '6200000000002',
        shopifyOrderName: '#26YOU5702',
        shopifyOrderNumber: 5702,
        totalAmount: 1999,
        paymentMethod: 'COD',
        status: 'NEW',
        fulfillmentStatus: null,
        dispatchedAt: null,
        shipment: null,
      };

      prismaStub.order.findUnique.mockResolvedValueOnce(mockOrder);

      // Shopify has no fulfillment yet
      vi.spyOn(shopifyService, 'fetchOrder').mockResolvedValueOnce({
        id: 6200000000002,
        name: '#26YOU5702',
        number: 5702,
        created_at: '2026-09-28T10:00:00Z',
        total_price: '1999.00',
        fulfillment_status: null,
        fulfillments: [],
      } as any);

      // Delhivery ONE has the package manifested under ReferenceNo
      delhiveryStub.fetchPackagesByRefIds.mockResolvedValueOnce([
        {
          Shipment: {
            AWB: '1411999988881',
            ReferenceNo: '26YOU5702',
            Status: {
              Status: 'Manifested',
              StatusType: 'UD',
              StatusLocation: 'Surat_Warehouse',
            },
            PickedUpDate: null,
          },
        },
      ]);

      prismaStub.shipment.upsert.mockResolvedValueOnce({
        id: 502,
        orderId: 102,
        waybillNumber: '1411999988881',
        courier: 'Delhivery',
        status: 'CREATED',
        trackingStatus: 'Manifested',
      });

      prismaStub.order.update.mockResolvedValueOnce({
        ...mockOrder,
        status: 'DISPATCH_PENDING',
        dispatchedAt: new Date(),
        shipment: {
          id: 502,
          orderId: 102,
          waybillNumber: '1411999988881',
          courier: 'Delhivery',
        },
      });

      const fulfillShopifySpy = vi.spyOn(shopifyService, 'fulfillOrderOnShopify').mockResolvedValueOnce({
        success: true,
        fulfillmentId: '999901',
      });

      const result = await orderService.fetchAndReconcileOrderFulfillment(102);

      expect(delhiveryStub.fetchPackagesByRefIds).toHaveBeenCalled();
      expect(prismaStub.shipment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderId: 102 },
          create: expect.objectContaining({
            waybillNumber: '1411999988881',
            courier: 'Delhivery',
          }),
        })
      );
      // Confirms fulfillment was pushed to Shopify so Shopify reflects the external manifest!
      expect(fulfillShopifySpy).toHaveBeenCalledWith('6200000000002', '1411999988881', 'Delhivery');
      expect(result.found).toBe(true);
      expect(result.source).toBe('delhivery_one');
      expect(result.waybillNumber).toBe('1411999988881');
      expect(result.courier).toBe('Delhivery');
    });

    it('returns found: false when neither Shopify nor Delhivery ONE has fulfillment', async () => {
      const mockOrder = {
        id: 103,
        shopifyOrderId: '6200000000003',
        shopifyOrderName: '#26YOU5703',
        shopifyOrderNumber: 5703,
        totalAmount: 999,
        paymentMethod: 'Pre-paid',
        status: 'NEW',
        fulfillmentStatus: null,
        shipment: null,
      };

      prismaStub.order.findUnique.mockResolvedValueOnce(mockOrder);
      vi.spyOn(shopifyService, 'fetchOrder').mockResolvedValueOnce({
        id: 6200000000003,
        name: '#26YOU5703',
        number: 5703,
        created_at: '2026-09-28T10:00:00Z',
        total_price: '999.00',
        fulfillments: [],
      } as any);

      delhiveryStub.fetchPackagesByRefIds.mockResolvedValueOnce([]);

      const result = await orderService.fetchAndReconcileOrderFulfillment(103);
      expect(result.found).toBe(false);
      expect(result.message).toContain('No external fulfillment found');
    });
  });

  describe('orderService.reconcilePendingChannelOrders', () => {
    it('batch reconciles orders with Delhivery ONE and updates Shopify', async () => {
      const orders = [
        {
          id: 201,
          shopifyOrderId: '6200000000201',
          shopifyOrderName: '#26YOU5801',
          shopifyOrderNumber: 5801,
          totalAmount: 1200,
          paymentMethod: 'Pre-paid',
          fulfillmentStatus: null,
          dispatchedAt: null,
        },
      ];

      prismaStub.order.findMany.mockResolvedValueOnce(orders);

      delhiveryStub.fetchPackagesByRefIds.mockResolvedValueOnce([
        {
          Shipment: {
            AWB: '1411777777771',
            ReferenceNo: '26YOU5801',
            Status: { Status: 'Manifested', StatusType: 'UD' },
          },
        },
      ]);

      prismaStub.shipment.upsert.mockResolvedValueOnce({
        id: 601,
        orderId: 201,
        waybillNumber: '1411777777771',
      });

      prismaStub.order.update.mockResolvedValueOnce({});

      const fulfillShopifySpy = vi.spyOn(shopifyService, 'fulfillOrderOnShopify').mockResolvedValueOnce({
        success: true,
      });

      const count = await orderService.reconcilePendingChannelOrders();

      expect(count).toBe(1);
      expect(fulfillShopifySpy).toHaveBeenCalledWith('6200000000201', '1411777777771', 'Delhivery');
    });
  });
});
