import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeScanPushPayload,
  normalizeEpodPayload,
  handleScanPush,
  handleEpodPush,
} from '../src/routes/delhivery-webhooks';
import { config } from '../src/config';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSaveEpodArtifact = vi.fn();
const mockTryFetchArtifact = vi.fn();

vi.mock('../src/modules/delhivery/delhivery-document-fetcher.service', () => ({
  default: {
    saveEpodArtifact: (...args: any[]) => mockSaveEpodArtifact(...args),
    tryFetchArtifact: (...args: any[]) => mockTryFetchArtifact(...args),
  },
}));

// The authenticated tracking API's answer, used to confirm pushed terminal
// statuses. Defaults to "Delivered"; tests override it to simulate a forgery.
const { liveTracking } = vi.hoisted(() => ({
  liveTracking: { statusType: 'DL', status: 'Delivered', history: [] as any[] } as any,
}));

vi.mock('../src/modules/delhivery/delhivery.service', () => ({
  default: {
    mapTrackingToShipmentStatus: vi.fn((statusType: string) => {
      if (statusType === 'DL') return 'DELIVERED';
      if (statusType === 'UD') return 'IN_TRANSIT';
      if (statusType === 'RT') return 'RTO';
      return 'IN_TRANSIT';
    }),
    trackShipment: vi.fn(async () => liveTracking),
    downloadDocument: vi.fn(async () => ({ success: true, url: 'https://test.delhivery.com/doc.jpg' })),
  },
}));

vi.mock('../src/modules/notifications/notification.service', () => ({
  default: {
    notifyOutForDelivery: vi.fn(),
    notifyDelivered: vi.fn(),
    notifyNDR: vi.fn(),
    sendCustomMessage: vi.fn(),
  },
}));

const { trackingStub } = vi.hoisted(() => ({
  trackingStub: { evaluateConsumerDelay: vi.fn() },
}));
vi.mock('../src/modules/tracking/tracking.service', () => ({ default: trackingStub }));

const { prismaStub } = vi.hoisted(() => ({
  prismaStub: {
    shipment: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    order: {
      findFirst: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    trackingLog: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    syncLog: {
      create: vi.fn(),
    },
  },
}));
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));

import notificationEngine from '../src/modules/notifications/notification.service';

function createMockReqRes(options: {
  body?: any;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}) {
  const req: any = {
    body: options.body || {},
    query: options.query || {},
    headers: options.headers || {},
  };
  const res: any = {
    statusCode: 200,
    data: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.data = payload;
      return this;
    },
  };
  return { req, res };
}

