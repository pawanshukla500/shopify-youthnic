import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaStub, firebaseStub } = vi.hoisted(() => ({
  prismaStub: {
    order: { findUnique: vi.fn() },
    return: { findUnique: vi.fn(), findMany: vi.fn() },
    accountTrailEvent: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    syncLog: { create: vi.fn() },
  },
  firebaseStub: { uploadPrivateBuffer: vi.fn(), createPrivateDownloadUrl: vi.fn() },
}));

vi.mock('../src/database/prisma', () => ({ default: prismaStub }));
vi.mock('../src/modules/firebase/firebase.service', () => ({ default: firebaseStub }));

import { backfillMissingRefundTrailEvents, getOrderAccountTrail, recordAccountTrailEvent, recordManualRefund } from '../src/modules/accounts/account-trail.service';
import { SyncType } from '@prisma/client';

const actor = {
  uid: 'firebase-user-42',
  email: 'operator@youthnic.com',
  name: 'Riya Operator',
  role: 'OPERATOR',
};

beforeEach(() => {
  for (const group of Object.values(prismaStub)) {
    for (const fn of Object.values(group)) (fn as any).mockReset();
  }
  firebaseStub.uploadPrivateBuffer.mockReset();
  firebaseStub.createPrivateDownloadUrl.mockReset();
  prismaStub.order.findUnique.mockResolvedValue({ id: 1, currency: 'INR' });
  prismaStub.return.findUnique.mockResolvedValue({ id: 7, orderId: 1 });
  prismaStub.accountTrailEvent.create.mockResolvedValue({ id: 90 });
});

describe('recordAccountTrailEvent', () => {
  it('adopts an existing event when the same Shopify refund ID is retried', async () => {
    prismaStub.accountTrailEvent.create.mockRejectedValueOnce({ code: 'P2002' });
    prismaStub.accountTrailEvent.findFirst.mockResolvedValue({ id: 91, externalReference: '4001' });

    const event = await recordAccountTrailEvent({
      orderId: 1,
      eventType: 'REFUND_AUTOMATIC',
      actorType: 'SYSTEM',
      source: 'RTO_AUTO_REFUND',
      externalReference: '4001',
    });

    expect(prismaStub.accountTrailEvent.findFirst).toHaveBeenCalledWith({
      where: { orderId: 1, eventType: 'REFUND_AUTOMATIC', externalReference: '4001' },
    });
    expect(event).toMatchObject({ id: 91, externalReference: '4001' });
  });
});

