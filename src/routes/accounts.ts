/**
 * Payments & Accounts API (mounted at /api/accounts, Firebase auth required).
 *
 *   GET  /overview?month=YYYY-MM   month totals, upload history, report status
 *   GET  /report?month=YYYY-MM     download the monthly closing report (.xlsx)
 *   POST /report/email             { month } email it to the accounts team now
 *   GET  /settings  PUT /settings  report recipients
 *   POST /import                   { kind, fileName, contentBase64, defaults? }
 *   POST /orders/:id/payment-received  { utr, amount, receivedAt, ref } manual entry
 *   POST /run                      run closing + cost estimates + gateway sync now
 */
import { Router, Response } from 'express';
import prisma from '../database/prisma';
import { config } from '../config';
import logger from '../utils/logger';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { readSpreadsheet, parseDateLoose } from '../modules/accounts/spreadsheet';
import {
  ImportKind,
  importCarrierRemittance,
  importDelhiveryCharges,
  importDelhiveryRemittance,
  importGatewaySettlement,
  recordPaymentReceived,
} from '../modules/accounts/reconciliation.service';
import { runAccountsMaintenance } from '../modules/accounts/accounts.service';
import { estimatePendingShippingCosts } from '../modules/accounts/shipping-cost.service';
import {
  easebuzzConfigured,
  phonePeConfigured,
  syncGatewaySettlements,
} from '../modules/accounts/gateway-settlement.service';
import {
  buildReportData,
  emailMonthlyReport,
  generateDateRangeReport,
  generateMonthlyReport,
  getReportRecipients,
  getReportCcRecipients,
  getStateMonthlyAccounting,
  parseRecipients,
  monthRange,
  previousMonth,
  reportSentAt,
  setReportRecipients,
} from '../modules/accounts/accounts-report.service';
import resendService from '../modules/email/resend.service';
import { correctImportUtr } from '../modules/accounts/settlement-utr.service';
import { istDateRange } from '../modules/accounts/settlement-summary';

const router = Router();

