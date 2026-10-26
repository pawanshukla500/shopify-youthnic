/**
 * API and Integration Test Suite: Real-Time Sequential Dispatch & Velocity Carrier Error Surfacing
 *
 * Designed in accordance with /agency-api-tester guidelines:
 * - Comprehensive validation of Velocity carrier error extraction and transparent surfacing
 * - Clean status transitions from Dispatch Pending -> Ready to Ship upon AWB generation
 * - Elimination of sticky manifest error messages on subsequent successful dispatch
 * - Immediate audit trail logging of dispatch failures
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoist all shared mock stubs before module imports ───
const {
  prismaStub,
  createShipmentMock,
  cancelShipmentMock,
  createForwardShipmentMock,
  recordAccountTrailEventMock,
} = vi.hoisted(() => ({
  prismaStub: {
    order: {
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    shipment: {
      update: vi.fn(async () => ({})),
      upsert: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
    },
    accountTrail: {
      create: vi.fn(async () => ({})),
    },
    syncLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (queries: any[]) => {
      const results = [];
      for (const query of queries) {
        results.push(await query);
      }
      return results;
    }),
  },
  createShipmentMock: vi.fn(),
  cancelShipmentMock: vi.fn(async () => true),
  createForwardShipmentMock: vi.fn(),
  recordAccountTrailEventMock: vi.fn(async () => ({})),
}));

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/database/prisma', () => ({ default: prismaStub }));

vi.mock('../src/modules/delhivery/delhivery.service', () => ({
  default: {
    createShipment: createShipmentMock,
    cancelShipment: cancelShipmentMock,
  },
}));

vi.mock('../src/modules/velocity/velocity.service', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      createForwardShipment: createForwardShipmentMock,
    },
  };
});

vi.mock('../src/modules/shopify/shopify.service', () => ({
  default: { fulfillOrderOnShopify: vi.fn(async () => undefined) },
}));

vi.mock('../src/modules/notifications/notification.service', () => ({
  default: { notifyOrderShipped: vi.fn(async () => undefined) },
}));

vi.mock('../src/modules/payments/payment.service', () => ({
  default: { isReadyForDispatch: vi.fn(async () => ({ ready: true })) },
}));

vi.mock('../src/modules/accounts/account-trail.service', () => ({
  recordAccountTrailEvent: recordAccountTrailEventMock,
}));

import { extractVelocityErrorMessage } from '../src/modules/velocity/velocity.service';
import { classifyOrderTab, isManifestRejected } from '../src/modules/orders/order-tabs';
import { config } from '../src/config';

function createMockOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    shopifyOrderId: 'gid://shopify/Order/101',
    shopifyOrderName: '#26YOU6049',
    shopifyCreatedAt: new Date(config.shopify.syncStartDate.getTime() + 3600 * 1000),
    customerName: 'Pawan Customer',
    customerPhone: '9876543210',
    customerAddress: 'Ring Road',
    customerCity: 'Surat',
    customerState: 'Gujarat',
    customerPincode: '395002',
    customerCountry: 'India',
    paymentMethod: 'COD',
    tags: 'GoKwik, COD_CONFIRMED',
    totalAmount: 1499,
    items: [{ id: 1, title: 'Kurti Set', quantity: 1, price: 1499 }],
    status: 'DISPATCH_PENDING',
    fulfillmentStatus: null,
    shipment: null,
    supportFlag: null,
    hasUrgentSupport: false,
    ...overrides,
  };
}

describe('agency-api-tester: Velocity Error Extraction & Real-Time Dispatch Engine', () => {
  describe('Velocity Error Extraction Logic (extractVelocityErrorMessage)', () => {
    it('extracts top-level meta.message and meta.details', () => {
      const errorPayload = {
        meta: {
          status: 400,
          message: 'Insufficient wallet balance',
          details: 'Wallet balance INR 15.00 is below required INR 85.00',
        },
      };
      const extracted = extractVelocityErrorMessage(errorPayload);
      expect(extracted).toContain('Insufficient wallet balance');
    });

    it('extracts structured field validation errors (422 payload with field dictionary)', () => {
      const errorPayload = {
        status: 422,
        message: 'The given data was invalid.',
        errors: {
          shipping_phone: ['The shipping phone must be 10 digits.'],
          billing_address: ['The billing address field is required.'],
        },
      };
      const extracted = extractVelocityErrorMessage(errorPayload);
      expect(extracted).toContain('shipping_phone: The shipping phone must be 10 digits.');
      expect(extracted).toContain('billing_address: The billing address field is required.');
    });

    it('extracts unserviceable destination carrier error messages', () => {
      const errorPayload = {
        meta: {
          status: 400,
          message: 'Carrier is not serviceable for this pincode',
          details: 'No active courier partner for destination pincode 395001',
        },
      };
      const extracted = extractVelocityErrorMessage(errorPayload);
      expect(extracted).toContain('Carrier is not serviceable for this pincode');
    });

    it('extracts array of errors if present in payload', () => {
      const errorPayload = {
        errors: ['Pincode unserviceable by courier', 'Pickup location closed'],
      };
      const extracted = extractVelocityErrorMessage(errorPayload);
      expect(extracted).toBe('Pincode unserviceable by courier; Pickup location closed');
    });

    it('handles JSON string inputs gracefully', () => {
      const jsonString = JSON.stringify({
        message: 'Invalid API authorization token',
      });
      const extracted = extractVelocityErrorMessage(jsonString);
      expect(extracted).toBe('Invalid API authorization token');
    });

    it('falls back to provided message if payload contains no message', () => {
      const extracted = extractVelocityErrorMessage({}, 'Default carrier failure');
      expect(extracted).toBe('Default carrier failure');
    });
  });

  describe('Order Manifest State Transitions & Error Cleanup', () => {
    let orderService: any;

    beforeEach(async () => {
      vi.clearAllMocks();
      prismaStub.shipment.findFirst = vi.fn(async () => null);
      prismaStub.shipment.upsert = vi.fn(async () => ({
        id: 55,
        orderId: 101,
        status: 'CREATED',
        waybillNumber: 'VEL123456789IN',
      }));
      prismaStub.order.updateMany = vi.fn(async () => ({ count: 1 }));
      recordAccountTrailEventMock.mockClear();

      createForwardShipmentMock.mockReset().mockResolvedValue({
        awbCode: 'VEL123456789IN',
        courierName: 'Ekart Standard',
        labelUrl: 'https://velocityshipping.in/labels/VEL123456789IN.pdf',
      });

      createShipmentMock.mockReset().mockResolvedValue({
        waybillNumber: '30100810009999',
        labelUrl: 'https://example.com/delhivery.pdf',
      });

      prismaStub.order.findUnique = vi.fn(async () =>
        createMockOrder({
          supportFlag: 'MANIFEST_REVIEW',
          hasUrgentSupport: true,
          shipment: {
            id: 55,
            waybillNumber: null,
            status: 'ERROR',
            errorMessage: 'Previous Delhivery manifest failed: Low wallet balance',
          },
        })
      );

      const mod = await import('../src/modules/orders/order.service');
      orderService = mod.default;
    });

    it('clears previous errorMessage and supportFlag upon successful Velocity dispatch', async () => {
      const res = await orderService.dispatchOrder(101, undefined, 'Velocity');
      expect(res.waybillNumber).toBe('VEL123456789IN');

      // Shipment upsert must explicitly set errorMessage: null to clear past rejections
      expect(prismaStub.shipment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderId: 101 },
          update: expect.objectContaining({
            status: 'CREATED',
            waybillNumber: 'VEL123456789IN',
            errorMessage: null,
            trackingStatus: 'Label generated',
          }),
        })
      );

      // Order update must clear supportFlag and hasUrgentSupport
      expect(prismaStub.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 101, status: { in: ['NEW', 'DISPATCH_PENDING', 'DISPATCHED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'] } },
          data: expect.objectContaining({
            status: 'DISPATCHED',
            supportFlag: null,
            hasUrgentSupport: false,
          }),
        })
      );
    });

    it('records SHIPMENT_FAILED in account trail with detailed error when dispatch fails', async () => {
      createForwardShipmentMock.mockRejectedValueOnce(
        new Error('Velocity error (400): Destination pincode 395002 not serviceable by any carrier')
      );

      await expect(orderService.dispatchOrder(101, undefined, 'Velocity')).rejects.toThrow(
        /Destination pincode 395002 not serviceable/
      );

      expect(recordAccountTrailEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 101,
          eventType: 'SHIPMENT_FAILED',
          status: 'FAILED',
          note: expect.stringContaining('Destination pincode 395002 not serviceable'),
        })
      );
    });
  });

  describe('Order Tab Classification (classifyOrderTab & isManifestRejected)', () => {
    it('classifies order into "ready" (Ready to Ship) once AWB is generated, even for COD orders', () => {
      const orderSnapshot = {
        status: 'DISPATCHED',
        paymentMethod: 'COD',
        tags: 'GoKwik, COD_CONFIRMED',
        shipment: {
          status: 'CREATED',
          waybillNumber: 'VEL998877665IN',
          trackingStatus: 'Label generated',
          courier: 'Velocity (Ekart Standard)',
          errorMessage: null,
        },
      };

      const isRejected = isManifestRejected(orderSnapshot as any);
      expect(isRejected).toBe(false);

      const tab = classifyOrderTab(orderSnapshot as any);
      expect(tab).toBe('ready');
    });

    it('isManifestRejected returns false for active shipments with CREATED status and assigned AWB', () => {
      const orderWithLiveAwb = {
        status: 'DISPATCHED',
        shipment: {
          status: 'CREATED',
          waybillNumber: '30100810001234',
          errorMessage: null,
        },
      };
      expect(isManifestRejected(orderWithLiveAwb as any)).toBe(false);
    });

    it('isManifestRejected returns true only when shipment status is ERROR or truly unmanifested', () => {
      const rejectedOrder = {
        status: 'DISPATCH_PENDING',
        shipment: {
          status: 'ERROR',
          waybillNumber: null,
          errorMessage: 'manifest failed: insufficient balance',
          trackingUpdatedAt: null,
        },
      };
      expect(isManifestRejected(rejectedOrder as any)).toBe(true);
      expect(classifyOrderTab(rejectedOrder as any)).toBe('dispatch');
    });
  });
});
