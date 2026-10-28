import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isVelocityCourier, normalizeCourierName, normalizeLegacyShipmentCouriers } from '../src/utils/courier';
import { VelocityService } from '../src/modules/velocity/velocity.service';
import returnService from '../src/modules/returns/return.service';

const { prismaStub, delhiveryStub } = vi.hoisted(() => ({
  prismaStub: {
    order: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    shipment: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    return: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    syncLog: {
      create: vi.fn(),
    },
  },
  delhiveryStub: {
    createReturnShipment: vi.fn(),
    generateLabel: vi.fn(),
  },
}));

vi.mock('../src/database/prisma', () => ({ default: prismaStub }));
vi.mock('../src/modules/delhivery/delhivery.service', () => ({ default: delhiveryStub }));
vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Velocity Aggregator Branding, Returns & Store Linkup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Courier Normalization (Two Primary Logistics: Delhivery & Velocity)', () => {
    it('normalizes all Velocity variants and aggregator partners to Velocity', () => {
      // Velocity direct
      expect(normalizeCourierName('Velocity')).toBe('Velocity');
      expect(normalizeCourierName('velocity_surface')).toBe('Velocity');
      expect(normalizeCourierName('VELOCITY SHIPPING')).toBe('Velocity');

      // Amazon / ATS fulfilled through Velocity aggregator
      expect(normalizeCourierName('Amazon Transportation')).toBe('Velocity');
      expect(normalizeCourierName('Amazon Shipping')).toBe('Velocity');
      expect(normalizeCourierName('Amazon ATS')).toBe('Velocity');
      expect(normalizeCourierName('Velocity (Amazon Shipping)')).toBe('Velocity');
      expect(normalizeCourierName('Velocity (Ekart)')).toBe('Velocity');
      expect(normalizeCourierName('Velocity (Delhivery Standard)')).toBe('Velocity');

      // Amazon label URL via Velocity S3
      expect(
        normalizeCourierName(
          undefined,
          'https://velocity-shazam-prod.s3.ap-south-1.amazonaws.com/labels/amazon/374645218626.pdf'
        )
      ).toBe('Velocity');

      // Velocity native AWB prefixes
      expect(normalizeCourierName(null, null, 'PD123456789')).toBe('Velocity');
      expect(normalizeCourierName(null, null, 'VEHR998877')).toBe('Velocity');
      expect(normalizeCourierName(null, null, 'VEL776655')).toBe('Velocity');
    });

    it('normalizes Delhivery shipments to Delhivery', () => {
      expect(normalizeCourierName('Delhivery')).toBe('Delhivery');
      expect(normalizeCourierName('Delhivery Express')).toBe('Delhivery Express');
      expect(normalizeCourierName('Delhivery Surface')).toBe('Delhivery Surface');
      expect(
        normalizeCourierName(
          'Delhivery Surface',
          'https://delhivery-express.s3.amazonaws.com/packing_slips/30100810013731.pdf',
          '30100810013731'
        )
      ).toBe('Delhivery Surface');
    });

    it('normalizes legacy database records via normalizeLegacyShipmentCouriers', async () => {
      const mockPrisma: any = {
        shipment: { updateMany: vi.fn().mockResolvedValue({ count: 41 }) },
        trackingLog: { updateMany: vi.fn().mockResolvedValue({ count: 431 }) },
      };
      await normalizeLegacyShipmentCouriers(mockPrisma);
      expect(mockPrisma.shipment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { courier: 'Velocity' },
        })
      );
      expect(mockPrisma.trackingLog.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { location: 'Velocity Hub' },
        })
      );
    });

    it('frontend isVelocityCourier excludes Delhivery shipments even if waybill has VEL/PD prefix', async () => {
      const { isVelocityCourier: frontendIsVel } = await import('../frontend/src/lib');
      expect(frontendIsVel('Delhivery', 'VEL999')).toBe(false);
      expect(frontendIsVel('Delhivery Surface', 'PD12345')).toBe(false);
      expect(frontendIsVel('Delhivery', 'https://delhivery.com/label.pdf', 'VEL999')).toBe(false);
      expect(frontendIsVel('Velocity (Delhivery Standard)')).toBe(true);
      expect(frontendIsVel('Delhivery Standard', 'https://velocity-shazam-prod.s3.ap-south-1.amazonaws.com/labels/delhivery/123.pdf')).toBe(true);
      expect(frontendIsVel(null, 'VEL999')).toBe(true);
      expect(frontendIsVel('Velocity', 'VEL999')).toBe(true);
    });
  });

  describe('2. Velocity Store Search & Pre-Dispatch Linkup (youthnic2024)', () => {
    let velocityService: VelocityService;
    let mockAxios: any;

    beforeEach(() => {
      mockAxios = {
        get: vi.fn(),
        post: vi.fn(),
      };
      velocityService = new VelocityService();
      (velocityService as any).client = mockAxios;
    });

    it('finds existing manifested shipment under youthnic2024 via order details', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: {
          status: 'SUCCESS',
          payload: {
            order_id: '#26YOU6156',
            shipment_id: 'SHP-9988',
            awb_code: '374645218626',
            courier_name: 'Velocity Standard',
            label_url: 'https://labels.velocityshipping.in/374645218626.pdf',
          },
        },
      });

      const found = await velocityService.findExistingShipment('#26YOU6156', '26YOU6156');
      expect(found).not.toBeNull();
      expect(found?.awbCode).toBe('374645218626');
      expect(found?.courierName).toBe('Velocity');
      expect(found?.labelUrl).toBe('https://labels.velocityshipping.in/374645218626.pdf');
    });

    it('finds existing shipment under youthnic2024 via shipments list search when details 404', async () => {
      mockAxios.get.mockRejectedValue(new Error('Order not found'));
      mockAxios.post.mockResolvedValueOnce({
        data: {
          data: [
            {
              attributes: {
                id: 'SHP-7766',
                tracking_number: 'VEL554433',
                label_url: 'https://labels.velocityshipping.in/VEL554433.pdf',
                carrier: { name: 'Amazon' },
                order: {
                  display_id: '#26YOU6156',
                },
              },
            },
          ],
        },
      });

      const found = await velocityService.findExistingShipment('#26YOU6156', '26YOU6156');
      expect(found).not.toBeNull();
      expect(found?.awbCode).toBe('VEL554433');
      expect(found?.courierName).toBe('Velocity');
    });

    it('returns null gracefully if order is not yet manifested on Velocity', async () => {
      mockAxios.get.mockRejectedValue(new Error('Order not found'));
      mockAxios.post.mockResolvedValueOnce({ data: { data: [] } });

      const found = await velocityService.findExistingShipment('#26YOU9999', '26YOU9999');
      expect(found).toBeNull();
    });

    it('ignores terminal shipments (e.g. DELIVERED, CANCELLED, RTO) so dispatch can book an active forward shipment', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: {
          payload: {
            order_id: '#26YOU6156',
            awb_code: 'OLD-DELIVERED-AWB',
            status: 'DELIVERED',
          },
        },
      });
      mockAxios.post.mockResolvedValueOnce({
        data: {
          data: [
            {
              attributes: {
                order: { display_id: '#26YOU6156' },
                tracking_number: 'OLD-RTO-AWB',
                status: 'RTO_DELIVERED',
              },
            },
          ],
        },
      });

      const found = await velocityService.findExistingShipment('#26YOU6156', '26YOU6156');
      expect(found).toBeNull();
    });

    it('throws if order details returns 401 Unauthorized or 403 Forbidden', async () => {
      const err: any = new Error('Unauthorized');
      err.response = { status: 401 };
      mockAxios.get.mockRejectedValueOnce(err);

      await expect(velocityService.findExistingShipment('#26YOU6156', '26YOU6156')).rejects.toThrow(
        /temporarily unavailable/i
      );
    });

    it('throws if shipments list search returns 401 Unauthorized or 403 Forbidden', async () => {
      mockAxios.get.mockRejectedValueOnce(new Error('Order not found'));
      const err: any = new Error('Forbidden');
      err.response = { status: 403 };
      mockAxios.post.mockRejectedValueOnce(err);

      await expect(velocityService.findExistingShipment('#26YOU6156', '26YOU6156')).rejects.toThrow(
        /temporarily unavailable/i
      );
    });
  });

  describe('3. Velocity Return Creation Against Delivered Forward Orders', () => {
    let velocityService: VelocityService;
    let mockAxios: any;

    beforeEach(() => {
      mockAxios = {
        get: vi.fn(),
        post: vi.fn(),
      };
      velocityService = new VelocityService();
      (velocityService as any).client = mockAxios;
    });

    it('creates reverse shipment on Velocity with forward AWB, youthnic2024 store and items', async () => {
      mockAxios.post.mockResolvedValueOnce({
        data: {
          status: 1,
          payload: {
            awb_code: 'REV-VEL-8899',
            shipment_id: 'REV-SHP-1',
            label_url: 'https://labels.velocityshipping.in/REV-VEL-8899.pdf',
          },
        },
      });

      const res = await velocityService.createReverseShipment({
        orderId: '#26YOU6156',
        forwardAwb: '374645218626',
        returnReason: 'Size too small',
        storeName: 'youthnic2024',
        pickupCustomerName: 'Pawan',
        pickupLastName: 'Shukla',
        pickupAddress: 'Sector 5, Surat',
        pickupCity: 'Surat',
        pickupState: 'Gujarat',
        pickupPincode: '395007',
        pickupPhone: '9876543210',
        items: [
          {
            name: 'Youthnic Cotton Kurti - M',
            sku: 'YN-KURTI-M',
            units: 1,
            selling_price: 1499,
          },
        ],
        totalAmount: 1499,
      });

      expect(res.awbCode).toBe('REV-VEL-8899');
      expect(res.courierName).toBe('Velocity');
      expect(mockAxios.post).toHaveBeenCalledWith(
        '/custom/api/v1/reverse-order-orchestration',
        expect.objectContaining({
          order_id: '#26YOU6156',
          forward_awb: '374645218626',
          store_name: 'youthnic2024',
          pickup_customer_name: 'Pawan',
          pickup_pincode: '395007',
        })
      );
    });

    it('return.service routes delivered Velocity forward order to Velocity reverse orchestration', async () => {
      const mockOrder: any = {
        id: 991,
        shopifyOrderName: '#26YOU6156',
        status: 'DELIVERED',
        deliveredAt: new Date(),
        customerName: 'Pawan Shukla',
        customerPhone: '9876543210',
        customerAddress: 'Ring Road, Surat',
        customerCity: 'Surat',
        customerState: 'Gujarat',
        customerPincode: '395002',
        totalAmount: 1299,
        items: [
          {
            id: 101,
            title: 'Youthnic Kurti',
            sku: 'YN-01-M',
            quantity: 1,
            price: 1299,
          },
        ],
        returns: [],
        shipment: {
          courier: 'Velocity',
          waybillNumber: '374645218626',
          status: 'DELIVERED',
          trackingStatus: 'Delivered to recipient',
        },
      };

      prismaStub.order.findUnique.mockResolvedValueOnce(mockOrder);
      prismaStub.return.create.mockImplementationOnce(({ data }: any) => ({
        id: 55,
        ...data,
      }));

      // Mock VelocityService on velocity.service
      const velServiceModule = await import('../src/modules/velocity/velocity.service');
      const spyReverse = vi.spyOn(velServiceModule.default, 'createReverseShipment').mockResolvedValueOnce({
        awbCode: 'REV-VEL-777',
        shipmentId: 'SHP-R-77',
        courierName: 'Velocity',
        labelUrl: 'https://labels.velocityshipping.in/REV-VEL-777.pdf',
        raw: {},
      });

      const returnRes = await returnService.createReturn(
        991,
        'Fabric defective',
        [{ orderItemId: 101, quantity: 1 }],
        { triggerShopify: false }
      );

      expect(spyReverse).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: '#26YOU6156',
          forwardAwb: '374645218626',
          storeName: 'youthnic2024',
        })
      );

      expect(returnRes.returnWaybill).toBe('REV-VEL-777');
      expect(returnRes.pickupAutomatic).toBe(true);
      expect(prismaStub.return.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            carrier: 'Velocity',
            returnWaybillNumber: 'REV-VEL-777',
            pickupAutomatic: true,
          }),
        })
      );
    });

    it('identifies Velocity Reverse in return notifications for Velocity carrier', async () => {
      const { default: notificationEngine } = await import('../src/modules/notifications/notification.service');
      const { default: kwikengageService } = await import('../src/modules/whatsapp/kwikengage.service');
      const { default: resendService } = await import('../src/modules/email/resend.service');

      const spyKwik = vi.spyOn(kwikengageService, 'sendCriticalTrigger').mockResolvedValueOnce({} as any);
      const spyResend = vi.spyOn(resendService, 'sendEmail').mockResolvedValueOnce({} as any);

      const fakeOrder: any = {
        id: 1,
        shopifyOrderName: '#26YOU6156',
        customerName: 'Customer',
        customerEmail: 'cust@example.com',
      };
      const fakeReturn: any = {
        returnWaybillNumber: 'REV-VEL-777',
        returnReason: 'Wrong size',
        carrier: 'Velocity',
      };

      await notificationEngine.notifyReturnInitiated(fakeOrder, fakeReturn);

      expect(spyKwik).toHaveBeenCalledWith(
        'RETURN_INITIATED',
        fakeOrder,
        expect.objectContaining({
          courierName: 'Velocity Reverse',
          waybillNumber: 'REV-VEL-777',
        })
      );
      expect(spyResend).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            courier: 'Velocity Reverse',
          }),
        })
      );
    });

    it('rejects non-integer return quantity (e.g. 1.5)', async () => {
      prismaStub.order.findUnique.mockResolvedValueOnce({
        id: 99,
        shopifyOrderName: '#26YOU99',
        status: 'DELIVERED',
        returns: [],
        items: [{ id: 101, title: 'Kurti', quantity: 2 }],
        shipment: { waybillNumber: 'VEL12345', courier: 'Velocity' },
      });

      await expect(
        returnService.createReturn(99, 'Defective', [{ orderItemId: 101, quantity: 1.5 } as any])
      ).rejects.toThrow(/must be a whole number/i);
    });

    it('throws generic courier pickup error on locked return reason update', async () => {
      prismaStub.return.findUnique.mockResolvedValueOnce({
        id: 55,
        returnStatus: 'PICKED_UP',
        carrier: 'Velocity',
        order: { shopifyOrderId: '123' },
      });

      await expect(returnService.updateReturnReason(55, 'New Reason')).rejects.toThrow(
        'The reason can only be changed before the courier picks up the return.'
      );
    });
  });
});
