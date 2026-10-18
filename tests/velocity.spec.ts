/**
 * Unit and integration tests for Velocity Shipping partner integration,
 * priority routing engine, and webhook handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { isVelocityCourier, isDelhiveryCourier, normalizeCourierName } from '../src/utils/courier';
import { VelocityService, velocityService } from '../src/modules/velocity/velocity.service';
import delhiveryService from '../src/modules/delhivery/delhivery.service';
import { ShippingRouterService, SHIPPING_PRIORITY_SETTING_KEY } from '../src/modules/shipping/shipping-router.service';
import { handleVelocityWebhook } from '../src/routes/velocity-webhooks';
import { config } from '../src/config';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prismaStub } = vi.hoisted(() => ({
  prismaStub: {
    setting: {
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
      upsert: vi.fn(),
    },
    shipment: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    order: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    trackingLog: {
      create: vi.fn(),
    },
  },
}));
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));

const { trackingServiceStub } = vi.hoisted(() => ({
  trackingServiceStub: {
    handleStatusChange: vi.fn(),
  },
}));
vi.mock('../src/modules/tracking/tracking.service', () => ({ default: trackingServiceStub }));

vi.mock('../src/modules/accounts/account-trail.service', () => ({
  recordAccountTrailEvent: vi.fn(async () => undefined),
}));

describe('Velocity Shipping Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Courier Matching Utilities', () => {
    it('detects Velocity courier in various formats case-insensitively', () => {
      expect(isVelocityCourier('Velocity')).toBe(true);
      expect(isVelocityCourier('velocity')).toBe(true);
      expect(isVelocityCourier('Velocity Shipping')).toBe(true);
      expect(isVelocityCourier('velocity_surface')).toBe(true);
      expect(isVelocityCourier('VELOCITY EXPRESS')).toBe(true);
      expect(isVelocityCourier('Delhivery')).toBe(false);
      expect(isVelocityCourier('Blue Dart')).toBe(false);
      expect(isVelocityCourier(null)).toBe(false);
      expect(isVelocityCourier(undefined)).toBe(false);
    });

    it('normalizes Velocity courier name correctly', () => {
      expect(normalizeCourierName('velocity_air')).toBe('Velocity');
      expect(normalizeCourierName('VELOCITY SHIPPING')).toBe('Velocity');
      expect(normalizeCourierName('Delhivery Express')).toBe('Delhivery Express');
      expect(normalizeCourierName('Delhivery')).toBe('Delhivery');
      expect(normalizeCourierName('DTDC Express')).toBe('DTDC');
    });

    it('distinguishes Delhivery and Velocity correctly', () => {
      expect(isDelhiveryCourier('Delhivery Express')).toBe(true);
      expect(isDelhiveryCourier('Velocity Shipping')).toBe(false);
      expect(isVelocityCourier('Delhivery Express')).toBe(false);
      expect(isVelocityCourier('Velocity Shipping')).toBe(true);
    });
  });

  describe('VelocityService Client', () => {
    let service: VelocityService;
    let mockAxios: any;

    beforeEach(() => {
      mockAxios = {
        post: vi.fn(),
        get: vi.fn(),
      };
      service = new VelocityService();
      (service as any).client = mockAxios;
    });

    it('checks serviceability correctly', async () => {
      mockAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            serviceable: true,
            zone: 'West',
            couriers: [
              { carrier_id: 'c1', carrier_name: 'Delhivery Surface' },
              { carrier_id: 'c2', carrier_name: 'BlueDart Air' },
            ],
          },
        },
      });

      const result = await service.checkServiceability({
        fromPincode: '395002',
        toPincode: '400001',
        paymentMode: 'cod',
      });

      expect(mockAxios.post).toHaveBeenCalledWith(
        '/custom/api/v1/serviceability',
        expect.objectContaining({
          from: '395002',
          to: '400001',
          payment_mode: 'cod',
        })
      );
      expect(result.serviceable).toBe(true);
      expect(result.couriers.length).toBe(2);
      expect(result.zone).toBe('West');
    });

    it('creates forward shipment orchestration with correct weight in kg and payload format', async () => {
      mockAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            order_id: 'ORD-101',
            shipment_id: 'SH-555',
            awb_code: 'VEL123456789IN',
            courier_name: 'Velocity Express',
            label_url: 'https://shazam.velocity.in/labels/VEL123456789IN.pdf',
          },
        },
      });

      const mockOrder: any = {
        id: 101,
        shopifyOrderId: '1001',
        shopifyOrderName: '#1001',
        customerName: 'Rahul Sharma',
        customerPhone: '9876543210',
        customerEmail: 'rahul@example.com',
        customerAddress: 'Ring Road 123',
        customerCity: 'Mumbai',
        customerState: 'Maharashtra',
        customerCountry: 'India',
        customerPincode: '400001',
        paymentMethod: 'COD',
        totalAmount: 999,
        items: [
          {
            id: 1,
            title: 'Classic T-Shirt',
            sku: 'TSH-BLK-M',
            quantity: 1,
            price: 999,
          },
        ],
      };

      const result = await service.createForwardShipment(mockOrder, {
        weight: 0.5,
      });

      expect(mockAxios.post).toHaveBeenCalledWith(
        '/custom/api/v1/forward-order-orchestration',
        expect.objectContaining({
          order_id: '1001-101',
          payment_method: 'COD',
          sub_total: 999,
          shipping_pincode: '400001',
          weight: 0.5,
        })
      );
      expect(result.awbCode).toBe('VEL123456789IN');
      expect(result.labelUrl).toContain('VEL123456789IN.pdf');
    });

    it('tracks single shipment and parses activities', async () => {
      mockAxios.post.mockResolvedValueOnce({
        data: {
          data: [
            {
              awb: 'VEL123456789IN',
              shipment_status: 'Delivered',
              current_status: 'Delivered to recipient',
              activities: [
                { date: '2026-10-17 14:00', activity: 'Delivered', location: 'Mumbai' },
                { date: '2026-10-17 09:00', activity: 'Out for delivery', location: 'Mumbai' },
              ],
            },
          ],
        },
      });

      const tracking = await service.trackShipment('VEL123456789IN');
      expect(tracking.awb).toBe('VEL123456789IN');
      expect(tracking.shipmentStatus).toBe('Delivered');
      expect(tracking.activities.length).toBe(2);
      expect(service.mapTrackingToShipmentStatus('Delivered').shipmentStatus).toBe('DELIVERED');
      expect(service.mapTrackingToShipmentStatus('Out for delivery').shipmentStatus).toBe('OUT_FOR_DELIVERY');
      expect(service.mapTrackingToShipmentStatus('In Transit').shipmentStatus).toBe('IN_TRANSIT');
      expect(service.mapTrackingToShipmentStatus('RTO Delivered').shipmentStatus).toBe('RTO_DELIVERED');
    });

    it('cancels shipment successfully', async () => {
      mockAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            awb: 'VEL123456789IN',
            status: 'CANCELLED',
          },
        },
      });

      const res = await service.cancelShipment('VEL123456789IN', 'Customer requested');
      expect(res.cancelled).toBe(true);
      expect(mockAxios.post).toHaveBeenCalledWith('/custom/api/v1/cancel-order', {
        awbs: ['VEL123456789IN'],
      });
    });

    it('verifies HMAC-SHA256 webhook signatures accurately', () => {
      const secret = 'super-secret-webhook-key';
      const payload = JSON.stringify({
        event: 'status_change',
        data: { awb: 'VEL999', shipment_status: 'Delivered' },
      });

      const validSignature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const invalidSignature = 'invalid-signature-hex-12345';

      expect(service.verifyWebhookSignature(payload, validSignature, secret)).toBe(true);
      expect(service.verifyWebhookSignature(payload, invalidSignature, secret)).toBe(false);
      expect(service.verifyWebhookSignature(payload, undefined as any, secret)).toBe(false);
    });

    it('submits NDR re-attempt action successfully', async () => {
      mockAxios.post.mockResolvedValueOnce({
        data: { status: 'SUCCESS', message: 'Reattempt scheduled' },
      });

      const res = await service.submitNdrAction({
        awb: 'VEL123456789IN',
        action: 'reattempt',
        remarks: 'Customer requested evening delivery',
      });

      expect(res.success).toBe(true);
      expect(mockAxios.post).toHaveBeenCalledWith('/custom/api/v1/ndr-action', expect.objectContaining({
        awb: 'VEL123456789IN',
        action: 'REATTEMPT',
      }));
    });

    it('submits order update request successfully', async () => {
      mockAxios.post.mockResolvedValueOnce({
        data: { status: 'SUCCESS', message: 'Address updated' },
      });

      const res = await service.updateOrder({
        awb: 'VEL123456789IN',
        address: 'New Flat 102, Star Residency',
        city: 'Mumbai',
        pincode: '400050',
      });

      expect(res.success).toBe(true);
      expect(mockAxios.post).toHaveBeenCalledWith('/custom/api/v1/update-order', expect.objectContaining({
        awb: 'VEL123456789IN',
        shipping_address: 'New Flat 102, Star Residency',
      }));
    });

    it('lists warehouses and stores', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: { status: 'SUCCESS', payload: { warehouses: [{ id: 'wh-1', name: 'Surat Center' }] } },
      });
      const whList = await service.listWarehouses();
      expect(whList).toHaveLength(1);
      expect(whList[0].name).toBe('Surat Center');

      mockAxios.get.mockResolvedValueOnce({
        data: { status: 'SUCCESS', payload: { stores: [{ id: 'st-1', name: 'Youthnic Main' }] } },
      });
      const stList = await service.listStores();
      expect(stList).toHaveLength(1);
      expect(stList[0].name).toBe('Youthnic Main');
    });

    it('pings serviceability to check live connection', async () => {
      mockAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            serviceable: true,
            couriers: [{ carrier_id: 'c1' }],
          },
        },
      });

      const pingRes = await service.ping();
      expect(pingRes.ok).toBe(true);
      expect(pingRes.message).toContain('Connected');
    });
  });

  describe('ShippingRouterService Priority & Fallback', () => {
    let routerService: ShippingRouterService;
    let mockDelhivery: any;
    let mockVelocity: any;

    beforeEach(() => {
      routerService = new ShippingRouterService();

      mockDelhivery = {
        checkPincodeServiceability: vi.fn(),
      };
      mockVelocity = {
        checkServiceability: vi.fn(),
      };

      (routerService as any).getCarrierPriority = vi.fn();
    });

    it('respects explicit operator courier selection', async () => {
      const mockOrder: any = { customerPincode: '400001', paymentMethod: 'Prepaid' };

      const resDel = await routerService.resolveCarrierForOrder(mockOrder, 'Delhivery');
      expect(resDel.courier).toBe('Delhivery');
      expect(resDel.reason).toContain('Explicit operator selection: Delhivery');

      const resVel = await routerService.resolveCarrierForOrder(mockOrder, 'Velocity');
      expect(resVel.courier).toBe('Velocity');
      expect(resVel.reason).toContain('Explicit operator selection: Velocity');
    });

    it('reads priority from database setting', async () => {
      prismaStub.setting.findUnique.mockResolvedValueOnce({
        key: SHIPPING_PRIORITY_SETTING_KEY,
        value: 'VELOCITY_FIRST',
      });

      const realRouter = new ShippingRouterService();
      const priority = await realRouter.getCarrierPriority();
      expect(priority).toBe('VELOCITY_FIRST');
    });

    it('saves priority into database setting', async () => {
      prismaStub.setting.upsert.mockResolvedValueOnce({
        key: SHIPPING_PRIORITY_SETTING_KEY,
        value: 'VELOCITY_FIRST',
      });

      const realRouter = new ShippingRouterService();
      await realRouter.setCarrierPriority('VELOCITY_FIRST');
      expect(prismaStub.setting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key: SHIPPING_PRIORITY_SETTING_KEY },
          update: { value: 'VELOCITY_FIRST' },
        })
      );
    });

    it('routes to Velocity fallback when DELHIVERY_FIRST and Delhivery is unserviceable', async () => {
      const origDelToken = config.delhivery.apiToken;
      const origVelToken = config.velocity.apiToken;
      config.delhivery.apiToken = 'del-token';
      config.velocity.apiToken = 'vel-token';

      try {
        const router = new ShippingRouterService();
        (router as any).getCarrierPriority = vi.fn().mockResolvedValue('DELHIVERY_FIRST');

        vi.spyOn(delhiveryService, 'checkPincodeServiceability').mockResolvedValueOnce({
          serviceable: false,
          codAvailable: false,
          prepaidAvailable: false,
          remark: 'PINCODE_NOT_SERVICED',
        } as any);

        vi.spyOn(velocityService, 'checkServiceability').mockResolvedValueOnce({
          serviceable: true,
          couriers: [{ carrier_id: 'c1', carrier_name: 'BlueDart' }],
        } as any);

        const mockOrder: any = { customerPincode: '799001', paymentMethod: 'Prepaid' };
        const resolution = await router.resolveCarrierForOrder(mockOrder, 'auto');

        expect(resolution.courier).toBe('Velocity');
        expect(resolution.reason).toContain('Velocity fallback');
      } finally {
        config.delhivery.apiToken = origDelToken;
        config.velocity.apiToken = origVelToken;
      }
    });

    it('routes to Delhivery fallback when VELOCITY_FIRST and Velocity is unserviceable', async () => {
      const origDelToken = config.delhivery.apiToken;
      const origVelToken = config.velocity.apiToken;
      config.delhivery.apiToken = 'del-token';
      config.velocity.apiToken = 'vel-token';

      try {
        const router = new ShippingRouterService();
        (router as any).getCarrierPriority = vi.fn().mockResolvedValue('VELOCITY_FIRST');

        vi.spyOn(velocityService, 'checkServiceability').mockResolvedValueOnce({
          serviceable: false,
          couriers: [],
          remark: 'No couriers available',
        } as any);

        const mockOrder: any = { customerPincode: '799001', paymentMethod: 'COD' };
        const resolution = await router.resolveCarrierForOrder(mockOrder, 'auto');

        expect(resolution.courier).toBe('Delhivery');
        expect(resolution.reason).toContain('fallback to Delhivery');
      } finally {
        config.delhivery.apiToken = origDelToken;
        config.velocity.apiToken = origVelToken;
      }
    });
  });

  describe('Velocity Webhook Handler', () => {
    it('returns 200 when webhook has no tracking_number to avoid disablement', async () => {
      const req: any = {
        body: { event: 'status_change', data: {} },
        headers: {},
      };
      const res: any = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };

      await handleVelocityWebhook(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Ignored') }));
    });

    it('rejects invalid HMAC signature with 401', async () => {
      const originalSecret = config.velocity.webhookSecret;
      config.velocity.webhookSecret = 'test-secret';
      try {
        const req: any = {
          body: {
            event: 'status_change',
            data: { tracking_number: 'VEL123', status: 'Delivered' },
          },
          headers: {
            'x-velocity-signature': 'invalid-signature-1234',
          },
        };
        const res: any = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn(),
        };

        await handleVelocityWebhook(req, res);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Invalid webhook signature' }));
      } finally {
        config.velocity.webhookSecret = originalSecret;
      }
    });

    it('authenticates webhook via X-API-Key header matching velocity apiToken or webhookSecret', async () => {
      const origSecret = config.velocity.webhookSecret;
      const origToken = config.velocity.apiToken;
      config.velocity.webhookSecret = 'test-wh-secret';
      config.velocity.apiToken = 'test-api-token';

      try {
        const req: any = {
          body: {
            event: 'status_change',
            data: {},
          },
          headers: {
            'x-api-key': 'test-wh-secret',
          },
        };
        const res: any = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn(),
        };

        await handleVelocityWebhook(req, res);
        expect(res.status).toHaveBeenCalledWith(200);

        // Also test invalid API key
        const badReq: any = {
          body: { event: 'status_change', data: {} },
          headers: { 'x-api-key': 'wrong-key' },
        };
        const badRes: any = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn(),
        };
        await handleVelocityWebhook(badReq, badRes);
        expect(badRes.status).toHaveBeenCalledWith(401);
      } finally {
        config.velocity.webhookSecret = origSecret;
        config.velocity.apiToken = origToken;
      }
    });

    it('updates shipment when matching tracking number is received', async () => {
      prismaStub.shipment.findFirst.mockResolvedValueOnce({
        id: 77,
        waybillNumber: 'VEL123456789IN',
        status: 'IN_TRANSIT',
        orderId: 101,
        order: { id: 101, status: 'IN_TRANSIT', items: [] },
      });
      prismaStub.shipment.update.mockResolvedValueOnce({ id: 77 });
      prismaStub.trackingLog.create.mockResolvedValueOnce({ id: 1 });

      const req: any = {
        body: {
          event: 'status_change',
          event_id: 'evt-1',
          data: {
            tracking_number: 'VEL123456789IN',
            status: 'Delivered',
            carrier_name: 'Velocity',
          },
        },
        headers: {},
      };
      const res: any = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };

      await handleVelocityWebhook(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(prismaStub.shipment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 77 },
        })
      );
      expect(trackingServiceStub.handleStatusChange).toHaveBeenCalledWith(
        expect.anything(),
        'IN_TRANSIT',
        'DELIVERED',
        expect.any(String),
        'Velocity'
      );
    });
  });
});
