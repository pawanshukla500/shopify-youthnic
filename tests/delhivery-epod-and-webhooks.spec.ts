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

vi.mock('../src/modules/delhivery/delhivery.service', () => ({
  default: {
    mapTrackingToShipmentStatus: vi.fn((statusType: string) => {
      if (statusType === 'DL') return 'DELIVERED';
      if (statusType === 'UD') return 'IN_TRANSIT';
      if (statusType === 'RT') return 'RTO';
      return 'IN_TRANSIT';
    }),
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

      // Verify shipment transitioned to DELIVERED
      expect(prismaStub.shipment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 10 },
          data: expect.objectContaining({
            status: 'DELIVERED',
            epodReceivedBy: 'Pooja Verma (Self)',
          }),
        })
      );

      // Verify order transitioned to DELIVERED
      expect(prismaStub.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 100 },
          data: { status: 'DELIVERED' },
        })
      );

      // Verify delivery notification sent
      expect(notificationEngine.notifyDelivered).toHaveBeenCalledWith(mockShipment.order);

      // Verify tracking log created
      expect(prismaStub.trackingLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            shipmentId: 10,
            waybill: 'DELHI998877',
            status: 'EPOD_RECEIVED',
            receivedBy: 'Pooja Verma (Self)',
          }),
        })
      );
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
      expect(prismaStub.shipment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 20 },
          data: expect.objectContaining({ status: 'DELIVERED' }),
        })
      );

      // Background document fetch was triggered
      expect(mockTryFetchArtifact).toHaveBeenCalledWith(200, 'DELHI-SCAN-DLV', 'epod');
    });
  });
});