describe('recordManualRefund', () => {
  it('records the human actor, refund mode, source account, and reference', async () => {
    await recordManualRefund({
      orderId: 1,
      returnId: 7,
      amount: 719.1,
      refundMode: 'UPI',
      accountUsed: 'HDFC Current Account',
      externalReference: 'UTR-9081',
      note: 'Customer paid by UPI',
      actor,
    });

    expect(prismaStub.accountTrailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 1,
        returnId: 7,
        eventType: 'REFUND_MANUAL',
        actorType: 'USER',
        actorUid: actor.uid,
        actorEmail: actor.email,
        actorName: actor.name,
        actorRole: actor.role,
        source: 'MANUAL_PAYOUT',
        status: 'COMPLETED',
        amount: 719.1,
        currency: 'INR',
        refundMode: 'UPI',
        accountUsed: 'HDFC Current Account',
        externalReference: 'UTR-9081',
        note: 'Customer paid by UPI',
      }),
    });
  });

  it('stores attached proof privately and keeps only its storage metadata in the event', async () => {
    firebaseStub.uploadPrivateBuffer.mockResolvedValue({ path: 'orders/1/refund-proof-abc.png', bucket: 'test-bucket' });

    await recordManualRefund({
      orderId: 1,
      returnId: 7,
      amount: 719.1,
      refundMode: 'UPI',
      accountUsed: 'HDFC Current Account',
      externalReference: 'UTR-9081',
      actor,
      evidence: {
        fileName: 'upi-proof.png',
        contentType: 'image/png',
        contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l0sAAAAASUVORK5CYII=',
      },
    });

    expect(firebaseStub.uploadPrivateBuffer).toHaveBeenCalledWith(
      expect.stringMatching(/^orders\/1\/refund-proof-/),
      expect.any(Buffer),
      'image/png'
    );
    expect(prismaStub.accountTrailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        evidenceStoragePath: 'orders/1/refund-proof-abc.png',
        evidenceFileName: 'upi-proof.png',
        evidenceContentType: 'image/png',
      }),
    });
  });

  it('rejects full bank or card numbers in the account label', async () => {
    await expect(recordManualRefund({
      orderId: 1,
      amount: 100,
      refundMode: 'BANK_TRANSFER',
      accountUsed: 'Bank transfer 1234567890123456',
      actor,
    })).rejects.toThrow(/masked account label/i);

    expect(prismaStub.accountTrailEvent.create).not.toHaveBeenCalled();
    expect(firebaseStub.uploadPrivateBuffer).not.toHaveBeenCalled();
  });

  it('rejects account labels that hide a full number behind separators', async () => {
    for (const label of ['HDFC a/c 1234.5678.9012', 'UPI refund 1234/5678/9012']) {
      await expect(recordManualRefund({
        orderId: 1,
        amount: 100,
        refundMode: 'UPI',
        accountUsed: label,
        actor,
      })).rejects.toThrow(/masked account label/i);
    }

    expect(prismaStub.accountTrailEvent.create).not.toHaveBeenCalled();
    expect(firebaseStub.uploadPrivateBuffer).not.toHaveBeenCalled();
  });

  it('rejects a sub-cent amount that would round to zero', async () => {
    await expect(recordManualRefund({
      orderId: 1,
      amount: 0.001,
      refundMode: 'UPI',
      accountUsed: 'HDFC Current Account',
      actor,
    })).rejects.toThrow(/too small|greater than zero/i);

    expect(prismaStub.accountTrailEvent.create).not.toHaveBeenCalled();
    expect(firebaseStub.uploadPrivateBuffer).not.toHaveBeenCalled();
  });

  it('adopts the existing record when the same payout reference is submitted twice', async () => {
    const existing = { id: 95, orderId: 1, eventType: 'REFUND_MANUAL', externalReference: 'UTR-1' };
    prismaStub.accountTrailEvent.findFirst.mockResolvedValue(existing);

    const event = await recordManualRefund({
      orderId: 1,
      amount: 100,
      refundMode: 'UPI',
      accountUsed: 'HDFC Current Account',
      externalReference: 'UTR-1',
      actor,
    });

    expect(event).toMatchObject({ id: 95 });
    expect(prismaStub.accountTrailEvent.findFirst).toHaveBeenCalledWith({
      where: { orderId: 1, eventType: 'REFUND_MANUAL', externalReference: 'UTR-1' },
    });
    expect(prismaStub.accountTrailEvent.create).not.toHaveBeenCalled();
    expect(firebaseStub.uploadPrivateBuffer).not.toHaveBeenCalled();
  });

  it('treats a reference-less repeat within minutes as the same payout, not a new one', async () => {
    const existing = { id: 96, orderId: 1, eventType: 'REFUND_MANUAL', externalReference: null };
    prismaStub.accountTrailEvent.findFirst.mockResolvedValue(existing);

    const event = await recordManualRefund({
      orderId: 1,
      amount: 100,
      refundMode: 'UPI',
      accountUsed: 'HDFC Current Account',
      actor,
    });

    expect(event).toMatchObject({ id: 96 });
    expect(prismaStub.accountTrailEvent.create).not.toHaveBeenCalled();
    expect(firebaseStub.uploadPrivateBuffer).not.toHaveBeenCalled();
  });

  it('rejects a non-positive amount before creating a payout record', async () => {
    await expect(recordManualRefund({
      orderId: 1,
      amount: 0,
      refundMode: 'UPI',
      accountUsed: 'HDFC Current Account',
      actor,
    })).rejects.toThrow(/greater than zero/i);

    expect(prismaStub.accountTrailEvent.create).not.toHaveBeenCalled();
  });

  it('rejects a return linked to another order', async () => {
    prismaStub.return.findUnique.mockResolvedValue({ id: 7, orderId: 999 });

    await expect(recordManualRefund({
      orderId: 1,
      returnId: 7,
      amount: 100,
      refundMode: 'BANK_TRANSFER',
      accountUsed: 'HDFC Current Account',
      actor,
    })).rejects.toThrow(/does not belong to order/i);

    expect(prismaStub.accountTrailEvent.create).not.toHaveBeenCalled();
  });
});

