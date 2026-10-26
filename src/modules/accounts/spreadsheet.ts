/**
 * Reading the reports the accounts team downloads from Delhivery One and the
 * payment gateways (Excel .xlsx or CSV), whatever their exact column names.
 *
 * Every sheet becomes { headers, rows } with rows keyed by the original
 * header text. Columns are then found with pickColumn() by a list of
 * patterns tried in priority order, so "Bank Transaction ID", "UTR" and
 * "utr_no" all resolve without per-vendor code.
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  sourceFile?: string;
  isZipExtracted?: boolean;
}

/** Lower-case, punctuation collapsed to single spaces: "Bank_Txn-ID " → "bank txn id". */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The first header matching the highest-priority pattern. Patterns are
 * tested against the normalized header, one pattern at a time, so an earlier
 * (more specific) pattern always wins over a later, looser one.
 */
export function pickColumn(headers: string[], patterns: RegExp[]): string | undefined {
  const normalized = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  for (const pattern of patterns) {
    const hit = normalized.find((h) => pattern.test(h.norm));
    if (hit) return hit.raw;
  }
  return undefined;
}

/** "₹1,299.50", "1299.5 Dr", "(45.00)" → number; blank or text → null. */
export function parseAmount(value?: string | null): number | null {
  if (value === undefined || value === null) return null;
  // "Rs." keeps a dot that would otherwise be read as the decimal point.
  const text = String(value)
    .trim()
    .replace(/^(rs\.?|inr|₹)\s*/i, '')
    .replace(/\s*(dr|cr)\.?$/i, '');
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || /^-/.test(text);
  const digits = text.replace(/[^0-9.]/g, '');
  if (!digits || !/\d/.test(digits)) return null;
  const amount = parseFloat(digits);
  if (Number.isNaN(amount)) return null;
  return Math.round((negative ? -amount : amount) * 100) / 100;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function istDate(year: number, month: number, day: number, time = '00:00:00'): Date | null {
  const yyyy = year < 100 ? 2000 + year : year;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(
    `${yyyy}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${time}+05:30`
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Dates as Indian reports write them. Day comes before month ("08/10/2026" is
 * 8 October), times are IST, and Excel serial numbers are accepted.
 */
export function parseDateLoose(value?: string | null): Date | null {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;

  const time = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  let timePart = '00:00:00';
  if (time) {
    let hours = parseInt(time[1], 10);
    if (time[4]) {
      const pm = time[4].toLowerCase() === 'pm';
      if (pm && hours < 12) hours += 12;
      if (!pm && hours === 12) hours = 0;
    }
    timePart = `${String(hours).padStart(2, '0')}:${time[2]}:${time[3] || '00'}`;
  }

  // ISO with an explicit offset or Z: trust it as is.
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  let m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return istDate(+m[1], +m[2], +m[3], timePart);
  m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) return istDate(+m[3], +m[2], +m[1], timePart);
  m = text.match(/^(\d{1,2})[-\s/]([a-z]{3,4})[a-z]*[-\s/,]+(\d{2,4})/i);
  if (m && MONTHS[m[2].toLowerCase()]) return istDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1], timePart);
  m = text.match(/^([a-z]{3,4})[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i);
  if (m && MONTHS[m[1].toLowerCase()]) return istDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2], timePart);
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    // Excel serial date (days since 1899-12-30).
    const serial = parseFloat(text);
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** RFC 4180 CSV / TSV / semicolon files, quoted fields and "" escapes included. */
export function parseDelimited(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] || '';
  const delimiter = firstLine.includes('\t')
    ? '\t'
    : (firstLine.match(/;/g)?.length || 0) > (firstLine.match(/,/g)?.length || 0)
      ? ';'
      : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((cell) => cell.trim())).filter((r) => r.some((cell) => cell !== ''));
}

/**
 * Turn a grid into keyed rows. Vendor exports often put a title or a date
 * range above the real header, so the header is the first of the top rows
 * that has (nearly) as many filled cells as the widest of them.
 */
