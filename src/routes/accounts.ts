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
  generateMonthlyReport,
  getReportRecipients,
  monthRange,
  previousMonth,
  reportSentAt,
  setReportRecipients,
} from '../modules/accounts/accounts-report.service';
import resendService from '../modules/email/resend.service';

const router = Router();

// The file arrives base64-encoded in JSON (express.json limit 10 MB; base64
// adds a third), so 7 MB of file is the most that fits.
const MAX_UPLOAD_BYTES = 7 * 1024 * 1024;
const IMPORT_KINDS: ImportKind[] = ['DELHIVERY_REMITTANCE', 'DELHIVERY_CHARGES', 'PG_SETTLEMENT'];

function requestedMonth(value: unknown): string {
  const month = typeof value === 'string' && value ? value : previousMonth();
  monthRange(month); // validates
  return month;
}

router.get('/overview', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const month = requestedMonth(req.query.month);
    const { start, end } = monthRange(month);
    const orders = await prisma.order.findMany({
      where: { shopifyCreatedAt: { gte: start, lt: end } },
      include: { shipment: true, returns: true },
    });
    const data = buildReportData(month, orders);
    const [recipients, sentAt, imports] = await Promise.all([
      getReportRecipients(),
      reportSentAt(month),
      prisma.reconciliationImport.findMany({ orderBy: { createdAt: 'desc' }, take: 15 }),
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
    const month = requestedMonth(req.query.month);
    const { buffer, fileName } = await generateMonthlyReport(month);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/report/email', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const month = requestedMonth(req.body?.month);
    const result = await emailMonthlyReport(month);
    logger.info('Accounts report emailed on request', { month, by: req.user?.email });
    res.json({ success: true, month, ...result });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/settings', async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.json({ recipients: await getReportRecipients(), reportDay: config.accounts.reportDayOfMonth });
});

router.put('/settings', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const recipients = await setReportRecipients(String(req.body?.recipients ?? ''));
    logger.info('Accounts report recipients changed', { recipients, by: req.user?.email });
    res.json({ recipients });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/import', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { kind, fileName, contentBase64, defaults } = req.body || {};
    if (!IMPORT_KINDS.includes(kind)) {
      res.status(400).json({ error: `kind must be one of ${IMPORT_KINDS.join(', ')}` });
      return;
    }
    if (!fileName || typeof contentBase64 !== 'string' || !contentBase64) {
      res.status(400).json({ error: 'fileName and contentBase64 are required' });
      return;
    }
    const content = Buffer.from(contentBase64, 'base64');
    if (content.length > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: 'File is larger than 7 MB. Split it by date range and upload the parts.' });
      return;
    }

    const sheets = await readSpreadsheet(String(fileName), content);
    if (!sheets.length) {
      res.status(400).json({ error: 'The file has no rows that could be read.' });
      return;
    }
    const by = req.user?.email;
    const result =
      kind === 'DELHIVERY_REMITTANCE'
        ? await importDelhiveryRemittance(String(fileName), sheets, defaults || {}, by)
        : kind === 'DELHIVERY_CHARGES'
          ? await importDelhiveryCharges(String(fileName), sheets, by)
          : await importGatewaySettlement(String(fileName), sheets, by);

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
  const imports = await prisma.reconciliationImport.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  res.json(imports);
});

router.post('/orders/:id/payment-received', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const orderId = parseInt(req.params.id, 10);
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
    // Blank means the order total; anything else must be a real amount
    // ("1,299" is accepted; null or text is refused, never recorded as ₹0).
    const rawAmount = req.body?.amount;
    const amount =
      rawAmount === undefined || rawAmount === ''
        ? order.totalAmount
        : rawAmount === null
          ? NaN
          : Number(String(rawAmount).replace(/[₹,\s]/g, ''));
    if (!Number.isFinite(amount) || amount < 0) {
      res.status(400).json({ error: 'Amount must be a number.' });
      return;
    }
    await recordPaymentReceived(orderId, {
      receivedAt,
      amount,
      utr,
      ref: String(req.body?.ref || '').trim() || null,
      source: 'MANUAL',
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
