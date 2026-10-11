/**
 * Settlement UTRs straight from the payment gateways, for when the brand holds
 * its own gateway API credentials. Without credentials these are no-ops and
 * the accounts team uploads the settlement report instead
 * (reconciliation.importGatewaySettlement).
 *
 * PhonePe Payment Gateway v2 (OAuth client credentials):
 *   token        POST {identity}/v1/oauth/token  (client_id, client_version, client_secret)
 *   settlements  GET  {pg}/settlements/v1/range?from=&to=   → settlementId, state, utr, date
 *   orders       GET  {pg}/settlements/v1/{id}/transactions → utr, orders[] with
 *                merchantOrderId, transactionId, amount, settlementDetails{settlementAmount, totalCharges, totalTax}
 *   https://developer.phonepe.com/settlement/date-range-based-settlement-ids
 *   https://developer.phonepe.com/settlement/settlement-transactions
 *
 * Easebuzz Payout API V2:
 *   POST {dashboard}/settlements/v1/retrieve  {merchant_key, payout_date{start_date,end_date}, hash}
 *   hash = sha512(key|start_date|end_date|salt), dates DD-MM-YYYY
 *   → bank_transaction_id (UTR), payout_actual_date, peb_transactions[] {txnid, peb_settlement_amount, ...}
 *   https://docs.easebuzz.in/docs/payment-gateway/xsrzv37a3ksv0-payout-api-v2
 *
 * Neither could be exercised against live credentials when this was written;
 * responses are read defensively and amounts are sanity-checked against the
 * order total before anything is recorded.
 */
import axios from 'axios';
import { createHash } from 'crypto';
import { config } from '../../config';
import logger from '../../utils/logger';
import { findOrderByReference, recordPaymentReceived } from './reconciliation.service';
import { parseDateLoose } from './spreadsheet';

export interface GatewaySettlementLine {
  /** Order / transaction reference as the gateway knows it. */
  references: string[];
  utr: string;
  settledAt: Date;
  amount: number | null; // rupees
  fee: number | null; // rupees, charges + tax
  settlementRef: string;
}

/**
 * PhonePe v2 amounts are in paise. Against an order total, whichever reading
 * (paise or rupees) is plausible for a settlement of that order wins: between
 * half the order value and the full value plus 5%. Gateway fees are a few
 * percent, so a real settlement always lands there. If neither does, the
 * amount is unknown rather than recorded wrong.
 */
export function phonePeAmountToRupees(raw: unknown, orderTotal?: number): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const round = (n: number) => Math.round(n * 100) / 100;
  if (orderTotal && orderTotal > 0) {
    const plausible = (n: number) => n >= orderTotal * 0.5 && n <= orderTotal * 1.05;
    if (plausible(value / 100)) return round(value / 100);
    if (plausible(value)) return round(value);
    return null;
  }
  return round(value / 100);
}

// ─── PhonePe ────────────────────────────────────────────────

const PHONEPE_HOSTS = {
  PRODUCTION: {
    token: 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token',
    pg: 'https://api.phonepe.com/apis/pg',
  },
  UAT: {
    token: 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token',
    pg: 'https://api-preprod.phonepe.com/apis/pg-sandbox',
  },
};

let phonePeToken: { value: string; expiresAt: number } | null = null;

export function phonePeConfigured(): boolean {
  return Boolean(config.phonepe.clientId && config.phonepe.clientSecret);
}

