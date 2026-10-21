import { PDFDocument } from 'pdf-lib';
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
