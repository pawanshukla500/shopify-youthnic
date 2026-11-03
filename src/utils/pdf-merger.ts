import invoiceService from '../modules/invoice/invoice.service';
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
 * Creates an authentic 4x6" (100mm x 150mm) GST Tax Invoice PDF page
 * strictly formatted for warehouse thermal label printers (288 x 432 pt).
 */
export async function create4x6InvoicePdf(
  order: any,
  waybillNumber: string,
  courierName?: string | null
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([288, 432]);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const black = rgb(0, 0, 0);
  const gray = rgb(0.3, 0.3, 0.3);
  const lightGray = rgb(0.92, 0.92, 0.92);

  // Outer border
  page.drawRectangle({
    x: 8,
    y: 8,
    width: 272,
    height: 416,
    borderColor: black,
    borderWidth: 1.2,
  });

  // Top Header: Seller Info & TAX INVOICE
  page.drawText('TAX INVOICE', { x: 195, y: 410, size: 10, font: fontBold, color: black });
  page.drawText('YOUTHNIC (VB EXPORTS)', { x: 14, y: 410, size: 9, font: fontBold, color: black });
  page.drawText('7004, HTC Market-1, Surat, Gujarat - 395002', { x: 14, y: 400, size: 6.5, font: fontRegular, color: gray });
  page.drawText('GSTIN: 24AAFFV1234P1Z8 (State 24) · +91 7984984563', { x: 14, y: 391, size: 6.5, font: fontRegular, color: gray });

  page.drawLine({ start: { x: 8, y: 384 }, end: { x: 280, y: 384 }, thickness: 1, color: black });

  // Invoice & Order Meta Row
  const invoiceNumber = `INV-2026-${order.shopifyOrderNumber || order.id}`;
  const invoiceDate = new Date(order.shopifyCreatedAt || Date.now()).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  page.drawText(`Inv: ${invoiceNumber}`, { x: 14, y: 373, size: 7.5, font: fontBold, color: black });
  page.drawText(`Date: ${invoiceDate}`, { x: 14, y: 362, size: 7, font: fontRegular, color: black });

  page.drawText(`Order: ${order.shopifyOrderName}`, { x: 110, y: 373, size: 7.5, font: fontBold, color: black });
  page.drawText(`AWB: ${waybillNumber || 'Pending'} (${courierName || 'Velocity'})`, { x: 110, y: 362, size: 7, font: fontRegular, color: black });

  page.drawLine({ start: { x: 8, y: 354 }, end: { x: 280, y: 354 }, thickness: 1, color: black });

  // Customer & Shipping Info
  const isCod = order.paymentMethod === 'COD' || order.shipment?.paymentMode === 'COD';
  const destStateCode = invoiceService.getStateCode(order.customerState);
  page.drawText('SOLD & SHIPPED TO:', { x: 14, y: 343, size: 7, font: fontBold, color: gray });
  page.drawText(`${(order.customerName || 'Customer').substring(0, 32)} · Ph: ${order.customerPhone || 'N/A'}`, { x: 14, y: 332, size: 8, font: fontBold, color: black });

  const addr = (order.customerAddress || order.customerAddress1 || '').substring(0, 85);
  page.drawText(addr.substring(0, 48), { x: 14, y: 322, size: 7, font: fontRegular, color: black });
  if (addr.length > 48) {
    page.drawText(addr.substring(48, 85), { x: 14, y: 312, size: 7, font: fontRegular, color: black });
  }

  const cityState = `${order.customerCity || ''}, ${order.customerState || ''} - ${order.customerPincode || ''} (State Code: ${destStateCode})`;
  page.drawText(cityState.substring(0, 52), { x: 14, y: 302, size: 7, font: fontBold, color: black });

  // Payment Badge box
  page.drawRectangle({
    x: 14,
    y: 284,
    width: 260,
    height: 14,
    color: lightGray,
  });
  const payText = isCod
    ? `CASH ON DELIVERY: COLLECT INR ${(order.totalAmount || 0).toFixed(2)}`
    : `PREPAID (ONLINE) — DO NOT COLLECT CASH`;
  page.drawText(payText, { x: 20, y: 288, size: 7, font: fontBold, color: black });

  page.drawLine({ start: { x: 8, y: 278 }, end: { x: 280, y: 278 }, thickness: 1, color: black });

  // Table Header
  page.drawRectangle({
    x: 8,
    y: 264,
    width: 272,
    height: 14,
    color: lightGray,
  });
  page.drawText('#', { x: 12, y: 268, size: 6.5, font: fontBold, color: black });
  page.drawText('Description / SKU', { x: 26, y: 268, size: 6.5, font: fontBold, color: black });
  page.drawText('Qty', { x: 165, y: 268, size: 6.5, font: fontBold, color: black });
  page.drawText('Rate', { x: 195, y: 268, size: 6.5, font: fontBold, color: black });
  page.drawText('GST', { x: 230, y: 268, size: 6.5, font: fontBold, color: black });
  page.drawText('Total', { x: 255, y: 268, size: 6.5, font: fontBold, color: black });

  page.drawLine({ start: { x: 8, y: 264 }, end: { x: 280, y: 264 }, thickness: 0.8, color: black });

  // Items
  const items = order.items || [];
  let curY = 252;
  for (let i = 0; i < Math.min(items.length, 4); i++) {
    const item = items[i];
    const itemGross = (item.price || 0) * (item.quantity || 1);
    const itemTaxable = itemGross / 1.05;
    const ratePerUnit = itemTaxable / (item.quantity || 1);

    page.drawText(`${i + 1}`, { x: 12, y: curY, size: 6.5, font: fontRegular, color: black });
    const desc = `${(item.title || 'Item').substring(0, 24)} (${(item.sku || 'N/A').substring(0, 12)})`;
    page.drawText(desc, { x: 26, y: curY, size: 6.5, font: fontRegular, color: black });
    page.drawText(`${item.quantity || 1}`, { x: 168, y: curY, size: 6.5, font: fontBold, color: black });
    page.drawText(`${ratePerUnit.toFixed(1)}`, { x: 192, y: curY, size: 6.5, font: fontRegular, color: black });
    page.drawText('5%', { x: 232, y: curY, size: 6.5, font: fontRegular, color: black });
    page.drawText(`${itemGross.toFixed(1)}`, { x: 252, y: curY, size: 6.5, font: fontBold, color: black });

    curY -= 13;
  }

  page.drawLine({ start: { x: 8, y: 195 }, end: { x: 280, y: 195 }, thickness: 0.8, color: black });

  // Tax Breakdown & Totals
  const totalAmount = order.totalAmount || 0;
  const taxableTotal = totalAmount / 1.05;
  const taxTotal = totalAmount - taxableTotal;
  const isIntraState = destStateCode === '24';
  const taxDetail = isIntraState
    ? `CGST: ${(taxTotal / 2).toFixed(2)} | SGST: ${(taxTotal / 2).toFixed(2)}`
    : `IGST (5%): ${taxTotal.toFixed(2)}`;

  page.drawText(`Taxable Value: INR ${taxableTotal.toFixed(2)}`, { x: 14, y: 183, size: 7, font: fontRegular, color: black });
  page.drawText(taxDetail, { x: 14, y: 172, size: 7, font: fontRegular, color: black });

  // Grand Total Box
  page.drawRectangle({
    x: 160,
    y: 162,
    width: 114,
    height: 28,
    borderColor: black,
    borderWidth: 1,
    color: lightGray,
  });
  page.drawText('TOTAL AMOUNT:', { x: 166, y: 178, size: 7, font: fontBold, color: black });
  page.drawText(`INR ${totalAmount.toFixed(2)}`, { x: 166, y: 166, size: 9, font: fontBold, color: black });

  // Amount in words
  const words = invoiceService.numberToWords(totalAmount);
  page.drawText(`In Words: ${words.substring(0, 52)}`, { x: 14, y: 150, size: 6.5, font: fontRegular, color: gray });

  page.drawLine({ start: { x: 8, y: 140 }, end: { x: 280, y: 140 }, thickness: 1, color: black });

  // Footer & Disclaimer
  page.drawText('TERMS & CONDITIONS:', { x: 14, y: 128, size: 6.5, font: fontBold, color: black });
  page.drawText('1. Youthnic 7-day hassle-free exchange & return policy applies.', { x: 14, y: 118, size: 6, font: fontRegular, color: gray });
  page.drawText('2. Computer generated tax invoice. No signature required.', { x: 14, y: 108, size: 6, font: fontRegular, color: gray });
  page.drawText('3. Jurisdiction: Surat, Gujarat.', { x: 14, y: 98, size: 6, font: fontRegular, color: gray });

  // Signature Block
  page.drawText('For VB EXPORTS (YOUTHNIC)', { x: 160, y: 75, size: 7, font: fontBold, color: black });
  page.drawText('Authorised Signatory', { x: 175, y: 45, size: 6.5, font: fontRegular, color: gray });

  // Return address bar
  page.drawLine({ start: { x: 8, y: 32 }, end: { x: 280, y: 32 }, thickness: 0.8, color: black });
  page.drawText('Return To: 7004, HTC Market-1, Anjana Farm, Surat - 395002', { x: 14, y: 18, size: 6.5, font: fontBold, color: black });

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}