describe('backfillMissingRefundTrailEvents', () => {
  it('queues lost trail writes under a SyncType the database actually accepts', () => {
    expect(SyncType.ACCOUNT_TRAIL_BACKFILL).toBe('ACCOUNT_TRAIL_BACKFILL');
  });

  it('recreates a trail event for a processed return that has none', async () => {
    prismaStub.return.findMany.mockResolvedValue([
      { id: 7, orderId: 1, refundAmount: 719.1, shopifyRefundId: '3001' },
    ]);
    prismaStub.accountTrailEvent.findFirst.mockResolvedValue(null);
    prismaStub.accountTrailEvent.create.mockResolvedValue({ id: 101 });

    const created = await backfillMissingRefundTrailEvents(10);

    expect(created).toBe(1);
    expect(prismaStub.accountTrailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 1,
        returnId: 7,
        eventType: 'REFUND_AUTOMATIC',
        externalReference: '3001',
      }),
    });
  });

  it('skips processed returns that already have a trail event', async () => {
    prismaStub.return.findMany.mockResolvedValue([
      { id: 7, orderId: 1, refundAmount: 719.1, shopifyRefundId: '3001' },
    ]);
    prismaStub.accountTrailEvent.findFirst.mockResolvedValue({ id: 101 });

    const created = await backfillMissingRefundTrailEvents(10);

    expect(created).toBe(0);
    expect(prismaStub.accountTrailEvent.create).not.toHaveBeenCalled();
  });

  it('continues past a single failing return instead of aborting the batch', async () => {
    prismaStub.return.findMany.mockResolvedValue([
      { id: 7, orderId: 1, refundAmount: 719.1, shopifyRefundId: '3001' },
      { id: 8, orderId: 2, refundAmount: 500, shopifyRefundId: '3002' },
    ]);
    prismaStub.accountTrailEvent.findFirst.mockResolvedValue(null);
    prismaStub.accountTrailEvent.create
      .mockRejectedValueOnce({ code: 'P2025' })
      .mockResolvedValue({ id: 102 });

    const created = await backfillMissingRefundTrailEvents(10);

    expect(created).toBe(1);
    expect(prismaStub.accountTrailEvent.create).toHaveBeenCalledTimes(2);
  });
});

describe('getOrderAccountTrail', () => {
  it('returns short-lived proof URLs without exposing private storage paths', async () => {
    const { evidenceStoragePath: _privatePath, ...event } = {
      id: 90,
      orderId: 1,
      eventType: 'REFUND_MANUAL',
      evidenceStoragePath: 'orders/1/refund-proof-abc.png',
      evidenceFileName: 'upi-proof.png',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    prismaStub.accountTrailEvent.findMany.mockResolvedValue([{ ...event, evidenceStoragePath: _privatePath }]);
    firebaseStub.createPrivateDownloadUrl.mockResolvedValue('https://signed.example/proof');

    const events = await getOrderAccountTrail(1);

    expect(firebaseStub.createPrivateDownloadUrl).toHaveBeenCalledWith('orders/1/refund-proof-abc.png');
    expect(events[0]).toMatchObject({ id: 90, evidenceFileName: 'upi-proof.png', evidenceUrl: 'https://signed.example/proof' });
    expect(events[0]).not.toHaveProperty('evidenceStoragePath');
  });
});