async function phonePeAccessToken(): Promise<string> {
  if (phonePeToken && phonePeToken.expiresAt - 60_000 > Date.now()) return phonePeToken.value;
  const hosts = config.phonepe.env === 'UAT' ? PHONEPE_HOSTS.UAT : PHONEPE_HOSTS.PRODUCTION;
  const response = await axios.post(
    hosts.token,
    new URLSearchParams({
      client_id: config.phonepe.clientId,
      client_version: config.phonepe.clientVersion,
      client_secret: config.phonepe.clientSecret,
      grant_type: 'client_credentials',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  const token = response.data?.access_token;
  if (!token) throw new Error('PhonePe did not return an access token');
  // expires_at is epoch seconds; fall back to 50 minutes.
  const expiresAtSeconds = Number(response.data?.expires_at);
  phonePeToken = {
    value: token,
    expiresAt: Number.isFinite(expiresAtSeconds) && expiresAtSeconds > 0 ? expiresAtSeconds * 1000 : Date.now() + 50 * 60_000,
  };
  return token;
}

async function phonePeGet(path: string, params?: Record<string, unknown>): Promise<any> {
  const hosts = config.phonepe.env === 'UAT' ? PHONEPE_HOSTS.UAT : PHONEPE_HOSTS.PRODUCTION;
  const token = await phonePeAccessToken();
  const response = await axios.get(`${hosts.pg}${path}`, {
    params,
    headers: {
      Authorization: `O-Bearer ${token}`,
      'Content-Type': 'application/json',
      // Partner (TSP) integrations identify the end merchant with this header.
      ...(config.phonepe.merchantId ? { 'X-MERCHANT-ID': config.phonepe.merchantId } : {}),
    },
    timeout: 20000,
  });
  return response.data;
}

/** Settlement lines (one per order) PhonePe paid out between two dates. */
export async function fetchPhonePeSettlements(from: Date, to: Date): Promise<GatewaySettlementLine[]> {
  if (!phonePeConfigured()) return [];
  const range = await phonePeGet('/settlements/v1/range', { from: from.getTime(), to: to.getTime(), limit: 40 });
  const settlements: any[] = range?.settlements || range?.data?.settlements || range?.data || (Array.isArray(range) ? range : []);

  const lines: GatewaySettlementLine[] = [];
  for (const settlement of settlements) {
    const settlementId = settlement?.settlementId || settlement?.id;
    const state = String(settlement?.state || '').toUpperCase();
    if (!settlementId || (state && state !== 'PROCESSED' && state !== 'COMPLETED')) continue;
    const detail = await phonePeGet(`/settlements/v1/${encodeURIComponent(settlementId)}/transactions`);
    const utr = detail?.utr || settlement?.utr || '';
    const settledAt =
      parseDateLoose(String(settlement?.date || detail?.date || '')) ||
      (Number(settlement?.date) ? new Date(Number(settlement.date)) : new Date());
    for (const order of detail?.orders || []) {
      const details = order?.settlementDetails || {};
      lines.push({
        references: [order?.merchantOrderId, order?.transactionId].filter(Boolean).map(String),
        utr,
        settledAt,
        amount: details.settlementAmount ?? order?.amount ?? null,
        fee:
          details.totalCharges !== undefined || details.totalTax !== undefined
            ? Number(details.totalCharges || 0) + Number(details.totalTax || 0)
            : null,
        settlementRef: String(settlementId),
      });
    }
  }
  return lines;
}

// ─── Easebuzz ───────────────────────────────────────────────

export function easebuzzConfigured(): boolean {
  return Boolean(config.easebuzz.key && config.easebuzz.salt);
}

function ddmmyyyy(date: Date): string {
  const ist = new Date(date.getTime() + 5.5 * 3600 * 1000);
  return `${String(ist.getUTCDate()).padStart(2, '0')}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${ist.getUTCFullYear()}`;
}

/** Settlement lines (one per transaction) Easebuzz paid out between two dates. */
export async function fetchEasebuzzSettlements(from: Date, to: Date): Promise<GatewaySettlementLine[]> {
  if (!easebuzzConfigured()) return [];
  const start = ddmmyyyy(from);
  const end = ddmmyyyy(to);
  const hash = createHash('sha512')
    .update(`${config.easebuzz.key}|${start}|${end}|${config.easebuzz.salt}`)
    .digest('hex');
  const response = await axios.post(
    `${config.easebuzz.apiUrl}/settlements/v1/retrieve`,
    { merchant_key: config.easebuzz.key, payout_date: { start_date: start, end_date: end }, hash },
    { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
  );
  const payouts: any[] = response.data?.payouts_history_data || response.data?.data || response.data?.payouts || [];

  const lines: GatewaySettlementLine[] = [];
  for (const payout of Array.isArray(payouts) ? payouts : []) {
    const utr = payout?.bank_transaction_id || payout?.utr || '';
    const settledAt = parseDateLoose(String(payout?.payout_actual_date || payout?.payout_date || '')) || new Date();
    for (const txn of payout?.peb_transactions || []) {
      lines.push({
        references: [txn?.txnid, txn?.easepayid, txn?.merchant_txnid].filter(Boolean).map(String),
        utr,
        settledAt,
        amount: Number(txn?.peb_settlement_amount ?? txn?.settlement_amount ?? NaN) || null,
        fee: Number(txn?.peb_service_charge || 0) + Number(txn?.peb_service_tax || 0) || null,
        settlementRef: String(payout?.payout_id || payout?.id || utr),
      });
    }
  }
  return lines;
}

// ─── Sync ───────────────────────────────────────────────────

/**
 * Pull the last few days of PhonePe and Easebuzz settlements and record the
 * settlement UTR on the matching prepaid orders.
 */
export async function syncGatewaySettlements(daysBack = 3): Promise<{ phonepe: number; easebuzz: number; unmatched: string[] }> {
  const to = new Date();
  const from = new Date(to.getTime() - daysBack * 24 * 3600 * 1000);
  const result = { phonepe: 0, easebuzz: 0, unmatched: [] as string[] };

  const sources: Array<{ name: 'phonepe' | 'easebuzz'; fetch: () => Promise<GatewaySettlementLine[]>; source: string }> = [
    { name: 'phonepe', fetch: () => fetchPhonePeSettlements(from, to), source: 'PHONEPE_SETTLEMENT_API' },
    { name: 'easebuzz', fetch: () => fetchEasebuzzSettlements(from, to), source: 'EASEBUZZ_PAYOUT_API' },
  ];

  for (const { name, fetch, source } of sources) {
    let lines: GatewaySettlementLine[] = [];
    try {
      lines = await fetch();
    } catch (error: any) {
      logger.error('Gateway settlement fetch failed', { gateway: name, error: error.response?.data || error.message });
      continue;
    }
    for (const line of lines) {
      let order = null;
      for (const ref of line.references) {
        order = await findOrderByReference(ref);
        if (order) break;
      }
      if (!order || order.paymentMethod === 'COD') {
        if (!order) result.unmatched.push(line.references[0] || '?');
        continue;
      }
      const amount =
        name === 'phonepe' ? phonePeAmountToRupees(line.amount, order.totalAmount) : line.amount;
      const fee = name === 'phonepe' && line.fee !== null ? phonePeAmountToRupees(line.fee) : line.fee;
      await recordPaymentReceived(order.id, {
        receivedAt: line.settledAt,
        amount,
        utr: line.utr || null,
        ref: line.settlementRef,
        source,
        gatewayFee: fee,
      });
      result[name]++;
    }
  }
  if (result.phonepe || result.easebuzz) logger.info('Gateway settlements recorded', result);
  return result;
}