export function gridToSheet(name: string, grid: string[][]): ParsedSheet {
  const top = grid.slice(0, 10);
  const widest = Math.max(0, ...top.map((r) => r.filter(Boolean).length));
  const headerIndex = top.findIndex((r) => r.filter(Boolean).length >= Math.max(2, Math.ceil(widest * 0.6)));
  if (headerIndex === -1) return { name, headers: [], rows: [] };

  const seen = new Map<string, number>();
  const headers = grid[headerIndex].map((h, i) => {
    const base = h || `Column ${i + 1}`;
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count ? `${base} (${count + 1})` : base;
  });
  const rows = grid
    .slice(headerIndex + 1)
    .filter((r) => r.some(Boolean))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { name, headers, rows };
}

/**
 * exceljs hands back a date cell's wall-clock time as if it were UTC. The
 * reports come from Indian systems, so that wall-clock time is IST.
 */
function excelDateAsIst(value: Date): Date {
  return new Date(value.getTime() - 5.5 * 3600 * 1000);
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return excelDateAsIst(value).toISOString();
  if (typeof value === 'object') {
    const v = value as any;
    if (v.richText) return v.richText.map((part: any) => part.text).join('');
    if (v.result !== undefined) return cellText(v.result);
    if (v.text !== undefined) return String(v.text);
    if (v.error) return '';
    return '';
  }
  return String(value);
}

const MAX_ZIP_ENTRIES = 50;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB safety limit
const MAX_XLSX_ENTRY_BYTES = 25 * 1024 * 1024; // 25 MB max per embedded XLSX

async function readZipArchive(content: Buffer): Promise<ParsedSheet[]> {
  const zip = await JSZip.loadAsync(content);
  if (Object.keys(zip.files).length > MAX_ZIP_ENTRIES) {
    throw new Error(`Zip archive contains too many files (exceeds limit of ${MAX_ZIP_ENTRIES} entries).`);
  }
  const sheets: ParsedSheet[] = [];
  let totalExtractedBytes = 0;
  let entryCount = 0;

  for (const [entryPath, file] of Object.entries(zip.files)) {
    if (file.dir || entryPath.startsWith('__MACOSX/') || /(^|\/)\.[^/]+/.test(entryPath)) {
      continue;
    }
    entryCount++;
    if (entryCount > MAX_ZIP_ENTRIES) {
      throw new Error(`Zip archive contains too many files (exceeds limit of ${MAX_ZIP_ENTRIES} entries).`);
    }

    // Zip Slip / Directory traversal prevention: inspect path segments so valid filenames with dots (e.g. report..csv) are preserved
    const rawName = (file as any).unsafeOriginalName || entryPath;
    const segments = entryPath.split(/[\/\\]/);
    const rawSegments = rawName.split(/[\/\\]/);
    if (
      segments.includes('..') ||
      rawSegments.includes('..') ||
      entryPath.startsWith('/') ||
      entryPath.startsWith('\\') ||
      rawName.startsWith('/') ||
      rawName.startsWith('\\')
    ) {
      continue;
    }

    const lower = entryPath.toLowerCase();
    const baseName = entryPath.split('/').pop() || entryPath;

    // Pre-decompression Zip Bomb protection: inspect header uncompressedSize before decompressing
    const declaredSize = typeof (file as any)._data?.uncompressedSize === 'number' ? (file as any)._data.uncompressedSize : 0;
    if (declaredSize > MAX_UNCOMPRESSED_BYTES || (totalExtractedBytes + declaredSize) > MAX_UNCOMPRESSED_BYTES) {
      throw new Error('Zip archive uncompressed content exceeds the maximum allowed limit (50 MB).');
    }

    if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
      const text = await file.async('text');
      totalExtractedBytes += Buffer.byteLength(text, 'utf8');
      if (totalExtractedBytes > MAX_UNCOMPRESSED_BYTES) {
        throw new Error('Zip archive uncompressed content exceeds the maximum allowed limit (50 MB).');
      }
      const parsed = gridToSheet(baseName, parseDelimited(text));
      if (parsed.headers.length > 0) {
        parsed.sourceFile = baseName;
        parsed.isZipExtracted = true;
        sheets.push(parsed);
      }
    } else if (lower.endsWith('.xlsx')) {
      if (declaredSize > MAX_XLSX_ENTRY_BYTES) {
        throw new Error('Embedded XLSX file exceeds safe size limit of 25 MB.');
      }
      const buf = await file.async('nodebuffer');
      totalExtractedBytes += buf.length;
      if (totalExtractedBytes > MAX_UNCOMPRESSED_BYTES) {
        throw new Error('Zip archive uncompressed content exceeds the maximum allowed limit (50 MB).');
      }

      // Check inner XLSX package uncompressed XML size to prevent nested zip bomb expansion in ExcelJS
      const innerZip = await JSZip.loadAsync(buf);
      let innerUncompressedTotal = 0;
      for (const innerFile of Object.values(innerZip.files)) {
        const innerSize = typeof (innerFile as any)._data?.uncompressedSize === 'number' ? (innerFile as any)._data.uncompressedSize : 0;
        innerUncompressedTotal += innerSize;
        if (innerUncompressedTotal > MAX_UNCOMPRESSED_BYTES) {
          throw new Error('Embedded XLSX expanded XML content exceeds the maximum allowed limit (50 MB).');
        }
      }

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buf as any);
      workbook.eachSheet((worksheet) => {
        const grid: string[][] = [];
        const width = worksheet.columnCount;
        worksheet.eachRow({ includeEmpty: false }, (row) => {
          const cells: string[] = [];
          for (let c = 1; c <= width; c++) {
            const cell = row.getCell(c);
            const mergedCopy = cell.isMerged && cell.master && cell.master.address !== cell.address;
            cells.push(mergedCopy ? '' : cellText(cell.value).trim());
          }
          grid.push(cells);
        });
        const parsed = gridToSheet(worksheet.name, grid);
        if (parsed.headers.length > 0) {
          parsed.sourceFile = baseName;
          parsed.isZipExtracted = true;
          sheets.push(parsed);
        }
      });
    }
  }
  return sheets;
}

