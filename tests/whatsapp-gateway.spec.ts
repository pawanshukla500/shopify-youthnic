import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaStub, axiosStub } = vi.hoisted(() => ({
  prismaStub: {
    accountTrailEvent: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
  axiosStub: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('../src/database/prisma', () => ({ default: prismaStub }));
vi.mock('axios', () => ({ default: axiosStub }));

import { WhatsAppGatewayService } from '../src/modules/whatsapp/whatsapp-gateway.service';

describe('WhatsAppGatewayService (Ekta Notification Deduplication & Test Safety)', () => {
  let service: WhatsAppGatewayService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new WhatsAppGatewayService();
    service.clearDedupCacheForTests();
    prismaStub.accountTrailEvent.findFirst.mockResolvedValue(null);
    prismaStub.accountTrailEvent.create.mockResolvedValue({ id: 101 });
  });

  describe('Safety Guard in Test Environment', () => {
    it('skips live network requests and returns TEST_ENV_SKIPPED in test mode', async () => {
      const res = await service.sendTextMessage('918866077404@s.whatsapp.net', 'Test ping');
      expect(res.success).toBe(true);
      expect(res.messageId).toBe('TEST_ENV_SKIPPED');
      expect(axiosStub.post).not.toHaveBeenCalled();
    });

    it('rejects empty recipient', async () => {
      const res = await service.sendTextMessage('', 'Hello');
      expect(res.success).toBe(false);
      expect(res.error).toBe('Recipient is required');
    });
  });

  describe('Deduplication Logic for Ekta Notifications', () => {
    const mockOrder = {
      id: 555,
      shopifyOrderNumber: 26555,
      shopifyOrderName: '#26YOU555',
      customerName: 'Pooja Sharma',
      customerPhone: '9876543210',
      totalAmount: 1499,
      shipment: { waybillNumber: '141123456789' },
    };

    const mockReturn = {
      id: 88,
      returnWaybillNumber: 'VELR9988776655',
      refundAmount: 1499,
      shopifyRefundId: 'gid://shopify/Refund/998877',
      items: [{ title: 'Printed Kurti', sku: 'KURTI-M', quantity: 1 }],
    };

    it('deduplicates in-memory when notifyEktaPrepaidReturnRefund is called twice for the same return', async () => {
      // First dispatch
      const firstRes = await service.notifyEktaPrepaidReturnRefund({
        order: mockOrder,
        returnRecord: mockReturn,
        refundAmount: 1499,
        shopifyRefundId: 'gid://shopify/Refund/998877',
      });

      expect(firstRes.success).toBe(true);
      expect(firstRes.messageId).toBe('TEST_ENV_SKIPPED');
      expect(prismaStub.accountTrailEvent.create).toHaveBeenCalledTimes(1);
      expect(prismaStub.accountTrailEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orderId: 555,
            returnId: 88,
            eventType: 'EKTA_WHATSAPP_NOTIFIED',
            externalReference: 'EKTA_WA:PREPAID_RETURN:555:88',
          }),
        })
      );

      // Second dispatch with same parameters
      const secondRes = await service.notifyEktaPrepaidReturnRefund({
        order: mockOrder,
        returnRecord: mockReturn,
        refundAmount: 1499,
        shopifyRefundId: 'gid://shopify/Refund/998877',
      });

      expect(secondRes.success).toBe(true);
      expect(secondRes.messageId).toBe('DEDUPLICATED');
      // Should NOT have created a second database record
      expect(prismaStub.accountTrailEvent.create).toHaveBeenCalledTimes(1);
    });

    it('deduplicates via database check when an AccountTrailEvent already exists', async () => {
      // Simulate that DB already has an entry from a prior session or worker
      prismaStub.accountTrailEvent.findFirst.mockResolvedValueOnce({
        id: 999,
        orderId: 555,
        eventType: 'EKTA_WHATSAPP_NOTIFIED',
        externalReference: 'EKTA_WA:PREPAID_RTO:555',
      });

      const res = await service.notifyEktaPrepaidRtoRefund({
        order: mockOrder,
        refundAmount: 1499,
        shopifyRefundId: 'gid://shopify/Refund/998877',
      });

      expect(res.success).toBe(true);
      expect(res.messageId).toBe('DEDUPLICATED');
      expect(prismaStub.accountTrailEvent.findFirst).toHaveBeenCalledWith({
        where: {
          orderId: 555,
          eventType: 'EKTA_WHATSAPP_NOTIFIED',
          externalReference: 'EKTA_WA:PREPAID_RTO:555',
        },
      });
      expect(prismaStub.accountTrailEvent.create).not.toHaveBeenCalled();
    });

    it('deduplicates notifyEktaCodReturnReceived', async () => {
      const res1 = await service.notifyEktaCodReturnReceived({
        order: mockOrder,
        returnRecord: mockReturn,
        qcStatus: 'APPROVED',
      });
      expect(res1.messageId).toBe('TEST_ENV_SKIPPED');

      const res2 = await service.notifyEktaCodReturnReceived({
        order: mockOrder,
        returnRecord: mockReturn,
        qcStatus: 'APPROVED',
      });
      expect(res2.messageId).toBe('DEDUPLICATED');
    });

    it('deduplicates notifyEktaCodRtoReceived', async () => {
      const res1 = await service.notifyEktaCodRtoReceived({
        order: mockOrder,
        waybill: '141123456789',
      });
      expect(res1.messageId).toBe('TEST_ENV_SKIPPED');

      const res2 = await service.notifyEktaCodRtoReceived({
        order: mockOrder,
        waybill: '141123456789',
      });
      expect(res2.messageId).toBe('DEDUPLICATED');
    });
  });
});