function parsePositiveInt(val: any): number | null {
  const n = parseInt(val, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// The file arrives base64-encoded in JSON (express.json limit 10 MB; base64
// adds a third), so 7 MB of file is the most that fits.
const MAX_UPLOAD_BYTES = 7 * 1024 * 1024;
const IMPORT_KINDS: ImportKind[] = [
  'DELHIVERY_REMITTANCE',
  'VELOCITY_REMITTANCE',
  'DELHIVERY_CHARGES',
  'PG_SETTLEMENT',
  'GOKWIK_SETTLEMENT',
  'PHONEPE_SETTLEMENT',
  'AMAZON_SHIPPING',
  'EKART_SHIPPING',
  'GENERIC_CARRIER',
];

function requestedMonth(value: unknown): string {
  const month = typeof value === 'string' && value ? value : previousMonth();
  monthRange(month); // validates
  return month;
}

router.get('/state-monthly', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const month = typeof req.query.month === 'string' && req.query.month ? req.query.month : previousMonth();
    const data = await getStateMonthlyAccounting(month);
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/overview', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { startDate, endDate } = req.query;
    let start: Date;
    let end: Date;
    let month: string;
    let label: string;

    if (startDate && endDate) {
      ({ start, end } = istDateRange(String(startDate), String(endDate)));
      month = String(startDate).slice(0, 7);
      label = `${String(startDate)} to ${String(endDate)}`;
    } else {
      month = requestedMonth(req.query.month);
      const range = monthRange(month);
      start = range.start;
      end = range.end;
      label = range.label;
    }

    const orders = await prisma.order.findMany({
      where: { shopifyCreatedAt: { gte: start, lt: end } },
      include: { shipment: true, returns: true },
    });
    const data = buildReportData(label, orders);
    const [recipients, sentAt, imports] = await Promise.all([
      getReportRecipients(),
      reportSentAt(month),
      prisma.reconciliationImport.findMany({ orderBy: { createdAt: 'desc' }, take: 250 }),
    ]);
    res.json({
      month,
      label: data.label,
      summary: data.summary,
      openOrders: data.orders
        .filter((row) => row.accountsStatus === 'Open')
        .slice(0, 200)
        .map((row) => ({
          orderNo: row.orderNo,
          paymentMode: row.paymentMode,
          orderValue: row.orderValue,
          pending: row.pending,
        })),
      recipients,
      reportSentAt: sentAt,
      reportDay: config.accounts.reportDayOfMonth,
      imports,
      connectors: {
        delhiveryRateApi: Boolean(config.delhivery.apiToken),
        phonepeSettlementApi: phonePeConfigured(),
        easebuzzPayoutApi: easebuzzConfigured(),
        email: resendService.getStatus().apiKeyConfigured,
      },
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/report', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { startDate, endDate } = req.query;
    let buffer: Buffer;
    let fileName: string;

    if (startDate && endDate) {
      const result = await generateDateRangeReport(String(startDate), String(endDate));
      buffer = result.buffer;
      fileName = result.fileName;
    } else {
      const month = requestedMonth(req.query.month);
      const result = await generateMonthlyReport(month);
      buffer = result.buffer;
      fileName = result.fileName;
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/template/:type', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { type } = req.params;
  if (type === 'delhivery-remittance') {
    const csv = [
      'Waybill Number,Client Order ID,COD Amount,Remittance Number,Bank Transaction ID,Remittance Processed Date',
      '30100810011111,#26YOU5913,719.10,R3359352026101300001,AXISP00847547449,13-10-2026',
      '30100810011112,#26YOU5914,1499.00,R3359352026101300001,AXISP00847547449,13-10-2026',
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="delhivery_remittance_sample_template.csv"');
    res.send(csv);
    return;
  }
  if (type === 'delhivery-charges') {
    const csv = [
      'Waybill Number,Transaction Type,Amount (incl. GST),Description,Date,Charged Weight (gm),Zone',
      '30100810011111,Debit,78.40,Forward Freight,10-10-2026,500,D',
      '30100810011112,Debit,92.50,Forward Freight,10-10-2026,600,B',
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="delhivery_charges_ledger_sample_template.csv"');
    res.send(csv);
    return;
  }
  if (type === 'gokwik-settlement') {
    const csv = [
      'Order ID,Merchant Transaction ID,Settlement UTR,Amount Settled,Total Charges,Total Tax,Settlement Date,Status',
      '#26YOU6010,gokwik_txn_101,UTIBR52026101000123,1038.60,11.80,2.12,11-10-2026,Success',
      '#26YOU6013,gokwik_txn_102,UTIBR52026101000123,565.40,6.71,1.21,11-10-2026,Success',
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="gokwik_settlement_sample_template.csv"');
    res.send(csv);
    return;
  }
  if (type === 'phonepe-settlement') {
    const csv = [
      'Order ID,Payment ID,Merchant Order ID,Amount,Fee,Tax,Settlement Date,UTR',
      '#26YOU6020,T26101014523,26YOU6020,899.00,16.18,2.91,11-10-2026,AXISCN002938475',
      '#26YOU6021,T26101014524,26YOU6021,1249.00,22.48,4.05,11-10-2026,AXISCN002938475',
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="phonepe_settlement_sample_template.csv"');
    res.send(csv);
    return;
  }
  if (type === 'carrier-remittance') {
    const csv = [
      'Waybill Number,Client Order ID,COD Amount,Remittance Number,Bank Transaction ID,Remittance Processed Date',
      'AMZIN00192837,#26YOU5920,850.00,AMZREM20261012,HDFCN00892718,12-10-2026',
      'AMZIN00192838,#26YOU5921,1150.00,AMZREM20261012,HDFCN00892718,12-10-2026',
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="carrier_remittance_sample_template.csv"');
    res.send(csv);
    return;
  }
  res.status(404).json({ error: 'Template type not found' });
});

router.post('/report/email', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const month = requestedMonth(req.body?.month);
    const recipients = req.body?.recipients ? parseRecipients(req.body.recipients) : undefined;
    const ccRecipients = req.body?.ccRecipients ? parseRecipients(req.body.ccRecipients) : undefined;
    const result = await emailMonthlyReport(month, recipients, ccRecipients);
    logger.info('Accounts report emailed on request', { month, by: req.user?.email, result });
    res.json({ success: true, month, ...result });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/settings', async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  const [to, cc] = await Promise.all([getReportRecipients(), getReportCcRecipients()]);
  res.json({ recipients: to, ccRecipients: cc, reportDay: config.accounts.reportDayOfMonth });
});

router.put('/settings', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { to, cc } = await setReportRecipients(
      String(req.body?.recipients ?? ''),
      req.body?.ccRecipients !== undefined ? String(req.body.ccRecipients) : undefined
    );
    logger.info('Accounts report recipients changed', { to, cc, by: req.user?.email });
    res.json({ recipients: to, ccRecipients: cc });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/import', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { kind, fileName, contentBase64, defaults, force } = req.body || {};
    if (!IMPORT_KINDS.includes(kind)) {
      res.status(400).json({ error: `kind must be one of ${IMPORT_KINDS.join(', ')}` });
      return;
    }
    if (!fileName || typeof contentBase64 !== 'string' || !contentBase64) {
      res.status(400).json({ error: 'fileName and contentBase64 are required' });
      return;
    }

    const cleanFileName = String(fileName).trim();

    // Strict duplicate check unless explicitly overridden with force: true
    if (!force) {
      // 1. Exact file name match
      let existing = await prisma.reconciliationImport.findFirst({
        where: { fileName: cleanFileName },
        orderBy: { createdAt: 'desc' },
      });

      // 2. Remittance batch number match in file name (e.g. R3359352026101200000)
      if (!existing) {
        const refMatch = cleanFileName.match(/\b(R\d{6,})\b/i);
        if (refMatch) {
          existing = await prisma.reconciliationImport.findFirst({
            where: {
              fileName: { contains: refMatch[1] },
            },
            orderBy: { createdAt: 'desc' },
          });
        }
      }

      // 3. User provided remittanceRef match
      if (!existing && defaults?.remittanceRef) {
        const ref = String(defaults.remittanceRef).trim();
        existing = await prisma.reconciliationImport.findFirst({
          where: {
            fileName: { contains: ref },
          },
          orderBy: { createdAt: 'desc' },
        });
      }

      if (existing) {
        const uploadDate = new Date(existing.createdAt).toLocaleDateString('en-IN', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });
        const summaryData =
          existing.summary && typeof existing.summary === 'object'
            ? (existing.summary as Record<string, any>)
            : {};
        res.status(409).json({
          error: `Duplicate File: "${cleanFileName}" was already uploaded on ${uploadDate} with ${existing.matchedCount} orders matched. Duplicate uploads are blocked to prevent double-counting.`,
          code: 'DUPLICATE_FILE_ALREADY_UPLOADED',
          existingImport: {
            id: existing.id,
            fileName: existing.fileName,
            createdAt: existing.createdAt,
            matchedCount: existing.matchedCount,
            totalRemittance: summaryData.totalRemittance ?? null,
            bankTransactionId: summaryData.bankTransactionId ?? null,
            remittanceNumber: summaryData.remittanceNumber ?? null,
          },
        });
        return;
      }
    }

    const content = Buffer.from(contentBase64, 'base64');
    if (content.length > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: 'File is larger than 7 MB. Split it by date range and upload the parts.' });
      return;
    }

    const sheets = await readSpreadsheet(cleanFileName, content);
    if (!sheets.length) {
      res.status(400).json({ error: 'The file has no rows that could be read.' });
      return;
    }
    const by = req.user?.email;
    let result;
    if (kind === 'DELHIVERY_REMITTANCE') {
      result = await importDelhiveryRemittance(cleanFileName, sheets, defaults || {}, by, req.user);
    } else if (kind === 'DELHIVERY_CHARGES') {
      result = await importDelhiveryCharges(cleanFileName, sheets, by, req.user);
    } else if (kind === 'GOKWIK_SETTLEMENT' || kind === 'PHONEPE_SETTLEMENT' || kind === 'PG_SETTLEMENT') {
      result = await importGatewaySettlement(cleanFileName, sheets, by, kind, req.user, defaults || {});
    } else {
      result = await importCarrierRemittance(kind, cleanFileName, sheets, defaults || {}, by, req.user);
    }

    // Newly paid orders may now be past their return window.
    const maintenance = await runAccountsMaintenance().catch((error) => {
      logger.warn('Accounts closing after import failed', { error: error.message });
      return null;
    });
    res.json({ ...result, closedNow: maintenance?.closed ?? 0 });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/imports', async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  const imports = await prisma.reconciliationImport.findMany({ orderBy: { createdAt: 'desc' }, take: 250 });
  res.json(imports);
});

router.patch('/remittance/:importId/utr', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const importId = parsePositiveInt(req.params.importId);
    if (!importId) {
      res.status(400).json({ error: 'Valid positive integer import ID is required' });
      return;
    }
    const utr = String(req.body?.utr || '').trim();
    if (!utr) {
      res.status(400).json({ error: 'utr is required' });
      return;
    }

    if (!req.user?.uid) { res.status(401).json({ error: 'Authentication required.' }); return; }
    const requestedOrder = req.body?.orderId === undefined ? undefined : Number(req.body.orderId);
    const updated = await correctImportUtr(importId, utr, req.user, requestedOrder);

    const maintenance = await runAccountsMaintenance().catch(() => ({ closed: 0 }));
    res.json({ success: true, import: updated, closedNow: maintenance?.closed ?? 0 });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/orders/:id/payment-received', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const orderId = parsePositiveInt(req.params.id);
    if (!orderId) {
      res.status(400).json({ error: 'Valid positive integer order ID is required' });
      return;
    }
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    const utr = String(req.body?.utr || '').trim();
    if (!utr) {
      res.status(400).json({ error: 'The bank UTR is required.' });
      return;
    }
    const receivedAt = parseDateLoose(String(req.body?.receivedAt || '')) || new Date();
    // New bank receipts require the actual net credit, not an assumed order total.
    // Existing receipt enrichment preserves its stored amount.
    const rawAmount = req.body?.amount;
    const amount =
      rawAmount === undefined || rawAmount === ''
        ? order.paymentReceivedAt ? order.paymentReceivedAmount : NaN
        : rawAmount === null
          ? NaN
          : Number(String(rawAmount).replace(/[₹,\s]/g, ''));
    if ((amount !== null && (!Number.isFinite(amount) || amount < 0)) || (amount === null && !order.paymentReceivedAt)) {
      res.status(400).json({ error: 'Enter the actual net amount credited to the bank.' });
      return;
    }
    await recordPaymentReceived(orderId, {
      receivedAt,
      amount,
      utr,
      ref: String(req.body?.ref || '').trim() || null,
      source: 'MANUAL',
      actor: req.user,
    });
    await prisma.syncLog.create({
      data: {
        orderId,
        syncType: 'PAYMENT_VERIFY',
        status: 'SUCCESS',
        message: `Payment received entered manually by ${req.user?.email || 'unknown user'}: ₹${amount}, UTR ${utr}`,
      },
    });
    const maintenance = await runAccountsMaintenance();
    res.json({ success: true, closedNow: maintenance.closed });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/run', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const maintenance = await runAccountsMaintenance();
    const settlements = await syncGatewaySettlements().catch((error) => ({ error: error.message }));
    const estimated = await estimatePendingShippingCosts({ limit: 4 });
    logger.info('Accounts run on request', { by: req.user?.email });
    res.json({ ...maintenance, settlements, shippingEstimates: estimated });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
