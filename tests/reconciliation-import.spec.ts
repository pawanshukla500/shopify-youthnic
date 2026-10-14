/**
 * Uploaded reconciliation files → money fields on orders and shipments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prismaStub } = vi.hoisted(() => ({
  prismaStub: {
    order: { findMany: vi.fn(), update: vi.fn() },
    shipment: { findFirst: vi.fn(), update: vi.fn() },
    return: { findFirst: vi.fn(), update: vi.fn() },
    reconciliationImport: { create: vi.fn() },
  },
}));
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));

import {
  importCarrierRemittance,
  importDelhiveryCharges,
  importDelhiveryRemittance,
  importGatewaySettlement,
} from '../src/modules/accounts/reconciliation.service';
import { gridToSheet } from '../src/modules/accounts/spreadsheet';

function sheet(name: string, grid: string[][]) {
  return gridToSheet(name, grid);
}

beforeEach(() => {
  for (const group of Object.values(prismaStub)) for (const fn of Object.values(group)) (fn as any).mockReset();
  prismaStub.order.update.mockResolvedValue({});
  prismaStub.shipment.update.mockResolvedValue({});
  prismaStub.return.update.mockResolvedValue({});
  prismaStub.reconciliationImport.create.mockResolvedValue({ id: 1 });
});

describe('Delhivery COD remittance', () => {
  it('marks matched AWBs remitted and records the bank UTR on the order', async () => {
    prismaStub.shipment.findFirst.mockImplementation(async ({ where }: any) =>
      where.OR.some((c: any) => c.waybillNumber === '30100810011111')
        ? { id: 5, codAmount: 799, codCollectedAt: null, order: { id: 50, totalAmount: 799 } }
        : null
    );

    const result = await importDelhiveryRemittance('remit.csv', [
      sheet('remit', [
        ['Waybill Number', 'COD Amount', 'Remittance Number', 'Bank Transaction ID', 'Remittance Processed Date'],
        ['30100810011111', '799.00', 'RMT-91', 'UTIBR52026100800123', '08-10-2026'],
        ['30100899999999', '450.00', 'RMT-91', 'UTIBR52026100800123', '08-10-2026'],
      ]),
    ]);

    expect(result.matchedCount).toBe(1);
    expect(result.unmatched).toEqual(['30100899999999']);
    expect(prismaStub.shipment.update.mock.calls[0][0].data).toMatchObject({
      codRemitted: true,
      codRemittanceRef: 'RMT-91',
      codRemittedAmount: 799,
    });
    expect(prismaStub.order.update.mock.calls[0][0]).toMatchObject({
      where: { id: 50 },
      data: {
        paymentReceivedUtr: 'UTIBR52026100800123',
        paymentReceivedRef: 'RMT-91',
        paymentReceivedSource: 'DELHIVERY_REMITTANCE',
        paymentReceivedAmount: 799,
        paymentReceivedAt: new Date('2026-10-07T18:30:00.000Z'),
      },
    });
  });

  it('uses the UTR typed on the form when the AWB export has none, and says when it is missing', async () => {
    prismaStub.shipment.findFirst.mockResolvedValue({ id: 5, codAmount: 799, order: { id: 50, totalAmount: 799 } });
    const grid = [['Waybill Number', 'COD Amount'], ['30100810011111', '799']];

    await importDelhiveryRemittance('awbs.csv', [sheet('a', grid)], { utr: 'UTR-FROM-FORM', remittedAt: '09-10-2026' });
    expect(prismaStub.order.update.mock.calls[0][0].data.paymentReceivedUtr).toBe('UTR-FROM-FORM');

    const withoutUtr = await importDelhiveryRemittance('awbs.csv', [sheet('a', grid)]);
    expect(withoutUtr.notes.join(' ')).toMatch(/had no UTR/);
  });

  it('explains a file with no AWB or order column', async () => {
    const result = await importDelhiveryRemittance('x.csv', [sheet('x', [['Foo', 'Bar'], ['1', '2']])]);
    expect(result.matchedCount).toBe(0);
    expect(result.notes[0]).toMatch(/No Waybill \/ AWB or Order Number column/);
  });

  it('skips duplicate AWBs already remitted in database and duplicate rows within the same batch', async () => {
    prismaStub.shipment.findFirst.mockImplementation(async ({ where }: any) => {
      const match = where.OR.find((c: any) => c.waybillNumber);
      if (!match) return null;
      if (match.waybillNumber === '30100810011111') {
        return {
          id: 5,
          codAmount: 799,
          codRemitted: true,
          codRemittedAmount: 799,
          order: { id: 50, totalAmount: 799 },
        };
      }
      if (match.waybillNumber === '30100810022222') {
        return {
          id: 6,
          codAmount: 1200,
          codRemitted: false,
          codRemittedAmount: null,
          order: { id: 60, totalAmount: 1200 },
        };
      }
      return null;
    });

    const result = await importDelhiveryRemittance('remit_dupes.csv', [
      sheet('remit', [
        ['Waybill Number', 'COD Amount', 'Remittance Number', 'Bank Transaction ID'],
        ['30100810011111', '799.00', 'RMT-1', 'UTR-1'],
        ['30100810022222', '1200.00', 'RMT-1', 'UTR-1'],
        ['30100810022222', '1200.00', 'RMT-1', 'UTR-1'],
      ]),
    ]);

    expect(result.matchedCount).toBe(1);
    expect(result.skippedDuplicates).toEqual([
      '30100810011111',
      '30100810022222 (duplicate row in file)',
    ]);
    expect(prismaStub.shipment.update).toHaveBeenCalledTimes(1);
    expect(prismaStub.shipment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 6 },
        data: expect.objectContaining({ codRemittedAmount: 1200 }),
      })
    );
  });

  it('infers remittance number and processed date from Delhivery zip filename like R3359352026101200000.zip', async () => {
    prismaStub.shipment.findFirst.mockResolvedValue({
      id: 7,
      codAmount: 719.1,
      order: { id: 70, totalAmount: 719.1, shopifyOrderName: '#26YOU5840' },
    });

    const result = await importDelhiveryRemittance('R3359352026101200000.zip', [
      sheet('transactions', [
        ['Description', 'Payment Mode', 'COD Amount', 'Waybill Number', 'Order Number'],
        ['package', 'COD', '719.10', '30100810010975', '26YOU5840'],
      ]),
    ]);

    expect(result.matchedCount).toBe(1);
    expect(result.remittanceNumber).toBe('R3359352026101200000');
    expect(result.totalRemittance).toBe(719.1);
    expect(result.state).toBe('Pending');
    expect(prismaStub.shipment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: expect.objectContaining({
          codRemittanceRef: 'R3359352026101200000',
          codRemittedAmount: 719.1,
        }),
      })
    );
  });
});

describe('Delhivery charges (wallet ledger)', () => {
  it('takes the latest debit per AWB and leg, ignores refunds, and routes reverse AWBs to returns', async () => {
    prismaStub.return.findFirst.mockImplementation(async ({ where }: any) =>
      where.returnWaybillNumber === '30100810077777' ? { id: 9 } : null
    );
    prismaStub.shipment.findFirst.mockImplementation(async ({ where }: any) =>
      where.waybillNumber === '30100810011111' ? { id: 5 } : null
    );

    const deductions = sheet('Deductions', [
      ['Date & Time', 'Miles', 'AWB', 'Type', 'Description'],
      ['01-10-2026 10:00', '70.22', '30100810011111', 'Debit', 'Forward manifest estimate'],
      ['04-10-2026 18:00', '82.60', '30100810011111', 'Debit', 'Forward final charge after delivery'],
      ['06-10-2026 09:00', '64.90', '30100810011111', 'Debit', 'RTO charge'],
      ['07-10-2026 09:00', '47.20', '30100810077777', 'Debit', 'DTO pickup'],
      ['07-10-2026 09:00', '55.00', '30100899999999', 'Debit', 'Forward'],
    ]);
    const refunds = sheet('Refunds', [
      ['Date & Time', 'Miles', 'AWB', 'Type', 'Description'],
      ['04-10-2026 17:59', '70.22', '30100810011111', 'Credit', 'Reversal of estimate'],
    ]);
    const summary = sheet('Summary', [['Total', 'Value'], ['Debits', '999']]);

    const result = await importDelhiveryCharges('ledger.xlsx', [deductions, refunds, summary]);

    const shipmentWrites = prismaStub.shipment.update.mock.calls.map((c: any[]) => c[0].data);
    expect(shipmentWrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ forwardCharge: 82.6, shippingCostSource: 'ACTUAL' }),
        expect.objectContaining({ rtoCharge: 64.9, rtoChargeSource: 'ACTUAL' }),
      ])
    );
    expect(prismaStub.return.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { shippingCharge: 47.2, shippingCostSource: 'ACTUAL' },
    });
    expect(result.matchedCount).toBe(2);
    expect(result.unmatched).toEqual(['30100899999999']);
  });

  it('splits an invoice-backup row that has its own RTO charge column', async () => {
    prismaStub.return.findFirst.mockResolvedValue(null);
    prismaStub.shipment.findFirst.mockResolvedValue({ id: 5 });

    await importDelhiveryCharges('backup.csv', [
      sheet('b', [
        ['Waybill', 'Total Amount', 'RTO Charges', 'Zone', 'Charged Weight'],
        ['30100810011111', '150.00', '60.00', 'D', '0.5'],
      ]),
    ]);

    const writes = prismaStub.shipment.update.mock.calls.map((c: any[]) => c[0].data);
    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rtoCharge: 60, chargedZone: 'D', billedWeightGrams: 500 }),
        expect.objectContaining({ forwardCharge: 90 }),
      ])
    );
  });
});

describe('Gateway settlement report', () => {
  const prepaid = { id: 70, paymentMethod: 'Pre-paid', totalAmount: 754.52 };

  it('sums split rows per order and records the settlement UTR and fees', async () => {
    prismaStub.order.findMany.mockImplementation(async ({ where }: any) =>
      where.OR.some((c: any) => c.shopifyOrderName === '#26YOU5913' || c.gokwikPaymentId === 'KWIK123') ? [prepaid] : []
    );

    const result = await importGatewaySettlement('phonepe.csv', [
      sheet('s', [
        ['Merchant Order Id', 'Transaction Id', 'Settlement Amount', 'Fee', 'GST', 'Settlement UTR', 'Settlement Date', 'Status'],
        ['26YOU5913', 'T1', '500.00', '8.00', '1.44', 'SBIN226281234567', '09-10-2026', 'SETTLED'],
        ['', 'KWIK123', '236.96', '3.80', '0.68', 'SBIN226281234567', '09-10-2026', 'SETTLED'],
        ['26YOU9999', 'T9', '100.00', '1.00', '0.18', 'SBIN2', '09-10-2026', 'SETTLED'],
        ['26YOU5913', 'T2', '10.00', '0', '0', 'X', '09-10-2026', 'PENDING'],
      ]),
    ]);

    expect(result.matchedCount).toBe(1);
    expect(result.unmatched).toEqual(['26YOU9999']);
    expect(result.notes.join(' ')).toMatch(/1 row\(s\) were not settled yet/);
    expect(prismaStub.order.update.mock.calls[0][0]).toMatchObject({
      where: { id: 70 },
      data: {
        paymentReceivedAmount: 736.96,
        gatewayFee: 13.92,
        paymentReceivedUtr: 'SBIN226281234567',
        paymentReceivedSource: 'PG_SETTLEMENT_REPORT',
      },
    });
  });

  it('skips COD orders, whose money comes from the Delhivery remittance', async () => {
    prismaStub.order.findMany.mockResolvedValue([{ id: 71, paymentMethod: 'COD', totalAmount: 500 }]);

    const result = await importGatewaySettlement('s.csv', [
      sheet('s', [['Order Id', 'UTR', 'Amount'], ['26YOU1', 'U1', '500']]),
    ]);

    expect(result.matchedCount).toBe(0);
    expect(prismaStub.order.update).not.toHaveBeenCalled();
    expect(result.notes.join(' ')).toMatch(/matched COD orders/);
  });
});

describe('review fixes', () => {
  it('does not add a "Fee (incl. GST)" column twice', async () => {
    prismaStub.order.findMany.mockResolvedValue([{ id: 70, paymentMethod: 'Pre-paid', totalAmount: 1000 }]);
    await importGatewaySettlement('s.csv', [
      sheet('s', [['Order Id', 'Settlement UTR', 'Settlement Amount', 'Fee (incl. GST)'], ['26YOU1', 'U1', '976.40', '23.60']]),
    ]);
    expect(prismaStub.order.update.mock.calls[0][0].data.gatewayFee).toBe(23.6);
  });

  it('does not lend the typed UTR to a file that covers several remittances', async () => {
    prismaStub.shipment.findFirst.mockResolvedValue({ id: 5, codAmount: 799, order: { id: 50, totalAmount: 799 } });
    const result = await importDelhiveryRemittance(
      'month.csv',
      [sheet('m', [['Waybill Number', 'Remittance Number', 'COD Amount'], ['1', 'RMT-1', '799'], ['2', 'RMT-2', '799']])],
      { utr: 'UTR-OF-RMT-1' }
    );
    expect(prismaStub.order.update.mock.calls.every((c: any[]) => c[0].data.paymentReceivedUtr === null)).toBe(true);
    expect(result.notes.join(' ')).toMatch(/covers 2 remittances/);
  });

  it('attaches nothing when a reference matches more than one order', async () => {
    prismaStub.order.findMany.mockResolvedValue([
      { id: 70, paymentMethod: 'Pre-paid', totalAmount: 500 },
      { id: 71, paymentMethod: 'Pre-paid', totalAmount: 500 },
    ]);
    const result = await importGatewaySettlement('s.csv', [sheet('s', [['Transaction Id', 'UTR', 'Amount'], ['12345', 'U1', '500']])]);
    expect(result.matchedCount).toBe(0);
    expect(result.unmatched).toEqual(['12345']);
    expect(prismaStub.order.update).not.toHaveBeenCalled();
  });

  it('does not decide the cost leg from a Status column', async () => {
    prismaStub.return.findFirst.mockResolvedValue(null);
    prismaStub.shipment.findFirst.mockResolvedValue({ id: 5 });
    await importDelhiveryCharges('backup.csv', [sheet('b', [['Waybill', 'Total Amount', 'Status'], ['301', '150.00', 'RTO']])]);
    expect(prismaStub.shipment.update.mock.calls[0][0].data).toMatchObject({ forwardCharge: 150, shippingCostSource: 'ACTUAL' });
    expect(prismaStub.shipment.update.mock.calls[0][0].data.rtoCharge).toBeUndefined();
  });
});

describe('Carrier Remittance (Amazon Shipping / Ekart / Generic)', () => {
  it('marks matched waybills as remitted and captures UTR and amount', async () => {
    prismaStub.shipment.findFirst.mockImplementation(async ({ where }: any) =>
      where.OR.some((c: any) => c.waybillNumber === 'AMZ1001')
        ? { id: 10, codAmount: 950, codRemitted: false, order: { id: 60, totalAmount: 950, shopifyOrderName: '#26YOU5920' } }
        : null
    );

    const result = await importCarrierRemittance(
      'AMAZON_SHIPPING',
      'amazon_remit.csv',
      [
        sheet('amazon', [
          ['Waybill Number', 'COD Amount', 'Remittance Number', 'UTR Number', 'Payment Date'],
          ['AMZ1001', '950.00', 'AMZ-REM-01', 'HDFCN99281726', '12-10-2026'],
          ['AMZ9999', '500.00', 'AMZ-REM-01', 'HDFCN99281726', '12-10-2026'],
        ]),
      ]
    );

    expect(result.matchedCount).toBe(1);
    expect(result.unmatched).toEqual(['AMZ9999']);
    expect(result.totalRemittance).toBe(950);
    expect(prismaStub.shipment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 10 },
        data: expect.objectContaining({
          codRemitted: true,
          codRemittedAmount: 950,
          codRemittanceRef: 'AMZ-REM-01',
          status: 'DELIVERED',
        }),
      })
    );
  });

  it('skips duplicate tracking IDs if already remitted', async () => {
    prismaStub.shipment.findFirst.mockResolvedValue({
      id: 11,
      codAmount: 600,
      codRemitted: true,
      codRemittedAmount: 600,
      order: { id: 61, totalAmount: 600 },
    });

    const result = await importCarrierRemittance(
      'EKART_SHIPPING',
      'ekart_remit.csv',
      [
        sheet('ekart', [
          ['Waybill Number', 'COD Amount', 'Remittance Number'],
          ['EKART1001', '600.00', 'EKART-BATCH-1'],
        ]),
      ]
    );

    expect(result.matchedCount).toBe(0);
    expect(result.skippedDuplicates).toEqual(['EKART1001']);
    expect(prismaStub.shipment.update).not.toHaveBeenCalled();
  });
});

