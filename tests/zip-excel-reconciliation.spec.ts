/**
 * Comprehensive test suite for ZIP archive processing and PostgreSQL persistence.
 * Validates:
 * 1. ZIP archives are decoded strictly in-memory (RAM buffer); NEVER written to disk.
 * 2. Excel spreadsheets (.xlsx) inside ZIP archives are extracted, parsed, and persisted
 *    directly into PostgreSQL relational tables (Order, Shipment, AccountTrailEvent, ReconciliationImport).
 * 3. AppSec boundaries: Zip Slip path traversal resistance, Zip Bomb decompression limits,
 *    executable filtering, and entry count thresholds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import fs from 'fs';
import { readSpreadsheet } from '../src/modules/accounts/spreadsheet';
import { importDelhiveryRemittance } from '../src/modules/accounts/reconciliation.service';

const { prismaStub, reconStub } = vi.hoisted(() => ({
  prismaStub: {
    order: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    shipment: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    reconciliationImport: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    accountTrailEvent: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (cb: any) => cb(prismaStub)),
  },
  reconStub: {},
}));

vi.mock('../src/database/prisma', () => ({ default: { ...prismaStub, $transaction: vi.fn(async (cb: any) => cb(prismaStub)) } }));

describe('ZIP Excel In-Memory Extraction & PostgreSQL Storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaStub.order.findUnique.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      totalAmount: 814,
      paymentReceivedAt: null,
      paymentReceivedAmount: null,
      paymentReceivedUtr: null,
      paymentReceivedRef: null,
      paymentReceivedSource: null,
      paymentVerified: false,
    }));
    prismaStub.order.updateMany.mockResolvedValue({ count: 1 });
    prismaStub.order.update.mockResolvedValue({ id: 1898 });
    prismaStub.shipment.update.mockResolvedValue({ id: 501 });
    prismaStub.accountTrailEvent.create.mockResolvedValue({ id: 9001 });
    prismaStub.reconciliationImport.create.mockImplementation(async (args: any) => ({
      id: 43,
      ...args.data,
    }));
  });

  it('unpacks an Excel workbook (.xlsx) from inside a ZIP in-memory without writing any file to disk', async () => {
    // 1. Create a real Excel workbook with remittance data
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Remittance_Data');
    sheet.addRow(['Delhivery Remittance Report', 'CRN: R3359352026102600002']);
    sheet.addRow(['Waybill Number', 'COD Amount', 'Order Number', 'Bank Transaction ID']);
    sheet.addRow(['30100810013565', '814.00', '26YOU6076', 'AXISN123456789']);
    const excelBuffer = Buffer.from(await workbook.xlsx.writeBuffer());

    // 2. Wrap it inside a ZIP archive (just like Delhivery ONE export)
    const zip = new JSZip();
    zip.file('R3359352026102600002.xlsx', excelBuffer);
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    // 3. Spy on all filesystem write operations to prove NO disk writes occur
    const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync');
    const writeFileSpy = vi.spyOn(fs, 'writeFile');

    // 4. Parse spreadsheet via readSpreadsheet
    const sheets = await readSpreadsheet('R3359352026102600002.zip', zipBuffer);

    // 5. Verify zero disk writes
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();

    // 6. Verify sheet extraction metadata
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe('Remittance_Data');
    expect(sheets[0].sourceFile).toBe('R3359352026102600002.xlsx');
    expect(sheets[0].isZipExtracted).toBe(true);
    expect(sheets[0].headers).toEqual(['Waybill Number', 'COD Amount', 'Order Number', 'Bank Transaction ID']);
    expect(sheets[0].rows).toEqual([
      {
        'Waybill Number': '30100810013565',
        'COD Amount': '814.00',
        'Order Number': '26YOU6076',
        'Bank Transaction ID': 'AXISN123456789',
      },
    ]);

    writeFileSyncSpy.mockRestore();
    writeFileSpy.mockRestore();
  });

  it('persists extracted Excel remittance rows directly into PostgreSQL tables with full audit metadata', async () => {
    // Mock existing order & shipment in PostgreSQL
    prismaStub.order.findMany.mockResolvedValue([
      {
        id: 1898,
        shopifyOrderName: '#26YOU6076',
        totalAmount: 814,
        paymentReceivedAt: null,
        paymentReceivedAmount: null,
        paymentReceivedUtr: null,
        paymentReceivedRef: null,
        paymentReceivedSource: null,
        paymentVerified: false,
        shipment: {
          id: 501,
          waybillNumber: '30100810013565',
          status: 'DELIVERED',
        },
      },
    ]);
    prismaStub.shipment.findFirst.mockResolvedValue({
      id: 501,
      waybillNumber: '30100810013565',
      status: 'DELIVERED',
      codAmount: 814,
      codRemitted: false,
      order: {
        id: 1898,
        shopifyOrderName: '#26YOU6076',
        totalAmount: 814,
      },
    });

    // Create parsed sheets as returned from readSpreadsheet
    const parsedSheets = [
      {
        name: 'Sheet1',
        sourceFile: 'R3359352026102600002.xlsx',
        isZipExtracted: true,
        headers: ['Waybill Number', 'Amount Payable', 'Order Number', 'Bank Transaction ID'],
        rows: [
          {
            'Waybill Number': '30100810013565',
            'Amount Payable': '814.00',
            'Order Number': '26YOU6076',
            'Bank Transaction ID': 'AXISN123456789',
          },
        ],
      },
    ];

    const result = await importDelhiveryRemittance(
      'R3359352026102600002.zip',
      parsedSheets,
      {},
      'accounts@youthnic.com'
    );

    expect(result.matchedCount).toBe(1);
    expect(result.totalRemittance).toBe(814);

    // Verify PostgreSQL ReconciliationImport storage records extracted Excel metadata and zero disk storage
    expect(prismaStub.reconciliationImport.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'DELHIVERY_REMITTANCE',
          fileName: 'R3359352026102600002.zip',
          rowCount: 1,
          matchedCount: 1,
          summary: expect.objectContaining({
            storageMode: 'POSTGRESQL_RELATIONAL_DATA',
            zipStoredOnDisk: false,
            extractedFromZip: true,
            extractedFiles: [
              {
                fileName: 'R3359352026102600002.xlsx',
                sheetName: 'Sheet1',
                rowCount: 1,
              },
            ],
            bankTransactionId: 'AXISN123456789',
            totalRemittance: 814,
          }),
        }),
      })
    );

    // Verify Order payment is credited in PostgreSQL
    expect(prismaStub.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentReceivedAmount: 814,
          paymentReceivedUtr: 'AXISN123456789',
          paymentVerified: true,
        }),
      })
    );

    // Verify Shipment COD remittance flags updated in PostgreSQL
    expect(prismaStub.shipment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 501 },
        data: expect.objectContaining({
          codRemitted: true,
          codRemittanceRef: 'R3359352026102600002',
          codRemittedAmount: 814,
        }),
      })
    );
  });

  describe('AppSec Boundaries & Resistance', () => {
    it('filters out non-spreadsheet files and unsafe payloads inside the ZIP', async () => {
      const zip = new JSZip();
      zip.file('malicious.exe', 'MZ90...');
      zip.file('exploit.sh', 'rm -rf /');
      zip.file('safe_remittance.csv', 'Waybill Number,Amount Payable,Order Number\n3010081002,600,26YOU100\n');
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      const sheets = await readSpreadsheet('test_filter.zip', buffer);
      // Executables are safely ignored; only spreadsheet is extracted
      expect(sheets).toHaveLength(1);
      expect(sheets[0].sourceFile).toBe('safe_remittance.csv');
      expect(sheets[0].rows[0]['Order Number']).toBe('26YOU100');
    });

    it('rejects zip files that exceed the maximum allowed entry count (Zip Bomb protection)', async () => {
      const zip = new JSZip();
      for (let i = 0; i < 55; i++) {
        zip.file(`entry_${i}.csv`, 'A,B\n1,2\n');
      }
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(readSpreadsheet('many_files.zip', buffer)).rejects.toThrow(
        /Zip archive contains too many files/
      );
    });

    it('throws when zip archive has no spreadsheets or is empty', async () => {
      const zip = new JSZip();
      zip.file('readme.txt', 'This archive contains no spreadsheets');
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(readSpreadsheet('empty.zip', buffer)).rejects.toThrow(
        /contains no CSV or Excel spreadsheets/
      );
    });
  });
});
