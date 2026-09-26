import axios from 'axios';
import prisma from '../../database/prisma';
import delhiveryService from './delhivery.service';
import firebaseService from '../firebase/firebase.service';
import logger from '../../utils/logger';

/**
 * Delhivery Document Fetcher
 *
 * Polls Delhivery's Download Document API to backfill proof artifacts into
 * Firebase Storage so they survive Delhivery's link expiry and so the
 * Order Detail page can render them directly.
 *
 * Per Delhivery docs (https://one.delhivery.com/developer-portal/document/b2c/detail/document/download):
 *   - Allowed doc types: SIGNATURE_URL, RVP_QC_IMAGE, EPOD, SELLER_RETURN_IMAGE
 *   - Response shape: { data: { [awb]: { [docType]: "<signed-url-or-base64>" } } }
 *
 * This service:
 *   1. Finds shipments/returns that need an artifact (status gate + missing URL).
 *   2. Calls Delhivery.
 *   3. Downloads the binary.
 *   4. Uploads to Firebase Storage at orders/{orderId}/{type}-{ts}.{ext}.
 *   5. Writes the gs:// path back to the DB row.
 *
 * Designed to be safe to run on a cron and idempotent: re-running on a row
 * that already has the path is a no-op.
 */
export interface FetchResult {
  scanned: number;
  uploaded: number;
  skipped: number;
  failed: number;
  errors: Array<{ waybill: string; docType: string; error: string }>;
}

type ArtifactKind = 'epod' | 'signature' | 'qc' | 'sorter';

const ARTIFACT_DOC_TYPE: Record<ArtifactKind, 'EPOD' | 'SIGNATURE_URL' | 'RVP_QC_IMAGE' | 'SELLER_RETURN_IMAGE'> = {
  epod: 'EPOD',
  signature: 'SIGNATURE_URL',
  qc: 'RVP_QC_IMAGE',
  sorter: 'SELLER_RETURN_IMAGE',
};

const ARTIFACT_EXT: Record<ArtifactKind, string> = {
  epod: 'jpg',
  signature: 'jpg',
  qc: 'jpg',
  sorter: 'jpg',
};

const ARTIFACT_MIME: Record<ArtifactKind, string> = {
  epod: 'image/jpeg',
  signature: 'image/jpeg',
  qc: 'image/jpeg',
  sorter: 'image/jpeg',
};

class DelhiveryDocumentFetcher {
  /**
   * Fetch EPOD + signature images for every Shipment whose status is DELIVERED
   * but has no EPOD stored yet. Limit by `lookbackDays` (default 30) so the
   * job doesn't try to refetch the entire history.
   */
  async fetchEpodsForDeliveredShipments(lookbackDays = 30): Promise<FetchResult> {
    const result: FetchResult = { scanned: 0, uploaded: 0, skipped: 0, failed: 0, errors: [] };
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    const shipments = await prisma.shipment.findMany({
      where: {
        status: 'DELIVERED',
        waybillNumber: { not: null },
        epodStoragePath: null,
        trackingUpdatedAt: { gte: since },
      },
      select: { id: true, orderId: true, waybillNumber: true },
      take: 100,
      orderBy: { trackingUpdatedAt: 'desc' },
    });

    for (const ship of shipments) {
      result.scanned += 1;
      const waybill = ship.waybillNumber!;
      try {
        // Try EPOD first, then signature if EPOD is empty.
        const epod = await this.tryFetchArtifact(ship.orderId, waybill, 'epod');
        if (epod.uploaded) result.uploaded += 1;
        else result.skipped += 1;

        const signature = await this.tryFetchArtifact(ship.orderId, waybill, 'signature');
        if (signature.uploaded) result.uploaded += 1;
        else result.skipped += 1;
      } catch (err: any) {
        result.failed += 1;
        result.errors.push({ waybill, docType: 'EPOD+SIGNATURE', error: err.message });
      }
    }
    return result;
  }

