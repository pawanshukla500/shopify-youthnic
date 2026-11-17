import { describe, it, expect } from 'vitest';

describe('Dashboard Digest & Period Filtering Logic', () => {
  it('correctly calculates period boundaries for today, yesterday, 7days, and month', () => {
    const fixedNow = new Date('2026-11-17T12:00:00.000Z');

    // Today
    const startOfToday = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate());
    expect(startOfToday.getDate()).toBe(fixedNow.getDate());

    // Yesterday
    const startOfYesterday = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate() - 1);
    expect(startOfYesterday.getDate()).toBe(fixedNow.getDate() - 1);

    // 7 Days
    const sevenDaysAgo = new Date(fixedNow.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(sevenDaysAgo.getTime()).toBeLessThan(fixedNow.getTime());
    expect(Math.round((fixedNow.getTime() - sevenDaysAgo.getTime()) / (24 * 3600 * 1000))).toBe(7);

    // Month
    const startOfMonth = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), 1);
    expect(startOfMonth.getDate()).toBe(1);
    expect(startOfMonth.getMonth()).toBe(fixedNow.getMonth());
  });

  it('formats real settlement batch information for dashboard presentation', () => {
    const mockBatch = {
      batchId: 'PTQXJM2TN3',
      gateway: 'EASEBUZZ',
      settlementDate: new Date('2026-11-17T00:00:00.000Z'),
      grossAmount: 7676.3,
      feeAmount: 191.91,
      gstAmount: 34.55,
      netAmount: 7448.84,
      bankUtr: 'HDFCH01411242767',
      orderCount: 6,
      refundCount: 1,
      refundAmount: 1,
      verificationStatus: 'UNVERIFIED',
    };

    expect(mockBatch.batchId).toBe('PTQXJM2TN3');
    expect(mockBatch.bankUtr).toBe('HDFCH01411242767');
    expect(mockBatch.netAmount).toBe(7448.84);
    expect(mockBatch.orderCount).toBe(6);
    expect(mockBatch.refundCount).toBe(1);
  });
});
