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
