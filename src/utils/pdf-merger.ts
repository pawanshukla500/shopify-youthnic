import invoiceService, { INVOICE_MAX_ROWS } from '../modules/invoice/invoice.service';
import { YOUTHNIC_LOGO_BASE64 } from '../modules/delhivery/label-logos';
import { config } from '../config';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import logger from './logger';

/**
 * Merges multiple PDF buffers into a single combined PDF buffer.
 * Preserves exact page dimensions (such as standard 4x6" thermal labels),
 * vector barcodes, text, and embedded fonts.
 */
export async function mergePdfBuffers(buffers: (Buffer | Uint8Array)[]): Promise<Buffer> {
  const mergedPdf = await PDFDocument.create();

  for (let i = 0; i < buffers.length; i++) {
    const buf = buffers[i];
    if (!buf || buf.length === 0) continue;

    try {
      const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
      const pageIndices = doc.getPageIndices();
      const pages = await mergedPdf.copyPages(doc, pageIndices);
      for (const page of pages) {
        mergedPdf.addPage(page);
      }
    } catch (err: any) {
      logger.warn('Failed to merge PDF buffer at index ' + i, { error: err.message });
    }
  }

  const mergedBytes = await mergedPdf.save();
  return Buffer.from(mergedBytes);
}

/**
 * Creates a clean, authentic 4x6" (100mm x 150mm) thermal label PDF page
 * for an order when an upstream carrier PDF download fails or is unavailable.
 * Ensures that bulk PDF merges are 100% complete with every single order included.
 */