  /**
   * Fetch QC images for every Return whose QC has been recorded but no
   * image is stored yet. Most useful when RVP (reverse pickup) QC is done
   * at the Surat hub.
   */
  async fetchQcImagesForReturns(lookbackDays = 30): Promise<FetchResult> {
    const result: FetchResult = { scanned: 0, uploaded: 0, skipped: 0, failed: 0, errors: [] };
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    const returns = await prisma.return.findMany({
      where: {
        returnWaybillNumber: { not: null },
        qcCheckedAt: { not: null, gte: since },
        qcStoragePath: null,
      },
      select: { id: true, orderId: true, returnWaybillNumber: true },
      take: 100,
      orderBy: { qcCheckedAt: 'desc' },
    });

    for (const ret of returns) {
      result.scanned += 1;
      const waybill = ret.returnWaybillNumber!;
      try {
        const qc = await this.tryFetchArtifact(ret.orderId, waybill, 'qc');
        if (qc.uploaded) result.uploaded += 1;
        else result.skipped += 1;
      } catch (err: any) {
        result.failed += 1;
        result.errors.push({ waybill, docType: 'RVP_QC_IMAGE', error: err.message });
      }
    }
    return result;
  }

  /**
   * Fetch sorter-weight image for any Shipment in the post-manifest window
   * that hasn't yet recorded its billed/sorter weight. Useful when Delhivery
   * pushes the weight via Sorter Image webhook but we don't have that
   * webhook enabled (poll-based fallback).
   */
  async fetchSorterImagesForManifestedShipments(lookbackDays = 7): Promise<FetchResult> {
    const result: FetchResult = { scanned: 0, uploaded: 0, skipped: 0, failed: 0, errors: [] };
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    const shipments = await prisma.shipment.findMany({
      where: {
        waybillNumber: { not: null },
        status: { in: ['PENDING', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'] },
        sorterStoragePath: null,
        createdAt: { gte: since },
      },
      select: { id: true, orderId: true, waybillNumber: true },
      take: 100,
      orderBy: { createdAt: 'desc' },
    });

    for (const ship of shipments) {
      result.scanned += 1;
      const waybill = ship.waybillNumber!;
      try {
        const sorter = await this.tryFetchArtifact(ship.orderId, waybill, 'sorter');
        if (sorter.uploaded) result.uploaded += 1;
        else result.skipped += 1;
      } catch (err: any) {
        result.failed += 1;
        result.errors.push({ waybill, docType: 'SELLER_RETURN_IMAGE', error: err.message });
      }
    }
    return result;
  }

  /**
   * Run all three passes sequentially. Designed to be the cron entrypoint.
   */
  async runAll(): Promise<{ epod: FetchResult; qc: FetchResult; sorter: FetchResult }> {
    const epod = await this.fetchEpodsForDeliveredShipments();
    const qc = await this.fetchQcImagesForReturns();
    const sorter = await this.fetchSorterImagesForManifestedShipments();
    logger.info('Delhivery document fetcher run complete', {
      epod,
      qc,
      sorter,
    });
    return { epod, qc, sorter };
  }

  // ────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────

  private async tryFetchArtifact(
    orderId: number,
    waybill: string,
    kind: ArtifactKind
  ): Promise<{ uploaded: boolean; reason?: string; path?: string }> {
    const docType = ARTIFACT_DOC_TYPE[kind];

    let payload: any;
    try {
      payload = await delhiveryService.downloadDocument(waybill, docType);
    } catch (err: any) {
      // 404 / "no document" is normal — Delhivery returns success but an empty bucket when nothing is available.
      logger.debug('Document download failed (non-fatal)', { waybill, docType, error: err.message });
      return { uploaded: false, reason: `download_failed: ${err.message}` };
    }

    const urlOrB64 = extractDocumentUrl(payload, waybill, docType);
    if (!urlOrB64) {
      return { uploaded: false, reason: 'no_url_in_response' };
    }

    let buffer: Buffer;
    try {
      buffer = await this.resolveToBuffer(urlOrB64);
    } catch (err: any) {
      return { uploaded: false, reason: `resolve_failed: ${err.message}` };
    }

    if (buffer.length === 0) {
      return { uploaded: false, reason: 'empty_buffer' };
    }

    const uploaded = await firebaseService.uploadOrderArtifact(
      orderId,
      kind,
      buffer,
      ARTIFACT_MIME[kind],
      ARTIFACT_EXT[kind],
      true // public — proof artifacts are operator-facing
    );

    await this.persistPath(orderId, waybill, kind, uploaded.path);

    return { uploaded: true, path: uploaded.path };
  }

  private async resolveToBuffer(input: string): Promise<Buffer> {
    const trimmed = input.trim();
    // Detect base64 payload (data URI or raw base64 > 256 chars with no http prefix)
    if (trimmed.startsWith('data:')) {
      const b64 = trimmed.split(',', 2)[1] || '';
      return Buffer.from(b64, 'base64');
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      // Heuristic: long alphanumeric+slashes/padding = base64
      if (/^[A-Za-z0-9+/=\s]{256,}$/.test(trimmed)) {
        return Buffer.from(trimmed.replace(/\s+/g, ''), 'base64');
      }
      // Unknown shape — treat as URL with empty body
      throw new Error('unrecognized_document_format');
    }
    // Signed URL — download via streaming axios
    const res = await axios.get<ArrayBuffer>(trimmed, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 8 * 1024 * 1024, // 8 MiB safety cap
    });
    return Buffer.from(res.data);
  }

  private async persistPath(orderId: number, waybill: string, kind: ArtifactKind, path: string): Promise<void> {
    if (kind === 'epod' || kind === 'signature' || kind === 'sorter') {
      const data: any = {};
      if (kind === 'epod') {
        data.epodStoragePath = path;
        data.epodReceivedAt = new Date();
      } else if (kind === 'signature') {
        data.signatureStoragePath = path;
      } else {
        data.sorterStoragePath = path;
        data.sorterCapturedAt = new Date();
      }
      await prisma.shipment.updateMany({
        where: { waybillNumber: waybill, orderId },
        data,
      });
    } else if (kind === 'qc') {
      await prisma.return.updateMany({
        where: { returnWaybillNumber: waybill, orderId },
        data: { qcStoragePath: path },
      });
    }
  }
}

/**
 * Pull a usable document URL out of the various Delhivery response shapes.
 *
 * Real shapes we've seen:
 *   { status: "SUCCESS", data: { "AWB123": { "EPOD": "https://..." } } }
 *   { status: "SUCCESS", data: "base64string" }
 *   { success: true, urls: ["https://..."] }
 *   { data: { EPOD: "https://..." } }
 */
function extractDocumentUrl(payload: any, waybill: string, docType: string): string | null {
  if (!payload) return null;

  if (typeof payload === 'string') return payload;

  if (Array.isArray(payload?.urls) && payload.urls[0]) return payload.urls[0];

  const data = payload.data ?? payload.result ?? payload;
  if (typeof data === 'string') return data;

  if (typeof data === 'object' && data !== null) {
    // by-awb
    const byAwb = data[waybill];
    if (byAwb && typeof byAwb === 'object') {
      const inner = byAwb[docType] ?? byAwb.url ?? byAwb[Object.keys(byAwb)[0]];
      if (inner) return String(inner);
    }
    // flat by docType
    const flat = data[docType];
    if (flat) return String(flat);

    // last-ditch: first string value
    for (const v of Object.values(data)) {
      if (typeof v === 'string' && v.length > 16) return v;
    }
  }
  return null;
}

const delhiveryDocumentFetcher = new DelhiveryDocumentFetcher();
export default delhiveryDocumentFetcher;
export { DelhiveryDocumentFetcher, extractDocumentUrl };