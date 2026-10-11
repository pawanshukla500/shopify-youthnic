/**
 * Reading uploaded reports: quoted CSV, title rows above the header, Indian
 * dates, rupee amounts, and real .xlsx files.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  gridToSheet,
  normalizeHeader,
  parseAmount,
  parseDateLoose,
  parseDelimited,
  pickColumn,
  readSpreadsheet,
} from '../src/modules/accounts/spreadsheet';

describe('parseDelimited', () => {
  it('keeps commas inside quoted fields and unescapes doubled quotes', () => {
    const rows = parseDelimited('AWB,Amount,Address\r\n"301008",\"1,299.00\","Flat 4C, ""Lake View"""\r\n');
    expect(rows).toEqual([
      ['AWB', 'Amount', 'Address'],
      ['301008', '1,299.00', 'Flat 4C, "Lake View"'],
    ]);
  });

  it('detects tab and semicolon delimiters and strips a BOM', () => {
    expect(parseDelimited('﻿a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseDelimited('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('gridToSheet', () => {
  it('finds the header below title rows', () => {
    const sheet = gridToSheet('x', [
      ['Remittance Report'],
      ['01-10-2026 to 31-10-2026'],
      ['Waybill Number', 'COD Amount', 'Order Number'],
      ['301', '799', '26YOU1'],
    ]);
    expect(sheet.headers).toEqual(['Waybill Number', 'COD Amount', 'Order Number']);
    expect(sheet.rows).toEqual([{ 'Waybill Number': '301', 'COD Amount': '799', 'Order Number': '26YOU1' }]);
  });
});

describe('column matching', () => {
  it('normalizes headers and prefers earlier patterns', () => {
    expect(normalizeHeader(' Bank_Txn-ID ')).toBe('bank txn id');
    const headers = ['COD Amount', 'Remitted Amount', 'Bank Transaction ID'];
    expect(pickColumn(headers, [/remitted amount/, /amount/])).toBe('Remitted Amount');
    expect(pickColumn(headers, [/utr/, /bank transaction id/])).toBe('Bank Transaction ID');
    expect(pickColumn(headers, [/nothing/])).toBeUndefined();
  });
});

describe('parseAmount', () => {
  it('reads rupee formats', () => {
    expect(parseAmount('₹1,299.50')).toBe(1299.5);
    expect(parseAmount('Rs. 1,299.50')).toBe(1299.5);
    expect(parseAmount('INR 450')).toBe(450);
    expect(parseAmount('82.60 Dr')).toBe(82.6);
    expect(parseAmount('(45.00)')).toBe(-45);
    expect(parseAmount('-12')).toBe(-12);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('N/A')).toBeNull();
  });
});

describe('parseDateLoose', () => {
  it('reads day-first Indian dates as IST', () => {
    expect(parseDateLoose('08/10/2026')?.toISOString()).toBe('2026-10-07T18:30:00.000Z');
    expect(parseDateLoose('08-10-2026 14:05')?.toISOString()).toBe('2026-10-08T08:35:00.000Z');
    expect(parseDateLoose('8-Oct-2026')?.toISOString()).toBe('2026-10-07T18:30:00.000Z');
    expect(parseDateLoose('2026-10-08')?.toISOString()).toBe('2026-10-07T18:30:00.000Z');
    expect(parseDateLoose('Oct 8, 2026')?.toISOString()).toBe('2026-10-07T18:30:00.000Z');
  });

  it('keeps explicit-offset ISO timestamps and reads Excel serials', () => {
    expect(parseDateLoose('2026-10-08T10:00:00Z')?.toISOString()).toBe('2026-10-08T10:00:00.000Z');
    expect(parseDateLoose('46303')?.toISOString().slice(0, 10)).toBe('2026-10-08');
    expect(parseDateLoose('not a date')).toBeNull();
  });
});

describe('readSpreadsheet', () => {
  it('reads every sheet of an .xlsx file, numbers and dates included', async () => {
    const workbook = new ExcelJS.Workbook();
    const deductions = workbook.addWorksheet('Deductions');
    deductions.addRow(['Wallet ledger']);
    deductions.addRow(['AWB', 'Miles', 'Date & Time']);
    deductions.addRow(['30100810011111', 82.6, new Date('2026-10-02T06:00:00.000Z')]);
    workbook.addWorksheet('Empty');
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const sheets = await readSpreadsheet('ledger.xlsx', buffer);
    expect(sheets.map((s) => s.name)).toEqual(['Deductions']);
    // The cell reads 06:00; Indian reports mean 06:00 IST = 00:30 UTC.
    expect(sheets[0].rows).toEqual([
      { AWB: '30100810011111', Miles: '82.6', 'Date & Time': '2026-10-02T00:30:00.000Z' },
    ]);
  });

  it('ignores a merged title row when finding the header', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Remittance');
    sheet.addRow(['Remittance report October 2026', '', '', '']);
    sheet.mergeCells('A1:D1');
    sheet.addRow(['Waybill Number', 'COD Amount', 'Order Number', 'Bank Transaction ID']);
    sheet.addRow(['301', '799', '26YOU1', 'UTR1']);
    const sheets = await readSpreadsheet('r.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(sheets[0].headers).toEqual(['Waybill Number', 'COD Amount', 'Order Number', 'Bank Transaction ID']);
  });

  it('reads a large ledger quickly (no per-cell column recount)', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Deductions');
    sheet.addRow(['Date & Time', 'Miles', 'AWB', 'Type', 'Description']);
    for (let i = 0; i < 5000; i++) sheet.addRow([`02-10-2026 10:00`, 82.6, `3010081${String(i).padStart(7, '0')}`, 'Debit', 'Forward']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const started = Date.now();
    const sheets = await readSpreadsheet('ledger.xlsx', buffer);
    expect(sheets[0].rows).toHaveLength(5000);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reads a CSV upload and refuses old binary .xls', async () => {
    const sheets = await readSpreadsheet('r.csv', Buffer.from('AWB,Amount\n1,2\n'));
    expect(sheets[0].rows).toEqual([{ AWB: '1', Amount: '2' }]);
    await expect(readSpreadsheet('old.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))).rejects.toThrow(/save it as \.xlsx or \.csv/);
  });
});