export async function create4x6FallbackPdf(
  order: any,
  waybillNumber: string,
  courierName?: string | null
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  // 4x6 inches at 72 points per inch = 288 x 432 points
  const page = pdfDoc.addPage([288, 432]);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const black = rgb(0, 0, 0);

  // Outer border
  page.drawRectangle({
    x: 8,
    y: 8,
    width: 272,
    height: 416,
    borderColor: black,
    borderWidth: 1.5,
  });

  // Top header line: Seller & Carrier
  page.drawText('V B EXPORT (Youthnic)', { x: 16, y: 405, size: 9, font: fontBold, color: black });
  page.drawText(courierName || 'Youthnic Logistics', { x: 155, y: 405, size: 9, font: fontBold, color: black });

  page.drawLine({ start: { x: 8, y: 395 }, end: { x: 280, y: 395 }, thickness: 1, color: black });

  // AWB & Pin section
  page.drawText(`AWB: ${waybillNumber}`, { x: 16, y: 380, size: 12, font: fontBold, color: black });
  page.drawText(`PIN: ${order.customerPincode || '000000'}`, { x: 180, y: 380, size: 11, font: fontBold, color: black });

  page.drawLine({ start: { x: 8, y: 360 }, end: { x: 280, y: 360 }, thickness: 1, color: black });

  // Consignee section
  const isCod = order.paymentMethod === 'COD' || order.shipment?.paymentMode === 'COD';
  page.drawText('SHIP TO:', { x: 16, y: 345, size: 8, font: fontBold, color: black });
  page.drawText((order.customerName || 'Customer').substring(0, 30), { x: 60, y: 345, size: 9, font: fontBold, color: black });

  const addr = (order.customerAddress || order.customerAddress1 || '').substring(0, 90);
  page.drawText(addr.substring(0, 45), { x: 16, y: 330, size: 8, font: fontRegular, color: black });
  if (addr.length > 45) {
    page.drawText(addr.substring(45, 90), { x: 16, y: 318, size: 8, font: fontRegular, color: black });
  }

  const city = order.customerCity || '';
  const state = order.customerState || order.customerProvince || '';
  page.drawText(`${city.toUpperCase()} (${state.toUpperCase()}) - ${order.customerPincode || ''}`, {
    x: 16,
    y: 304,
    size: 8,
    font: fontBold,
    color: black,
  });
  page.drawText(`Phone: ${order.customerPhone || 'N/A'}`, { x: 16, y: 292, size: 8, font: fontRegular, color: black });

  // Payment Box
  page.drawRectangle({
    x: 180,
    y: 290,
    width: 92,
    height: 60,
    borderColor: black,
    borderWidth: 1,
  });
  page.drawText(isCod ? 'COD' : 'PREPAID', { x: 190, y: 332, size: 11, font: fontBold, color: black });
  page.drawText(`INR ${(order.totalAmount || 0).toFixed(2)}`, { x: 190, y: 315, size: 9, font: fontBold, color: black });
  page.drawText(isCod ? 'COLLECT CASH' : 'DO NOT COLLECT', { x: 190, y: 298, size: 7, font: fontBold, color: black });

  page.drawLine({ start: { x: 8, y: 280 }, end: { x: 280, y: 280 }, thickness: 1, color: black });

  // Seller info & Order
  page.drawText(`Order: ${order.shopifyOrderName}`, { x: 16, y: 265, size: 10, font: fontBold, color: black });
  page.drawText('Seller: Youthnic / Surat, Gujarat - 395002', { x: 16, y: 250, size: 7, font: fontRegular, color: black });

  page.drawLine({ start: { x: 8, y: 240 }, end: { x: 280, y: 240 }, thickness: 1, color: black });

  // Items
  page.drawText('ITEMS / DESCRIPTION', { x: 16, y: 228, size: 8, font: fontBold, color: black });
  let itemY = 214;
  const items = order.items || [];
  for (let i = 0; i < Math.min(items.length, 3); i++) {
    const it = items[i];
    const title = `${it.title || 'Item'} (${it.variantTitle || ''}) x${it.quantity || 1}`.substring(0, 48);
    page.drawText(title, { x: 16, y: itemY, size: 7.5, font: fontRegular, color: black });
    itemY -= 12;
  }

  page.drawLine({ start: { x: 8, y: 175 }, end: { x: 280, y: 175 }, thickness: 1, color: black });

  // Return address
  page.drawText('Return Address: 7004, HTC Market - 1, Anjana Farm, Surat - 395002', {
    x: 16,
    y: 160,
    size: 7,
    font: fontRegular,
    color: black,
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * 4x6" (288 x 432 pt) GST tax invoice PDF in the Velocity-style layout.
 * Uses the same numbers as the HTML invoice (invoiceService.buildInvoiceData).
 */
export async function create4x6InvoicePdf(
  order: any,
  _waybillNumber?: string,
  _courierName?: string | null
): Promise<Buffer> {
  const d = invoiceService.buildInvoiceData(order);
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([288, 432]);
  const reg = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const logo = await pdfDoc.embedPng(Buffer.from(YOUTHNIC_LOGO_BASE64.split(',')[1], 'base64'));

  const navy = rgb(0.17, 0.21, 0.38); // #2b3561
  const title = rgb(0.18, 0.23, 0.4); // #2e3a66
  const head = rgb(0.23, 0.24, 0.42); // #3a3e6b
  const muted = rgb(0.42, 0.45, 0.5); // #6b7280
  const rule = rgb(0.89, 0.9, 0.93); // #e3e6ee
  const cardBg = rgb(0.965, 0.969, 0.984); // #f6f7fb
  const white = rgb(1, 1, 1);
  const M = 12;
  const R = 276;
  type Font = typeof reg;

  // shortcut: Helvetica has no ₹ glyph, so the PDF prints "Rs."; embedding a TTF needs @pdf-lib/fontkit.
  const money = (n: number) => `Rs.${n.toFixed(2)}`;
  // Standard fonts only encode Latin-1; swap smart punctuation and replace anything else so drawText can't throw.
  // shortcut: non-Latin text (e.g. Devanagari) prints as "?" in the PDF (the HTML invoice shows it); embed a Unicode font via @pdf-lib/fontkit if such orders become common.
  const safe = (t: unknown) =>
    String(t ?? '')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/[^\x20-\x7E -ÿ]/g, '?');
  const text = (t: unknown, x: number, y: number, size: number, font: Font = reg, color = navy) =>
    page.drawText(safe(t), { x, y, size, font, color });
  const textR = (t: unknown, right: number, y: number, size: number, font: Font = reg, color = navy) => {
    const str = safe(t);
    page.drawText(str, { x: right - font.widthOfTextAtSize(str, size), y, size, font, color });
  };
  const textC = (t: unknown, center: number, y: number, size: number, font: Font = reg, color = navy) => {
    const str = safe(t);
    page.drawText(str, { x: center - font.widthOfTextAtSize(str, size) / 2, y, size, font, color });
  };
  const wrap = (t: unknown, font: Font, size: number, width: number, maxLines: number): string[] => {
    const out: string[] = [];
    let cur = '';
    let cut = false;
    for (const w of safe(t).split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= width || !cur) {
        cur = next;
        continue;
      }
      out.push(cur);
      cur = w;
      if (out.length === maxLines) {
        cut = true;
        break;
      }
    }
    if (!cut && cur) out.push(cur);
    if (cut || out.length > maxLines) out[maxLines - 1] = `${out[maxLines - 1]}...`;
    return out.slice(0, maxLines);
  };
  // pdf-lib draws SVG paths from (x, y) with y growing downwards
  const roundRect = (x: number, top: number, w: number, h: number, r: number, color = cardBg) =>
    page.drawSvgPath(
      `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`,
      { x, y: top, color }
    );
  const hline = (y: number) => page.drawLine({ start: { x: M, y }, end: { x: R, y }, thickness: 0.5, color: rule });

  // 1. Header: logo + "Tax Invoice"
  const logoH = 18;
  page.drawImage(logo, { x: M, y: 432 - M - logoH, width: (logo.width / logo.height) * logoH, height: logoH });
  textR('Tax Invoice', R, 407, 13, bold, title);

  // 2. Meta grid (3 x 2)
  const meta: Array<[string, string]> = [
    ['Invoice Date', d.invoiceDate],
    ['Order No.', d.orderName],
    ['Order Date', d.orderDate],
    ['Invoice No.', d.invoiceNumber],
    ['Payment Status', d.paymentStatus],
    ['Store', d.store],
  ];
  meta.forEach(([label, value], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = M + col * 88 + (col ? 6 : 0);
    const y = 384 - row * 22;
    text(label, x, y, 5.5, reg, muted);
    text(value, x, y - 9, 7);
  });
  [M + 88, M + 176].forEach((x) =>
    page.drawLine({ start: { x, y: 350 }, end: { x, y: 392 }, thickness: 0.5, color: rule })
  );

  // 3. Shipping Address / From cards
  type CardLine = { t: string; font: Font; color: typeof navy; size: number };
  const cardW = 129;
  const inner = cardW - 12;
  const shipLines: CardLine[] = [
    { t: 'Shipping Address', font: reg, color: muted, size: 5.8 },
    { t: d.shipTo.name, font: bold, color: navy, size: 6.3 },
    ...wrap(d.shipTo.address, reg, 6.3, inner, 3).map((t) => ({ t, font: reg, color: navy, size: 6.3 })),
    { t: `${d.shipTo.city},`, font: reg, color: navy, size: 6.3 },
    { t: `${d.shipTo.state} ${d.shipTo.pincode}`, font: reg, color: navy, size: 6.3 },
  ];
  const fromLines: CardLine[] = [
    { t: 'From', font: reg, color: muted, size: 5.8 },
    { t: d.from.name, font: reg, color: navy, size: 6.3 },
    ...wrap(d.from.address, reg, 6.3, inner, 3).map((t) => ({ t, font: reg, color: navy, size: 6.3 })),
    { t: `GSTIN: ${d.from.gstin}`, font: bold, color: navy, size: 6.3 },
  ];
  const cardTop = 342;
  const cardH = 8 + Math.max(shipLines.length, fromLines.length) * 8;
  [shipLines, fromLines].forEach((lines, i) => {
    const x = M + i * (cardW + 6);
    roundRect(x, cardTop, cardW, cardH, 4);
    lines.forEach((l, j) => text(l.t, x + 6, cardTop - 10 - j * 8, l.size, l.font, l.color));
  });

  // 4. Items table
  const col = { sno: M + 9, name: M + 20, qty: M + 116, amount: M + 156, discount: M + 184, gst: M + 222, net: R - 3, sumLabel: M + 210 };
  let y = cardTop - cardH - 8;
  const tableTop = y;
  roundRect(M, y, R - M, 12, 3, head);
  page.drawRectangle({ x: M, y: y - 12, width: R - M, height: 6, color: head }); // square off the bottom corners
  const hy = y - 8.5;
  textC('S No.', col.sno, hy, 5.8, reg, white);
  text('Product Name', col.name, hy, 5.8, reg, white);
  textC('Qty', col.qty, hy, 5.8, reg, white);
  textR('Amount', col.amount, hy, 5.8, reg, white);
  textR('Discount', col.discount, hy, 5.8, reg, white);
  textR('GST', col.gst, hy, 5.8, reg, white);
  textR('Amount', col.net, hy, 5.8, reg, white);
  y -= 12;

  const sumRows: Array<[string, number]> = [
    ...(d.shipping > 0 ? ([['Shipping', d.shipping]] as Array<[string, number]>) : []),
    ...(d.otherCharges > 0 ? ([['Other Charges', d.otherCharges]] as Array<[string, number]>) : []),
    ['Total', d.total],
    ['Payment Received', d.received],
    ['Total Payment Due', d.due],
  ];
  const wordLines = wrap(`INR ${d.words}`, reg, 6.2, R - M - 10, 2);
  const reserved = 30 /* footer */ + sumRows.length * 12 + 12 + wordLines.length * 7.5 + 12 /* more-items row */;

  let shownCount = 0;
  for (const [i, l] of d.lines.entries()) {
    if (i >= INVOICE_MAX_ROWS) break;
    const titleLines = wrap(l.title, reg, 6, 90, 3);
    const rowH = 6 + titleLines.length * 7.5 + 13;
    if (y - rowH < reserved) break;
    const by = y - 8;
    textC(`${i + 1}.`, col.sno, by, 6);
    titleLines.forEach((t, k) => text(t, col.name, by - k * 7.5, 6));
    const subY = by - titleLines.length * 7.5;
    text(`SKU: ${l.sku}`, col.name, subY, 5, reg, muted);
    text(`HSN: ${l.hsn}`, col.name, subY - 6.5, 5, reg, muted);
    textC(String(l.qty), col.qty, by, 6);
    textR(money(l.amount), col.amount, by, 6);
    textR(l.discount.toFixed(2), col.discount, by, 6);
    textR(`${l.gst.toFixed(2)} | ${l.gstRate}%`, col.gst, by, 6);
    textR(money(l.net), col.net, by, 6);
    y -= rowH;
    hline(y);
    shownCount++;
  }

  const hidden = d.lines.length - shownCount;
  if (hidden > 0) {
    text(`+ ${hidden} more item${hidden > 1 ? 's' : ''} (included in the total)`, M + 5, y - 8.5, 6, reg, muted);
    y -= 12;
    hline(y);
  }
  for (const [label, value] of sumRows) {
    textR(label, col.sumLabel, y - 8.5, 6.3);
    textR(money(value), col.net, y - 8.5, 6.3);
    y -= 12;
    hline(y);
  }
  text('Amount Chargeable (in words)', M + 5, y - 9, 5.8, reg, muted);
  wordLines.forEach((t, k) => text(t, M + 5, y - 17 - k * 7.5, 6.2));
  y -= 12 + wordLines.length * 7.5;
  hline(y);
  [M, R].forEach((x) => page.drawLine({ start: { x, y: tableTop - 12 }, end: { x, y }, thickness: 0.5, color: rule }));

  // 5. Footer
  text('This is a computer-generated invoice; no signature is required.', M, 20, 5, reg, muted);
  text('Unless otherwise stated, tax on this invoice is not payable under reverse charge', M, 13, 5, reg, muted);

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}