/**
 * Read an uploaded report. .xlsx, .zip, and .csv/.tsv/.txt are supported; an old
 * binary .xls must be re-saved as .xlsx or .csv first.
 */
export async function readSpreadsheet(fileName: string, content: Buffer): Promise<ParsedSheet[]> {
  const isZipMagic = content.length > 3 && content[0] === 0x50 && content[1] === 0x4b; // "PK"
  if (/\.xls$/i.test(fileName) && !isZipMagic) {
    throw new Error('Old .xls files cannot be read. Open the file and save it as .xlsx or .csv, then upload again.');
  }

  // 1. Direct ZIP archive (e.g. R3359352026101200000.zip downloaded from Delhivery ONE)
  if (/\.zip$/i.test(fileName)) {
    const sheets = await readZipArchive(content);
    if (!sheets.length) {
      throw new Error('The uploaded zip archive contains no CSV or Excel spreadsheets.');
    }
    return sheets;
  }

  // 2. Excel OpenXML (.xlsx)
  if (/\.xlsx$/i.test(fileName) || (isZipMagic && !/\.(csv|tsv|txt)$/i.test(fileName))) {
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(content as any);
      const sheets: ParsedSheet[] = [];
      workbook.eachSheet((worksheet) => {
        const grid: string[][] = [];
        // Read once: exceljs recomputes columnCount by walking every row, so
        // using it in the loop condition made large ledgers take minutes.
        const width = worksheet.columnCount;
        worksheet.eachRow({ includeEmpty: false }, (row) => {
          const cells: string[] = [];
          for (let c = 1; c <= width; c++) {
            const cell = row.getCell(c);
            // Every cell of a merged range repeats the master's text; only the
            // master keeps it, so a merged title row is not mistaken for a header.
            const mergedCopy = cell.isMerged && cell.master && cell.master.address !== cell.address;
            cells.push(mergedCopy ? '' : cellText(cell.value).trim());
          }
          grid.push(cells);
        });
        sheets.push(gridToSheet(worksheet.name, grid));
      });
      const valid = sheets.filter((sheet) => sheet.headers.length > 0);
      if (valid.length > 0) return valid;
    } catch {
      // If ExcelJS failed on a generic zip container, try JSZip archive extraction fallback
      if (isZipMagic) {
        const zipSheets = await readZipArchive(content).catch(() => []);
        if (zipSheets.length > 0) return zipSheets;
      }
    }
  }

  // 3. Delimited text (.csv, .tsv, .txt)
  const sheet = gridToSheet(fileName, parseDelimited(content.toString('utf8')));
  return sheet.headers.length > 0 ? [sheet] : [];
}
