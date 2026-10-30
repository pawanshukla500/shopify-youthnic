import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleVelocityWebhook } from '../src/routes/velocity-webhooks';
import returnService from '../src/modules/returns/return.service';
import velocityService from '../src/modules/velocity/velocity.service';
import shopifyService from '../src/modules/shopify/shopify.service';

const { prismaStub, delhiveryStub, notificationStub } = vi.hoisted(() => ({
  prismaStub: {
    order: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    shipment: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    return: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    returnItem: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    trackingLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    syncLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    accountTrailEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
  delhiveryStub: {
    createReturnShipment: vi.fn(),
    generateLabel: vi.fn(),
  },
  notificationStub: {
    notifyReturnInitiated: vi.fn().mockResolvedValue(true),
    notifyRefundProcessed: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../src/database/prisma', () => ({ default: prismaStub }));
vi.mock('../src/modules/delhivery/delhivery.service', () => ({ default: delhiveryStub }));
vi.mock('../src/modules/notifications/notification.service', () => ({ default: notificationStub }));
vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Exchange Orders API & Workflow (/agency-api-tester)', () => {
  const mockOrder = {
    id: 99101,
    shopifyOrderId: 'gid://shopify/Order/99101',
    shopifyOrderName: '#26YOU99101',
    shopifyOrderNumber: 99101,
    customerName: 'Aarav Mehta',
    customerEmail: 'aarav@example.com',
    customerPhone: '9876543210',
    customerAddress: '42 MG Road, Bandra West',
    customerCity: 'Mumbai',
    customerState: 'Maharashtra',
    customerPincode: '400050',
    customerCountry: 'India',
    totalAmount: 799,
    status: 'DELIVERED',
    deliveredAt: new Date(),
    paymentMethod: 'PREPAID',
    items: [
      {
        id: 101,
        orderId: 99101,
        title: 'Floral Print Anarkali Kurta - M',
        sku: 'KURTA-ANARKALI-M',
        shopifyVariantId: 'gid://shopify/ProductVariant/5001',
        variantTitle: 'M',
        quantity: 1,
        price: 799,
        returnable: true,
      },
    ],
    shipment: {
      id: 201,
      orderId: 99101,
      waybillNumber: 'VEL-FWD-99101',
      courier: 'Velocity',
      status: 'DELIVERED',
    },
    returns: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Input Validation & Error Handling', () => {
    it('throws error when order is not delivered', async () => {
      prismaStub.order.findUnique.mockResolvedValueOnce({
        ...mockOrder,
        status: 'IN_TRANSIT',
        deliveredAt: null,
        shipment: { ...mockOrder.shipment, status: 'IN_TRANSIT', trackingStatus: 'In Transit' },
      });

      await expect(
        returnService.createExchange(99101, {
          returnOrderItemId: 101,
          returnQuantity: 1,
          returnReason: 'Size too small',
          exchangeVariantId: '5002',
          exchangeTitle: 'L',
        })
      ).rejects.toThrow('Exchange request becomes available after the forward shipment is delivered');
    });

    it('throws error when order already has an active return or exchange', async () => {
      prismaStub.order.findUnique.mockResolvedValueOnce({
        ...mockOrder,
        returns: [
          {
            id: 88,
            returnStatus: 'PICKUP_SCHEDULED',
            returnWaybillNumber: 'REV-ACTIVE-1',
          },
        ],
      });

      await expect(
        returnService.createExchange(99101, {
          returnOrderItemId: 101,
          returnQuantity: 1,
          returnReason: 'Size too small',
          exchangeVariantId: '5002',
          exchangeTitle: 'L',
        })
      ).rejects.toThrow('already has an active return or exchange');
    });

    it('throws error when selected item does not belong to order', async () => {
      prismaStub.order.findUnique.mockResolvedValueOnce(mockOrder);

      await expect(
        returnService.createExchange(99101, {
          returnOrderItemId: 99999, // non-existent item ID
          returnQuantity: 1,
          returnReason: 'Size too small',
          exchangeVariantId: '5002',
          exchangeTitle: 'L',
        })
      ).rejects.toThrow('The selected item to return was not found in this order');
    });
  });

  describe('2. Size Exchange Creation (Immediate Dispatch)', () => {
    it('orchestrates reverse pickup and forward replacement with Velocity and syncs to Shopify', async () => {
      prismaStub.order.findUnique.mockResolvedValueOnce(mockOrder);

      // Mock Velocity Reverse Pickup
      vi.spyOn(velocityService, 'createReverseShipment').mockResolvedValueOnce({
        awbCode: 'VEL-REV-334455',
        shipmentId: 'SHI-REV-1',
        courierName: 'Velocity',
        labelUrl: 'https://cdn.velocity.in/labels/rev-334455.pdf',
        raw: {},
      });

      // Mock Velocity Forward Replacement Shipment
      vi.spyOn(velocityService, 'createExchangeForwardShipment').mockResolvedValueOnce({
        orderId: '26YOU99101-EX-FWD',
        shipmentId: 'SHI-FWD-2',
        awbCode: 'VEL-FWD-778899',
        courierName: 'Velocity',
        labelUrl: 'https://cdn.velocity.in/labels/fwd-778899.pdf',
      });

      // Mock Shopify Exchange Registration
      vi.spyOn(shopifyService, 'registerExchangeOnShopify').mockResolvedValueOnce({
        success: true,
        shopifyReturnId: 'gid://shopify/Return/7711',
        tagsAdded: ['Exchange-Initiated', 'Exchange-Size:L'],
        fulfillmentId: 'gid://shopify/Fulfillment/9922',
      });

      // Mock Prisma return creation and order update
      prismaStub.return.create.mockResolvedValueOnce({
        id: 501,
        orderId: 99101,
        isExchange: true,
        returnWaybillNumber: 'VEL-REV-334455',
        exchangeForwardAwb: 'VEL-FWD-778899',
        exchangeTitle: 'L',
        carrier: 'Velocity',
        exchangeDispatchMode: 'IMMEDIATE',
      });
      prismaStub.order.update.mockResolvedValueOnce({});

      const result = await returnService.createExchange(99101, {
        returnOrderItemId: 101,
        returnQuantity: 1,
        returnReason: 'Size too small',
        exchangeVariantId: '5002',
        exchangeSku: 'KURTA-ANARKALI-L',
        exchangeTitle: 'L',
        dispatchMode: 'IMMEDIATE',
        carrier: 'Velocity',
      });

      expect(result.returnId).toBe(501);
      expect(result.returnWaybill).toBe('VEL-REV-334455');
      expect(result.exchangeForwardAwb).toBe('VEL-FWD-778899');
      expect(result.carrier).toBe('Velocity');
      expect(result.shopifyTriggered).toBe(true);

      // Verify Velocity reverse payload passed customer address & Surat warehouse
      expect(velocityService.createReverseShipment).toHaveBeenCalledWith(
        expect.objectContaining({
          pickupCustomerName: 'Aarav',
          pickupCity: 'Mumbai',
          storeName: 'youthnic2024',
          totalAmount: 799,
        })
      );

      // Verify Velocity forward replacement shipment passed correct replacement SKU & size
      expect(velocityService.createExchangeForwardShipment).toHaveBeenCalledWith(
        expect.objectContaining({
          exchangeItem: expect.objectContaining({
            sku: 'KURTA-ANARKALI-L',
            name: 'Floral Print Anarkali Kurta - M (L)',
          }),
        })
      );

      // Verify Shopify received exchangeLineItems
      expect(shopifyService.registerExchangeOnShopify).toHaveBeenCalledWith(
        'gid://shopify/Order/99101',
        expect.objectContaining({
          exchangeItems: [{ variantId: '5002', quantity: 1 }],
          exchangeTitle: 'L',
          forwardTrackingNumber: 'VEL-FWD-778899',
        })
      );

      // Verify Order status moved to EXCHANGE_REQUESTED
      expect(prismaStub.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'EXCHANGE_REQUESTED' },
        })
      );
    });
  });

  describe('3. Size Exchange Creation (On-Pickup Dispatch)', () => {
    it('schedules reverse pickup and leaves forward shipment pending until pickup scan', async () => {
      prismaStub.order.findUnique.mockResolvedValueOnce(mockOrder);

      // Mock Velocity Reverse Pickup
      vi.spyOn(velocityService, 'createReverseShipment').mockResolvedValueOnce({
        awbCode: 'VEL-REV-990011',
        shipmentId: 'SHI-REV-2',
        courierName: 'Velocity',
        labelUrl: 'https://cdn.velocity.in/labels/rev-990011.pdf',
        raw: {},
      });

      const forwardSpy = vi.spyOn(velocityService, 'createExchangeForwardShipment');

      // Mock Shopify Exchange Registration
      vi.spyOn(shopifyService, 'registerExchangeOnShopify').mockResolvedValueOnce({
        success: true,
        shopifyReturnId: 'gid://shopify/Return/7712',
        tagsAdded: ['Exchange-Initiated'],
      });

      prismaStub.return.create.mockResolvedValueOnce({
        id: 502,
        orderId: 99101,
        isExchange: true,
        returnWaybillNumber: 'VEL-REV-990011',
        exchangeForwardAwb: null,
        exchangeForwardStatus: 'PENDING',
        exchangeDispatchMode: 'ON_PICKUP',
        carrier: 'Velocity',
      });
      prismaStub.order.update.mockResolvedValueOnce({});

      const result = await returnService.createExchange(99101, {
        returnOrderItemId: 101,
        returnQuantity: 1,
        returnReason: 'Size mismatch',
        exchangeVariantId: '5002',
        exchangeSku: 'KURTA-ANARKALI-L',
        exchangeTitle: 'L',
        dispatchMode: 'ON_PICKUP',
        carrier: 'Velocity',
      });

      expect(result.returnId).toBe(502);
      expect(result.returnWaybill).toBe('VEL-REV-990011');
      expect(result.exchangeForwardAwb).toBeUndefined();
      expect(result.dispatchMode).toBe('ON_PICKUP');

      // Forward shipment must NOT be called yet in ON_PICKUP mode
      expect(forwardSpy).not.toHaveBeenCalled();
    });
  });

  describe('4. Velocity Webhook Auto-Dispatch for ON_PICKUP Exchanges', () => {
    it('auto-dispatches replacement forward parcel when reverse pickup is scanned in-transit', async () => {
      const mockReturnRecord = {
        id: 602,
        orderId: 99101,
        isExchange: true,
        exchangeDispatchMode: 'ON_PICKUP',
        exchangeForwardStatus: 'PENDING',
        returnWaybillNumber: 'REV-ON-PICKUP-1',
        exchangeTitle: 'XL',
        exchangeSku: 'KURTA-ANARKALI-XL',
        order: mockOrder,
      };

      prismaStub.shipment.findFirst.mockResolvedValueOnce(null);
      prismaStub.return.findFirst.mockResolvedValueOnce(mockReturnRecord);
      prismaStub.return.update.mockResolvedValue({});

      vi.spyOn(velocityService, 'mapTrackingToShipmentStatus').mockReturnValueOnce({
        shipmentStatus: 'IN_TRANSIT',
        description: 'In Transit',
      });

      const forwardSpy = vi.spyOn(velocityService, 'createExchangeForwardShipment').mockResolvedValueOnce({
        orderId: '26YOU99101-EX-FWD',
        shipmentId: 'SHI-FWD-AUTO',
        awbCode: 'VEL-FWD-AUTO-99',
        courierName: 'Velocity',
        labelUrl: 'https://cdn.velocity.in/labels/fwd-auto.pdf',
      });

      const fulfillSpy = vi.spyOn(shopifyService, 'fulfillOrderOnShopify').mockResolvedValueOnce({
        success: true,
        fulfillmentId: '123',
      });

      const req: any = {
        body: {
          event: 'shipment_status_changed',
          data: {
            tracking_number: 'REV-ON-PICKUP-1',
            status: 'in_transit',
            location: 'Velocity Mumbai Hub',
          },
        },
        headers: {},
      };

      let jsonRes: any = null;
      let statusCode = 0;
      const res: any = {
        status: (code: number) => {
          statusCode = code;
          return {
            json: (data: any) => { jsonRes = data; },
          };
        },
      };

      await handleVelocityWebhook(req, res);

      expect(statusCode).toBe(200);
      expect(jsonRes.success).toBe(true);
      expect(forwardSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          exchangeItem: expect.objectContaining({
            sku: 'KURTA-ANARKALI-XL',
            name: 'XL',
          }),
        })
      );
      expect(fulfillSpy).toHaveBeenCalledWith(
        'gid://shopify/Order/99101',
        'VEL-FWD-AUTO-99',
        'Velocity'
      );
      expect(prismaStub.return.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 602 },
          data: expect.objectContaining({
            returnStatus: 'IN_TRANSIT',
            order: { update: { status: 'RETURN_DISPATCHED' } },
          }),
        })
      );
    });

    it('advances parent order to RETURN_RECEIVED when reverse package arrives at warehouse', async () => {
      const mockReturnRecord = {
        id: 603,
        orderId: 99101,
        isExchange: false,
        returnStatus: 'IN_TRANSIT',
        returnWaybillNumber: 'REV-DELIVERY-1',
        order: { ...mockOrder, status: 'RETURN_DISPATCHED' },
      };

      prismaStub.shipment.findFirst.mockResolvedValueOnce(null);
      prismaStub.return.findFirst.mockResolvedValueOnce(mockReturnRecord);
      prismaStub.return.update.mockResolvedValue({});

      vi.spyOn(velocityService, 'mapTrackingToShipmentStatus').mockReturnValueOnce({
        shipmentStatus: 'DELIVERED',
        description: 'Delivered to warehouse',
      });

      const req: any = {
        body: {
          event: 'shipment_status_changed',
          data: {
            tracking_number: 'REV-DELIVERY-1',
            status: 'delivered',
            location: 'Warehouse Hub',
          },
        },
        headers: {},
      };

      let jsonRes: any = null;
      let statusCode = 0;
      const res: any = {
        status: (code: number) => {
          statusCode = code;
          return {
            json: (data: any) => { jsonRes = data; },
          };
        },
      };

      await handleVelocityWebhook(req, res);

      expect(statusCode).toBe(200);
      expect(jsonRes.success).toBe(true);
      expect(prismaStub.return.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 603 },
          data: expect.objectContaining({
            returnStatus: 'RECEIVED',
            order: { update: { status: 'RETURN_RECEIVED' } },
          }),
        })
      );
    });

    it('ignores delayed IN_TRANSIT scan if return is already CANCELLED (CodeAnt regression check)', async () => {
      const mockReturnRecord = {
        id: 605,
        orderId: 99101,
        isExchange: false,
        returnStatus: 'CANCELLED',
        returnWaybillNumber: 'REV-LATE-1',
        order: { ...mockOrder, status: 'DELIVERED' },
      };

      prismaStub.shipment.findFirst.mockResolvedValueOnce(null);
      prismaStub.return.findFirst.mockResolvedValueOnce(mockReturnRecord);
      prismaStub.return.update.mockResolvedValue({});

      vi.spyOn(velocityService, 'mapTrackingToShipmentStatus').mockReturnValueOnce({
        shipmentStatus: 'IN_TRANSIT',
        description: 'Late In Transit scan',
      });

      const req: any = {
        body: {
          event: 'shipment_status_changed',
          data: {
            tracking_number: 'REV-LATE-1',
            status: 'in_transit',
          },
        },
        headers: {},
      };

      const res: any = {
        status: (_code: number) => ({ json: (_d: any) => {} }),
      };

      await handleVelocityWebhook(req, res);

      // Verify returnStatus remains CANCELLED and order status is NOT touched
      expect(prismaStub.return.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 605 },
          data: expect.objectContaining({
            returnStatus: 'CANCELLED',
          }),
        })
      );
      const updateCalls = prismaStub.return.update.mock.calls;
      const lastCall = updateCalls[updateCalls.length - 1][0];
      expect(lastCall.data.order).toBeUndefined();
    });

    it('rolls back parent order to DELIVERED when reverse pickup is cancelled without replacement', async () => {
      const mockReturnRecord = {
        id: 604,
        orderId: 99101,
        isExchange: false,
        returnStatus: 'PICKUP_SCHEDULED',
        returnWaybillNumber: 'REV-CANCEL-1',
        order: { ...mockOrder, status: 'RETURN_REQUESTED' },
      };

      prismaStub.shipment.findFirst.mockResolvedValueOnce(null);
      prismaStub.return.findFirst.mockResolvedValueOnce(mockReturnRecord);
      prismaStub.return.update.mockResolvedValue({});

      vi.spyOn(velocityService, 'mapTrackingToShipmentStatus').mockReturnValueOnce({
        shipmentStatus: 'CANCELLED',
        description: 'Pickup cancelled by customer',
      });

      const req: any = {
        body: {
          event: 'shipment_status_changed',
          data: {
            tracking_number: 'REV-CANCEL-1',
            status: 'cancelled',
          },
        },
        headers: {},
      };

      let statusCode = 0;
      const res: any = {
        status: (code: number) => {
          statusCode = code;
          return {
            json: (_data: any) => {},
          };
        },
      };

      await handleVelocityWebhook(req, res);

      expect(statusCode).toBe(200);
      expect(prismaStub.return.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 604 },
          data: expect.objectContaining({
            returnStatus: 'CANCELLED',
            order: { update: { status: 'DELIVERED' } },
          }),
        })
      );
    });
  });
  describe('5. Exchange Forward Order Creation & Prepaid Received Return Refund (/agency-senior-developer)', () => {
    it('creates companion forward replacement order with revised size and status DISPATCHED', async () => {
      prismaStub.order.findUnique.mockResolvedValueOnce(mockOrder);
      prismaStub.order.findFirst.mockResolvedValueOnce(null); // not exists yet
      prismaStub.shipment.findUnique.mockResolvedValueOnce(null);

      vi.spyOn(velocityService, 'createReverseShipment').mockResolvedValueOnce({
        awbCode: 'VEL-REV-99101',
        shipmentId: 'SHI-REV-99',
        courierName: 'Velocity',
        raw: {},
      });

      vi.spyOn(velocityService, 'createExchangeForwardShipment').mockResolvedValueOnce({
        orderId: '26YOU99101-EX-FWD',
        shipmentId: 'SHI-FWD-99',
        awbCode: 'VEL-FWD-889900',
        courierName: 'Velocity',
        labelUrl: 'https://cdn.velocity.in/labels/fwd-889900.pdf',
      });

      vi.spyOn(shopifyService, 'registerExchangeOnShopify').mockResolvedValueOnce({
        success: true,
        shopifyReturnId: 'gid://shopify/Return/9900',
      });

      prismaStub.return.create.mockResolvedValueOnce({
        id: 701,
        orderId: 99101,
        isExchange: true,
        exchangeForwardAwb: 'VEL-FWD-889900',
        exchangeTitle: 'XL',
        carrier: 'Velocity',
      });
      prismaStub.order.update.mockResolvedValueOnce({});

      const createdExchangeOrder = {
        id: 99102,
        shopifyOrderId: 'EX-FWD-gid://shopify/Order/99101',
        shopifyOrderName: '26YOU99101-EX-FWD',
        status: 'DISPATCHED',
      };
      prismaStub.order.create.mockResolvedValueOnce(createdExchangeOrder);

      const res = await returnService.createExchange(99101, {
        returnOrderItemId: 101,
        returnQuantity: 1,
        returnReason: 'Size exchange to XL',
        exchangeVariantId: '5003',
        exchangeSku: 'KURTA-ANARKALI-XL',
        exchangeTitle: 'XL',
        dispatchMode: 'IMMEDIATE',
        carrier: 'Velocity',
      });

      expect(res.returnId).toBe(701);
      expect(res.exchangeForwardAwb).toBe('VEL-FWD-889900');
      expect(res.exchangeForwardOrderId).toBe(99102);
      expect(res.exchangeForwardOrderName).toBe('26YOU99101-EX-FWD');

      expect(prismaStub.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            shopifyOrderName: '26YOU99101-EX-FWD',
            paymentMethod: 'EXCHANGE',
            status: 'DISPATCHED',
            items: expect.objectContaining({
              create: expect.arrayContaining([
                expect.objectContaining({
                  variantTitle: 'XL',
                  sku: 'KURTA-ANARKALI-XL',
                  price: 0,
                }),
              ]),
            }),
          }),
        })
      );
    });

    it('approves QC and processes refund when approveQc: true is passed for received prepaid return', async () => {
      const mockPrepaidReturn = {
        id: 601,
        orderId: 99101,
        isExchange: false,
        returnStatus: 'QC_PENDING',
        returnWaybillNumber: '30100810012681',
        trackingStatus: 'DTO',
        qcStatus: null,
        refundStatus: 'NONE',
        order: {
          ...mockOrder,
          id: 99101,
          shopifyOrderName: '#26YOU5892',
          paymentMethod: 'Prepaid',
          financialStatus: 'paid',
          status: 'DELIVERED',
        },
        items: [
          {
            id: 11,
            returnId: 601,
            orderItemId: 101,
            quantity: 1,
            orderItem: mockOrder.items[0],
          },
        ],
      };

      prismaStub.return.findUnique.mockResolvedValueOnce(mockPrepaidReturn);
      prismaStub.return.update.mockResolvedValueOnce({ ...mockPrepaidReturn, qcStatus: 'APPROVED' });
      prismaStub.return.updateMany.mockResolvedValueOnce({ count: 1 }); // claim refund

      vi.spyOn(shopifyService, 'fetchOrder').mockResolvedValueOnce({
        id: 99101,
        line_items: [{ id: 501, sku: 'KURTA-ANARKALI-M', quantity: 1, price: '799.00' }],
      } as any);

      vi.spyOn(shopifyService, 'createRefund').mockResolvedValueOnce({
        refundId: 'gid://shopify/Refund/88991',
        success: true,
        amount: 799,
        moneyMoved: true,
        alreadyRefunded: false,
      });

      const refundResult = await returnService.processRefund(601, false, null, true);

      expect(refundResult.success).toBe(true);
      expect(refundResult.refundAmount).toBe(799);
      expect(refundResult.shopifyRefundId).toBe('gid://shopify/Refund/88991');

      // Verify QC was approved automatically
      expect(prismaStub.return.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 601 },
          data: expect.objectContaining({
            qcStatus: 'APPROVED',
            returnStatus: 'RECEIVED',
          }),
        })
      );
    });

    it('rejects approveQc if return package has not yet arrived at warehouse', async () => {
      const mockNotReceivedReturn = {
        id: 605,
        orderId: 99101,
        isExchange: false,
        returnStatus: 'PICKUP_SCHEDULED',
        returnWaybillNumber: '30100810014232',
        trackingStatus: 'Scheduled',
        qcStatus: null,
        refundStatus: 'NONE',
        receivedAt: null,
        order: {
          ...mockOrder,
          shopifyOrderName: '#26YOU6052',
          paymentMethod: 'Prepaid',
          financialStatus: 'paid',
        },
        items: [],
      };

      prismaStub.return.findUnique.mockResolvedValueOnce(mockNotReceivedReturn);
      const res = await returnService.processRefund(605, false, null, true);

      expect(res.success).toBe(false);
      expect(res.error).toContain('because the package has not yet been received at the warehouse');
    });

    it('rejects refund on exchange return to prevent cash refund for size swap', async () => {
      prismaStub.return.findUnique.mockResolvedValueOnce({
        id: 602,
        orderId: 99101,
        isExchange: true,
        order: mockOrder,
        items: [],
      });

      const res = await returnService.processRefund(602, false, null, true);
      expect(res.success).toBe(false);
      expect(res.error).toContain('size exchange order; replacement item is fulfilled instead of a monetary refund');
    });

    it('rejects refund when order is already refunded (single-refund invariant)', async () => {
      prismaStub.return.findUnique.mockResolvedValueOnce({
        id: 603,
        orderId: 99101,
        isExchange: false,
        order: { ...mockOrder, financialStatus: 'refunded' },
        items: [],
      });

      const res = await returnService.processRefund(603, false, null, true);
      expect(res.success).toBe(false);
      expect(res.error).toContain('Only one refund per order is permitted');
    });
  });
});
