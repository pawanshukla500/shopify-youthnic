import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaStub, firebaseStub, velocityStub, delhiveryStub } = vi.hoisted(() => ({
  prismaStub: {
    order: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    return: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    shipment: { findUnique: vi.fn(), update: vi.fn() },
    accountTrailEvent: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn((fns: any[]) => Promise.all(fns)),
  },
  firebaseStub: { uploadPrivateBuffer: vi.fn(), createPrivateDownloadUrl: vi.fn() },
  velocityStub: { cancelShipment: vi.fn(), createForwardShipment: vi.fn() },
  delhiveryStub: { cancelShipment: vi.fn(), createShipment: vi.fn() },
}));

vi.mock('../src/database/prisma', () => ({ default: prismaStub }));
vi.mock('../src/modules/firebase/firebase.service', () => ({ default: firebaseStub }));
vi.mock('../src/modules/velocity/velocity.service', () => ({ default: velocityStub, isVelocityCourier: (c: string) => c?.toLowerCase().includes('velocity') }));
vi.mock('../src/modules/delhivery/delhivery.service', () => ({ default: delhiveryStub }));

import { recordManualRefund, ALLOWED_EVIDENCE_TYPES } from '../src/modules/accounts/account-trail.service';

const actor = {
  uid: 'operator-101',
  email: 'ops@youthnic.com',
  name: 'Operations Lead',
  role: 'OPERATOR',
};

beforeEach(() => {
  for (const group of Object.values(prismaStub)) {
    if (typeof group === 'object') {
      for (const fn of Object.values(group)) (fn as any).mockReset();
    }
  }
  prismaStub.$transaction.mockReset();
  prismaStub.$transaction.mockImplementation((fns: any[]) => Promise.all(fns));
  firebaseStub.uploadPrivateBuffer.mockReset();
  firebaseStub.createPrivateDownloadUrl.mockReset();
  velocityStub.cancelShipment.mockReset();
  delhiveryStub.cancelShipment.mockReset();

  prismaStub.order.findUnique.mockResolvedValue({ id: 266049, shopifyOrderName: '#26YOU6049', currency: 'INR', status: 'DISPATCHED' });
  prismaStub.return.findUnique.mockResolvedValue({ id: 12, orderId: 266049 });
  prismaStub.accountTrailEvent.create.mockResolvedValue({ id: 501 });
  prismaStub.order.update.mockResolvedValue({ id: 266049, financialStatus: 'refunded' });
  prismaStub.return.update.mockResolvedValue({ id: 12, refundStatus: 'PROCESSED' });
});

describe('Manual Refund Workflow & File Upload Validation', () => {
  it('supports PDF evidence documents and validates %PDF- magic bytes', async () => {
    // Valid PDF starts with %PDF- (0x25, 0x50, 0x44, 0x46, 0x2d)
    const validPdfBuffer = Buffer.from('%PDF-1.4 ... valid binary content ...');
    const pdfBase64 = validPdfBuffer.toString('base64');

    firebaseStub.uploadPrivateBuffer.mockResolvedValue({
      path: 'orders/266049/refund-proof-gpay.pdf',
      bucket: 'youthnic-vault',
    });

    const event = await recordManualRefund({
      orderId: 266049,
      returnId: 12,
      amount: 1499,
      refundMode: 'UPI',
      accountUsed: 'GPay Business UPI',
      externalReference: 'UPI-GPAY-987654',
      note: 'Manual GPay exception refund processed after customer bank confirmation',
      actor,
      evidence: {
        fileName: 'gpay_receipt.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      },
    });

    expect(ALLOWED_EVIDENCE_TYPES['application/pdf']).toBe('pdf');
    expect(firebaseStub.uploadPrivateBuffer).toHaveBeenCalledWith(
      expect.stringMatching(/^orders\/266049\/refund-proof-/),
      expect.any(Buffer),
      'application/pdf'
    );
    expect(prismaStub.accountTrailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 266049,
        eventType: 'REFUND_MANUAL',
        amount: 1499,
        externalReference: 'UPI-GPAY-987654',
        evidenceFileName: 'gpay_receipt.pdf',
        evidenceContentType: 'application/pdf',
      }),
    });
    expect(prismaStub.order.update).toHaveBeenCalledWith({
      where: { id: 266049 },
      data: expect.objectContaining({ financialStatus: 'refunded' }),
    });
    expect(prismaStub.return.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: expect.objectContaining({
        refundStatus: 'PROCESSED',
        returnStatus: 'REFUNDED',
        refundAmount: 1499,
      }),
    });
  });

  it('strictly rejects non-whitelisted extensions such as .exe and text files', async () => {
    const exeBuffer = Buffer.from('MZ...fake executable content...');
    await expect(
      recordManualRefund({
        orderId: 266049,
        amount: 500,
        refundMode: 'UPI',
        accountUsed: 'Bank Transfer',
        actor,
        evidence: {
          fileName: 'payload.exe',
          contentType: 'application/x-msdownload',
          contentBase64: exeBuffer.toString('base64'),
        },
      })
    ).rejects.toThrow(/Refund proof must be a PNG, JPEG, WebP image, or PDF document/i);

    expect(firebaseStub.uploadPrivateBuffer).not.toHaveBeenCalled();
    expect(prismaStub.accountTrailEvent.create).not.toHaveBeenCalled();
  });

  it('strictly rejects spoofed file types (e.g. PDF declared but contains invalid non-PDF bytes)', async () => {
    const fakeBuffer = Buffer.from('NOT_A_REAL_PDF_FILE');
    await expect(
      recordManualRefund({
        orderId: 266049,
        amount: 500,
        refundMode: 'UPI',
        accountUsed: 'Bank Transfer',
        actor,
        evidence: {
          fileName: 'spoofed.pdf',
          contentType: 'application/pdf',
          contentBase64: fakeBuffer.toString('base64'),
        },
      })
    ).rejects.toThrow(/Refund proof content does not match its file type/i);

    expect(firebaseStub.uploadPrivateBuffer).not.toHaveBeenCalled();
  });

  it('rejects evidence files exceeding 5 MB limit', async () => {
    // 5.1 MB buffer
    const largeBuffer = Buffer.alloc(5.1 * 1024 * 1024, 0x25); // Starts with %
    // Ensure it begins with %PDF-
    largeBuffer.write('%PDF-', 0, 5, 'ascii');

    await expect(
      recordManualRefund({
        orderId: 266049,
        amount: 500,
        refundMode: 'UPI',
        accountUsed: 'Bank Transfer',
        actor,
        evidence: {
          fileName: 'large.pdf',
          contentType: 'application/pdf',
          contentBase64: largeBuffer.toString('base64'),
        },
      })
    ).rejects.toThrow(/smaller than 5 MB/i);

    expect(firebaseStub.uploadPrivateBuffer).not.toHaveBeenCalled();
  });
});
