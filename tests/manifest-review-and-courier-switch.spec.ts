import { describe, it, expect, vi, beforeEach } from 'vitest';
import orderService from '../src/modules/orders/order.service';
import shopifyService from '../src/modules/shopify/shopify.service';
import { isVelocityCourier, normalizeCourierName } from '../src/utils/courier';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prismaStub } = vi.hoisted(() => ({
  prismaStub: {
    order: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
    shipment: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    setting: {
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
      upsert: vi.fn(),
    },
  },
}));
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));

vi.mock('../src/modules/delhivery/delhivery.service', () => ({
  default: {
    calculateRateCardMatrix: vi.fn(() => ({ total: 90 })),
    checkPincodeServiceability: vi.fn(async () => ({ serviceable: true })),
    createForwardShipment: vi.fn(),
    trackShipment: vi.fn(),
  },
}));

vi.mock('../src/modules/velocity/velocity.service', () => ({
  velocityService: {
    createShipment: vi.fn(async () => ({
      success: true,
      awb: 'VELOCITY-374713114560',
      labelUrl: 'https://www.velocityshipping.in/track/374713114560',
    })),
    checkServiceability: vi.fn(async () => ({ serviceable: true })),
  },
  VelocityService: vi.fn(),
}));

describe('Manifest Review Resolution & Courier Switch (Order #26YOU6128)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Self-healing in enrichOrderMetadata', () => {
    it('clears stale MANIFEST_REVIEW when order has an assigned waybill', () => {
      prismaStub.order.update.mockResolvedValue({});
      const rawOrder: any = {
        id: 1950,
        shopifyOrderId: '6200000001950',
        shopifyOrderName: '#26YOU6128',
        shopifyOrderNumber: 6128,
        totalAmount: 814,
        paymentMethod: 'COD',
        status: 'NEW',
        fulfillmentStatus: 'fulfilled',
        supportFlag: 'MANIFEST_REVIEW',
        hasUrgentSupport: true,
        shopifyCreatedAt: new Date('2026-10-22T14:48:00Z'),
        shipment: {
          id: 501,
          waybillNumber: '374713114560',
          courier: 'Velocity',
          status: 'CREATED',
        },
      };

      const enriched = orderService.enrichOrderMetadata(rawOrder);

      expect(enriched.supportFlag).toBeNull();
      expect(enriched.hasUrgentSupport).toBe(false);
      expect(prismaStub.order.update).toHaveBeenCalledWith({
        where: { id: 1950 },
        data: { supportFlag: null, hasUrgentSupport: false },
      });
    });

    it('clears stale MANIFEST_REVIEW when fulfillmentStatus is fulfilled even before waybill links', () => {
      prismaStub.order.update.mockResolvedValue({});
      const rawOrder: any = {
        id: 1950,
        shopifyOrderId: '6200000001950',
        shopifyOrderName: '#26YOU6128',
        shopifyOrderNumber: 6128,
        totalAmount: 814,
        paymentMethod: 'COD',
        status: 'NEW',
        fulfillmentStatus: 'fulfilled',
        supportFlag: 'MANIFEST_REVIEW',
        hasUrgentSupport: true,
        shopifyCreatedAt: new Date('2026-10-22T14:48:00Z'),
        shipment: null,
      };

      const enriched = orderService.enrichOrderMetadata(rawOrder);

      expect(enriched.supportFlag).toBeNull();
      expect(enriched.hasUrgentSupport).toBe(false);
      expect(prismaStub.order.update).toHaveBeenCalledWith({
        where: { id: 1950 },
        data: { supportFlag: null, hasUrgentSupport: false },
      });
    });
  });

  describe('orderService.clearManifestReview', () => {
    it('explicitly clears supportFlag and hasUrgentSupport in database', async () => {
      prismaStub.order.update.mockResolvedValueOnce({
        id: 1950,
        supportFlag: null,
        hasUrgentSupport: false,
      });

      const res = await orderService.clearManifestReview(1950);
      expect(res.success).toBe(true);
      expect(prismaStub.order.update).toHaveBeenCalledWith({
        where: { id: 1950 },
        data: { supportFlag: null, hasUrgentSupport: false },
      });
    });
  });

  describe('orderService.updateShipmentCourier', () => {
    it('updates courier to Velocity, sets velocity tracking URL and clears MANIFEST_REVIEW', async () => {
      prismaStub.order.findUnique.mockResolvedValueOnce({
        id: 1950,
        supportFlag: 'MANIFEST_REVIEW',
        paymentMethod: 'COD',
        totalAmount: 814,
        shipment: {
          id: 501,
          waybillNumber: '374713114560',
          courier: 'Delhivery',
          status: 'CREATED',
        },
      });
      prismaStub.shipment.update.mockResolvedValueOnce({});
      prismaStub.order.update.mockResolvedValueOnce({});

      const result = await orderService.updateShipmentCourier(1950, 'Velocity', '374713114560');

      expect(result.success).toBe(true);
      expect(result.courier).toBe('Velocity');
      expect(result.waybillNumber).toBe('374713114560');

      expect(prismaStub.shipment.update).toHaveBeenCalledWith({
        where: { id: 501 },
        data: expect.objectContaining({
          courier: 'Velocity',
          waybillNumber: '374713114560',
          labelUrl: 'https://www.velocityshipping.in/track/374713114560',
          weightMismatch: false,
        }),
      });

      expect(prismaStub.order.update).toHaveBeenCalledWith({
        where: { id: 1950 },
        data: { supportFlag: null, hasUrgentSupport: false },
      });
    });
  });

  describe('orderService.dispatchOrder with Velocity override', () => {
    it('allows dispatching via Velocity when MANIFEST_REVIEW is flagged and clears the flag', async () => {
      const order = {
        id: 1950,
        shopifyOrderId: '6200000001950',
        shopifyOrderName: '#26YOU6128',
        shopifyOrderNumber: 6128,
        totalAmount: 814,
        paymentMethod: 'COD',
        status: 'NEW',
        tags: 'cod_confirmed',
        supportFlag: 'MANIFEST_REVIEW',
        hasUrgentSupport: true,
        fulfillmentStatus: null,
        shipment: null,
        items: [{ id: 1, title: 'Kurta', quantity: 1, price: 814 }],
      };

      prismaStub.order.findUnique.mockResolvedValueOnce(order);
      prismaStub.order.update.mockResolvedValueOnce({});
      prismaStub.order.updateMany.mockResolvedValue({ count: 1 });

      const dispatchSpy = vi.spyOn(orderService as any, 'dispatchClaimedOrder').mockResolvedValueOnce({
        waybillNumber: 'VEL-374713114560',
        courier: 'Velocity',
      });

      const result = await orderService.dispatchOrder(1950, undefined, 'Velocity');

      expect(result.waybillNumber).toBe('VEL-374713114560');
      expect(result.courier).toBe('Velocity');
      expect(prismaStub.order.update).toHaveBeenCalledWith({
        where: { id: 1950 },
        data: { supportFlag: null, hasUrgentSupport: false },
      });
    });

    it('rejects dispatching with Delhivery while MANIFEST_REVIEW is pending unless switched to Velocity', async () => {
      const order = {
        id: 1950,
        shopifyOrderId: '6200000001950',
        shopifyOrderName: '#26YOU6128',
        shopifyOrderNumber: 6128,
        totalAmount: 814,
        paymentMethod: 'COD',
        status: 'NEW',
        tags: 'cod_confirmed',
        supportFlag: 'MANIFEST_REVIEW',
        hasUrgentSupport: true,
        fulfillmentStatus: null,
        shipment: null,
        items: [{ id: 1, title: 'Kurta', quantity: 1, price: 814 }],
      };

      prismaStub.order.findUnique.mockResolvedValueOnce(order);

      await expect(orderService.dispatchOrder(1950, undefined, 'Delhivery')).rejects.toThrow(
        /Previous manifest requires review in Delhivery ONE/
      );
    });
  });
});