describe('Delhivery EPOD & Scan Webhook Processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.delhivery.webhookSecret = '';
    liveTracking.statusType = 'DL';
    liveTracking.status = 'Delivered';
    prismaStub.shipment.updateMany.mockResolvedValue({ count: 1 });
  });

  describe('normalizeEpodPayload', () => {
    it('parses nested Shipment schema with EPOD URL and consignee', () => {
      const payload = {
        Shipment: {
          AWB: '987654321012',
          EPOD: 'https://delhivery-docs.s3.amazonaws.com/epod/987654321012.jpg',
          receivedBy: 'Ramesh Patel',
          ReferenceNo: '1005',
          StatusDateTime: '2026-09-29T10:15:00.000Z',
        },
      };

      const normalized = normalizeEpodPayload(payload);
      expect(normalized).not.toBeNull();
      expect(normalized?.waybill).toBe('987654321012');
      expect(normalized?.epodData).toBe('https://delhivery-docs.s3.amazonaws.com/epod/987654321012.jpg');
      expect(normalized?.receivedBy).toBe('Ramesh Patel');
      expect(normalized?.orderId).toBe('1005');
      expect(normalized?.receivedAt).toEqual(new Date('2026-09-29T10:15:00.000Z'));
    });

    it('parses flat schema with awb, pod, and consignee name', () => {
      const payload = {
        awb: '123456789012',
        pod: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...',
        consignee: 'Aarav Sharma',
        timestamp: '2026-09-29T11:30:00.000Z',
        orderID: '2001',
      };

      const normalized = normalizeEpodPayload(payload);
      expect(normalized).not.toBeNull();
      expect(normalized?.waybill).toBe('123456789012');
      expect(normalized?.epodData).toBe('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...');
      expect(normalized?.receivedBy).toBe('Aarav Sharma');
      expect(normalized?.orderId).toBe('2001');
    });

    it('returns null on missing waybill', () => {
      expect(normalizeEpodPayload({})).toBeNull();
      expect(normalizeEpodPayload({ EPOD: 'https://example.com/epod.jpg' })).toBeNull();
      expect(normalizeEpodPayload(null)).toBeNull();
      expect(normalizeEpodPayload('not-an-object')).toBeNull();
    });
  });

  describe('normalizeScanPushPayload enhancements', () => {
    it('parses variations of waybill keys (AWB, Waybill, waybill_number)', () => {
      expect(normalizeScanPushPayload({ AWB: '555', status: 'In Transit' })?.waybill).toBe('555');
      expect(normalizeScanPushPayload({ Waybill: '666', status: 'Dispatched' })?.waybill).toBe('666');
      expect(normalizeScanPushPayload({ waybill_number: '777', status: 'Manifested' })?.waybill).toBe('777');
    });
  });

  describe('handleEpodPush Webhook Route', () => {
    it('saves EPOD artifact, marks shipment and order DELIVERED, and triggers notification', async () => {
      const mockShipment = {
        id: 10,
        orderId: 100,
        waybillNumber: 'DELHI998877',
        status: 'IN_TRANSIT',
        trackingLocation: 'Surat Delivery Center',
        order: {
          id: 100,
          status: 'IN_TRANSIT',
          customerName: 'Pooja Verma',
          shopifyOrderName: '#YOUTH-100',
        },
      };

      prismaStub.shipment.findFirst.mockResolvedValueOnce(mockShipment);
      mockSaveEpodArtifact.mockResolvedValueOnce({
        uploaded: true,
        path: 'orders/100/epod-1234.jpg',
        url: 'https://storage.googleapis.com/bucket/orders/100/epod-1234.jpg',
      });

      const { req, res } = createMockReqRes({
        body: {
          waybill: 'DELHI998877',
          EPOD: 'https://delhivery.com/epod-download/DELHI998877',
          receivedBy: 'Pooja Verma (Self)',
          timestamp: '2026-09-29T12:00:00.000Z',
        },
      });

      await handleEpodPush(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.processed).toBe(1);

      // Verify artifact saved
      expect(mockSaveEpodArtifact).toHaveBeenCalledWith(
        100,
        'DELHI998877',
        'https://delhivery.com/epod-download/DELHI998877',
        'Pooja Verma (Self)',
        expect.any(Date)
      );

      // Verify shipment transitioned to DELIVERED, conditional on the status read
      expect(prismaStub.shipment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 10, status: 'IN_TRANSIT' },
          data: expect.objectContaining({
            status: 'DELIVERED',
            epodReceivedBy: 'Pooja Verma (Self)',
          }),
        })
      );

      // Verify order transitioned to DELIVERED with its delivery time
      expect(prismaStub.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 100 },
          data: { status: 'DELIVERED', deliveredAt: expect.any(Date) },
        })
      );

      // Verify delivery notification sent
      expect(notificationEngine.notifyDelivered).toHaveBeenCalledWith(mockShipment.order);

      // Verify tracking log written idempotently
      expect(prismaStub.trackingLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            shipmentId: 10,
            waybill: 'DELHI998877',
            status: 'EPOD_RECEIVED',
            receivedBy: 'Pooja Verma (Self)',
          }),
        })
      );
    });

    it('ignores an EPOD that Delhivery tracking does not confirm as delivered', async () => {
      liveTracking.statusType = 'UD';
      liveTracking.status = 'In Transit';
      prismaStub.shipment.findFirst.mockResolvedValueOnce({
        id: 12,
        orderId: 102,
        waybillNumber: 'DELHI-FORGED',
        status: 'IN_TRANSIT',
        order: { id: 102, status: 'IN_TRANSIT' },
      });

      const { req, res } = createMockReqRes({
        body: { waybill: 'DELHI-FORGED', EPOD: 'https://attacker.example/epod.jpg' },
      });
      await handleEpodPush(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.data.processed).toBe(0);
      expect(mockSaveEpodArtifact).not.toHaveBeenCalled();
      expect(prismaStub.shipment.updateMany).not.toHaveBeenCalled();
      expect(prismaStub.order.update).not.toHaveBeenCalled();
      expect(notificationEngine.notifyDelivered).not.toHaveBeenCalled();
    });

    it('never looks an EPOD order up by the sequential internal order id', async () => {
      prismaStub.shipment.findFirst.mockResolvedValueOnce(null);
      prismaStub.order.findFirst.mockResolvedValueOnce(null);

      const { req, res } = createMockReqRes({ body: { waybill: 'UNKNOWN-AWB', orderID: '42' } });
      await handleEpodPush(req, res);

      const where = prismaStub.order.findFirst.mock.calls[0][0].where;
      expect(where.OR).not.toContainEqual({ id: 42 });
      expect(where.OR).toContainEqual({ shopifyOrderId: '42' });
    });

    it('falls back to tryFetchArtifact if EPOD webhook only carries waybill notification', async () => {
      const mockShipment = {
        id: 11,
        orderId: 101,
        waybillNumber: 'DELHI112233',
        status: 'DELIVERED',
        epodStoragePath: null,
        order: { id: 101, status: 'DELIVERED' },
      };

      prismaStub.shipment.findFirst.mockResolvedValueOnce(mockShipment);
      mockTryFetchArtifact.mockResolvedValueOnce({ uploaded: true, path: 'orders/101/epod-456.jpg' });

      const { req, res } = createMockReqRes({
        body: {
          waybill: 'DELHI112233',
          receivedBy: 'Security Guard',
        },
      });

      await handleEpodPush(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.data.success).toBe(true);
      expect(mockTryFetchArtifact).toHaveBeenCalledWith(101, 'DELHI112233', 'epod');
    });

    it('enforces webhook secret when configured', async () => {
      config.delhivery.webhookSecret = 'super-secret-key-123';

      // 1. Rejected with invalid secret
      const { req: badReq, res: badRes } = createMockReqRes({
        body: { waybill: '123' },
        query: { secret: 'wrong' },
      });
      await handleEpodPush(badReq, badRes);
      expect(badRes.statusCode).toBe(401);

      // 2. Accepted with header secret
      const { req: goodReq, res: goodRes } = createMockReqRes({
        body: { waybill: '123' },
        headers: { 'x-delhivery-secret': 'super-secret-key-123' },
      });
      prismaStub.shipment.findFirst.mockResolvedValueOnce(null);
      await handleEpodPush(goodReq, goodRes);
      expect(goodRes.statusCode).toBe(200);
    });
  });

  describe('handleScanPush Webhook Route', () => {
    it('triggers background EPOD artifact fetch when scan status becomes DELIVERED and epodStoragePath is null', async () => {
      const mockShipment = {
        id: 20,
        orderId: 200,
        waybillNumber: 'DELHI-SCAN-DLV',
        status: 'IN_TRANSIT',
        epodStoragePath: null,
        order: { id: 200, status: 'IN_TRANSIT' },
      };

      prismaStub.shipment.findFirst.mockResolvedValueOnce(mockShipment);
      mockTryFetchArtifact.mockResolvedValueOnce({ uploaded: true, path: 'orders/200/epod.jpg' });

      const { req, res } = createMockReqRes({
        body: {
          Shipment: {
            AWB: 'DELHI-SCAN-DLV',
            Status: {
              Status: 'Delivered',
              StatusType: 'DL',
              StatusLocation: 'Mumbai_Hub',
              StatusDateTime: '2026-09-29T14:00:00Z',
            },
          },
        },
      });

      await handleScanPush(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.data.received).toBe(true);

      // Status transitioned to DELIVERED
      expect(prismaStub.shipment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 20, status: 'IN_TRANSIT' },
          data: expect.objectContaining({ status: 'DELIVERED' }),
        })
      );

      // Background document fetch was triggered
      expect(mockTryFetchArtifact).toHaveBeenCalledWith(200, 'DELHI-SCAN-DLV', 'epod');
    });

    it('drops a pushed "Delivered" scan that the tracking API does not confirm', async () => {
      liveTracking.statusType = 'UD';
      liveTracking.status = 'In Transit';
      prismaStub.shipment.findFirst.mockResolvedValueOnce({
        id: 22,
        orderId: 202,
        waybillNumber: 'DELHI-FAKE-DLV',
        status: 'IN_TRANSIT',
        order: { id: 202, status: 'IN_TRANSIT' },
      });

      const { req, res } = createMockReqRes({
        body: { Shipment: { AWB: 'DELHI-FAKE-DLV', Status: { Status: 'Delivered', StatusType: 'DL' } } },
      });
      await handleScanPush(req, res);

      expect(res.statusCode).toBe(200);
      expect(prismaStub.shipment.updateMany).not.toHaveBeenCalled();
      expect(prismaStub.shipment.update).not.toHaveBeenCalled();
      expect(prismaStub.trackingLog.upsert).not.toHaveBeenCalled();
      expect(prismaStub.order.update).not.toHaveBeenCalled();
      expect(notificationEngine.notifyDelivered).not.toHaveBeenCalled();
    });

    it('records a scan older than the newest applied one without moving the status', async () => {
      prismaStub.shipment.findFirst.mockResolvedValueOnce({
        id: 23,
        orderId: 203,
        waybillNumber: 'DELHI-LATE',
        status: 'OUT_FOR_DELIVERY',
        trackingHistory: [{ status: 'Dispatched', dateTime: '2026-10-03T09:00:00.000Z' }],
        order: { id: 203, status: 'OUT_FOR_DELIVERY' },
      });

      const { req, res } = createMockReqRes({
        body: {
          Shipment: {
            AWB: 'DELHI-LATE',
            Status: { Status: 'In Transit', StatusType: 'UD', StatusDateTime: '2026-10-02T09:00:00Z' },
          },
        },
      });
      await handleScanPush(req, res);

      expect(prismaStub.shipment.updateMany).not.toHaveBeenCalled();
      const update = prismaStub.shipment.update.mock.calls[0][0];
      expect(update.data.status).toBeUndefined();
      expect(update.data.trackingStatus).toBeUndefined();
      expect(update.data.trackingHistory).toHaveLength(2);
      expect(prismaStub.order.update).not.toHaveBeenCalled();
    });

    it('does not reopen or message a cancelled order whose parcel moves, and flags it', async () => {
      prismaStub.shipment.findFirst.mockResolvedValueOnce({
        id: 24,
        orderId: 204,
        waybillNumber: 'DELHI-CANCELLED',
        status: 'CREATED',
        order: { id: 204, status: 'CANCELLED', supportFlag: null },
      });

      const { req, res } = createMockReqRes({
        body: { Shipment: { AWB: 'DELHI-CANCELLED', Status: { Status: 'In Transit', StatusType: 'UD' } } },
      });
      await handleScanPush(req, res);

      expect(prismaStub.order.update).toHaveBeenCalledTimes(1);
      expect(prismaStub.order.update).toHaveBeenCalledWith({
        where: { id: 204 },
        data: { hasUrgentSupport: true, supportFlag: 'PARCEL_MOVING_ON_CLOSED_ORDER' },
      });
      expect(trackingStub.evaluateConsumerDelay).not.toHaveBeenCalled();
    });

    it('skips the transition when another writer already moved the shipment', async () => {
      prismaStub.shipment.updateMany.mockResolvedValueOnce({ count: 0 });
      prismaStub.shipment.findFirst.mockResolvedValueOnce({
        id: 25,
        orderId: 205,
        waybillNumber: 'DELHI-RACE',
        status: 'IN_TRANSIT',
        order: { id: 205, status: 'IN_TRANSIT' },
      });

      const { req, res } = createMockReqRes({
        body: { Shipment: { AWB: 'DELHI-RACE', Status: { Status: 'Delivered', StatusType: 'DL' } } },
      });
      await handleScanPush(req, res);

      expect(prismaStub.order.update).not.toHaveBeenCalled();
      expect(notificationEngine.notifyDelivered).not.toHaveBeenCalled();
    });

    it('immediately evaluates a delay scan for customer notification', async () => {
      const mockShipment = {
        id: 21,
        orderId: 201,
        waybillNumber: 'DELHI-SCAN-DELAY',
        status: 'IN_TRANSIT',
        epodStoragePath: null,
        order: { id: 201, status: 'IN_TRANSIT', customerEmail: 'customer@example.com' },
      };
      prismaStub.shipment.findFirst.mockResolvedValueOnce(mockShipment);

      const { req, res } = createMockReqRes({
        body: {
          Shipment: {
            AWB: 'DELHI-SCAN-DELAY',
            Status: {
              Status: 'In Transit',
              StatusType: 'UD',
              StatusLocation: 'Bhiwandi Hub',
              Instructions: 'Delayed due to route congestion',
              StatusDateTime: '2026-10-02T14:00:00Z',
            },
          },
        },
      });

      await handleScanPush(req, res);

      expect(res.statusCode).toBe(200);
      expect(trackingStub.evaluateConsumerDelay).toHaveBeenCalledWith(
        mockShipment,
        expect.objectContaining({
          status: 'In Transit',
          location: 'Bhiwandi Hub',
          remarks: 'Delayed due to route congestion',
        })
      );
    });
  });
});
