/**
 * Minimal Excel theme shared by the monthly accounts pack: one font, white sheet,
 * slate header row, thin light-grey borders, ₹ and date formats, frozen headers,
 * and an "Analytics" first tab of KPI blocks and small tables with in-cell data bars.
 */
import ExcelJS from 'exceljs';

const FONT = 'Calibri';
const SLATE = 'FF334155';
const BORDER = 'FFE2E8F0';
const MUTED = 'FF64748B';
const GREEN = 'FF15803D';
const RED = 'FFB91C1C';
export const MONEY = '#,##0.00';
export const INT = '#,##0';
export const PCT = '0.0%';
export const DATE = 'dd-mm-yyyy';

export type ColumnType = 'money' | 'int' | 'date' | 'pct' | 'text';
export interface Column {
  header: string;
  key: string;
  width?: number;
  type?: ColumnType;
}

const thin = { style: 'thin' as const, color: { argb: BORDER } };
const BOX = { top: thin, left: thin, bottom: thin, right: thin };
const FORMAT: Record<ColumnType, string | undefined> = { money: MONEY, int: INT, date: DATE, pct: PCT, text: undefined };

export function newWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Youthnic OMS';
  wb.created = new Date();
  return wb;
}

function styleHeader(row: ExcelJS.Row): void {
  row.height = 22;
  row.eachCell((cell) => {
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SLATE } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = BOX;
  });
}

function styleBody(row: ExcelJS.Row, columns: Column[], startCol = 1): void {
  columns.forEach((c, i) => {
    const cell = row.getCell(startCol + i);
    cell.font = { name: FONT, size: 10 };
    cell.border = BOX;
    const fmt = FORMAT[c.type || 'text'];
    if (fmt) cell.numFmt = fmt;
  });
}

/**
 * A plain data tab: header row, rows, optional total row (sums of the given keys).
 * `exact` keeps the columns exactly as given (the accounts team's upload format) with no extra total row.
 */
export function addDataSheet(
  wb: ExcelJS.Workbook,
  name: string,
  columns: Column[],
  rows: Array<Record<string, any>>,
  opts: { totals?: string[]; exact?: boolean } = {}
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || Math.max(10, c.header.length + 2) }));
  styleHeader(ws.getRow(1));
  for (const r of rows) styleBody(ws.addRow(r), columns);
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  if (!opts.exact && opts.totals?.length && rows.length) {
    const total = ws.addRow({});
    total.getCell(1).value = 'Total';
    for (const key of opts.totals) {
      const idx = columns.findIndex((c) => c.key === key) + 1;
      if (idx <= 0) continue;
      const letter = ws.getColumn(idx).letter;
      total.getCell(idx).value = { formula: `SUBTOTAL(109,${letter}2:${letter}${rows.length + 1})` } as any;
    }
    styleBody(total, columns);
    total.eachCell((cell) => (cell.font = { name: FONT, size: 10, bold: true }));
    total.getCell(1).border = { ...BOX, top: { style: 'thin', color: { argb: SLATE } } };
  }
  return ws;
}

export interface Kpi {
  label: string;
  value: number | string | null;
  type?: ColumnType;
  previous?: number | null; // previous month, for the change column
}
export interface AnalyticsTable {
  heading: string;
  columns: Column[];
  rows: Array<Record<string, any>>;
  barKey?: string; // column that gets an in-cell data bar
}
export interface AnalyticsSpec {
  title: string;
  subtitle: string;
  status?: { ok: boolean; text: string };
  kpis: Kpi[];
  tables: AnalyticsTable[];
  notes?: string[];
}

/** First tab of every workbook: title, KPI block with previous-month change, small tables. */
export function addAnalyticsSheet(wb: ExcelJS.Workbook, spec: AnalyticsSpec): ExcelJS.Worksheet {
  const ws = wb.addWorksheet('Analytics', { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 34 }, { width: 18 }, { width: 18 }, { width: 14 }, { width: 18 }, { width: 18 }, { width: 14 }, { width: 14 }];
  const title = ws.addRow([spec.title]);
  title.getCell(1).font = { name: FONT, size: 14, bold: true, color: { argb: SLATE } };
  ws.addRow([spec.subtitle]).getCell(1).font = { name: FONT, size: 10, color: { argb: MUTED } };
  if (spec.status) {
    const s = ws.addRow([spec.status.text]);
    s.getCell(1).font = { name: FONT, size: 10, bold: true, color: { argb: spec.status.ok ? GREEN : RED } };
  }
  ws.addRow([]);

  const kpiCols: Column[] = [
    { header: 'Measure', key: 'label' },
    { header: 'This month', key: 'value' },
    { header: 'Previous month', key: 'previous' },
    { header: 'Change', key: 'change', type: 'pct' },
  ];
  const head = ws.addRow(kpiCols.map((c) => c.header));
  styleHeader(head);
  for (const k of spec.kpis) {
    const change = typeof k.value === 'number' && typeof k.previous === 'number' && k.previous !== 0
      ? (k.value - k.previous) / Math.abs(k.previous)
      : null;
    const row = ws.addRow([k.label, k.value ?? '', k.previous ?? '', change ?? '']);
    styleBody(row, [{ header: '', key: '' }, { header: '', key: '', type: k.type }, { header: '', key: '', type: k.type }, { header: '', key: '', type: 'pct' }]);
  }

  for (const t of spec.tables) {
    ws.addRow([]);
    ws.addRow([t.heading]).getCell(1).font = { name: FONT, size: 11, bold: true, color: { argb: SLATE } };
    styleHeader(ws.addRow(t.columns.map((c) => c.header)));
    const first = ws.rowCount + 1;
    for (const r of t.rows) styleBody(ws.addRow(t.columns.map((c) => r[c.key] ?? '')), t.columns);
    const barIdx = t.barKey ? t.columns.findIndex((c) => c.key === t.barKey) + 1 : 0;
    if (barIdx > 0 && t.rows.length) {
      const letter = ws.getColumn(barIdx).letter;
      ws.addConditionalFormatting({
        ref: `${letter}${first}:${letter}${ws.rowCount}`,
        rules: [{ type: 'dataBar', priority: 1, cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF94A3B8' } } as any],
      });
    }
  }

  if (spec.notes?.length) {
    ws.addRow([]);
    for (const n of spec.notes) {
      const row = ws.addRow([n]);
      row.getCell(1).font = { name: FONT, size: 9, italic: true, color: { argb: MUTED } };
    }
  }
  return ws;
}

/** PASS/FAIL text colour in a column (no fills). */
export function colourStatus(ws: ExcelJS.Worksheet, key: string): void {
  const col = ws.getColumn(key);
  col.eachCell((cell, rowNumber) => {
    if (rowNumber === 1) return;
    const v = String(cell.value || '');
    if (/^(PASS|Reconciled|Matched)/.test(v)) cell.font = { name: FONT, size: 10, bold: true, color: { argb: GREEN } };
    else if (/^(FAIL|Short|Awaiting|Variance|Excess)/.test(v)) cell.font = { name: FONT, size: 10, bold: true, color: { argb: RED } };
  });
}
