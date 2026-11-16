/**
 * Gmail Settlement Sync Service
 *
 * Automatically monitors, fetches, and reconciles payment gateway payout emails
 * (e.g. daily Easebuzz / GoKwik Settlement Reports with attached CSV / Excel exports).
 *
 * Flow:
 * 1. Authenticates via Google OAuth2 refresh token using standard HTTP (axios, no heavy SDK).
 * 2. Queries Gmail inbox for settlement reports (e.g. from:info@easebuzz.com "Settlement Report" has:attachment).
 * 3. Downloads attached settlement reports (e.g. 2026-11-12-PT7WVA6KEQ-MID-159037.csv).
 * 4. Natively parses multi-section tables (Settled Orders, Split Refund Deductions) & extracts Bank NEFT UTR.
 * 5. Reconciles prepaid orders in OMS with 100% precision (updating paymentReceivedUtr, gatewayFee, ledger).
 * 6. Deduplicates message IDs to guarantee strict idempotency (never processes an email twice).
 */

import axios, { AxiosInstance } from 'axios';
import { config } from '../../config';
import logger from '../../utils/logger';
import prisma from '../../database/prisma';
import { readSpreadsheet } from './spreadsheet';
import { importGatewaySettlement, type ImportResult } from './reconciliation.service';

export interface GmailSettlementSyncResult {
  success: boolean;
  configured: boolean;
  emailsScanned: number;
  emailsProcessed: number;
  settlementsImported: number;
  matchedOrdersCount: number;
  refundsDebitedCount: number;
  totalAmountSettled: number;
  results: Array<{
    messageId: string;
    subject: string;
    fileName: string;
    utr?: string | null;
    matchedCount: number;
    rowCount: number;
  }>;
  errors: string[];
}

export class GmailSettlementService {
  private cachedToken: { value: string; expiresAt: number } | null = null;

  /**
   * Check whether Gmail API credentials are fully configured in environment.
   */
  isConfigured(): boolean {
    return Boolean(
      config.gmail.clientId &&
      config.gmail.clientSecret &&
      config.gmail.refreshToken
    );
  }

  /**
   * Obtain a fresh Google OAuth2 access token using the stored refresh token.
   */
  async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt - 60_000 > Date.now()) {
      return this.cachedToken.value;
    }

    if (!this.isConfigured()) {
      throw new Error(
        'Gmail credentials not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN.'
      );
    }

    try {
      const response = await axios.post(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({
          client_id: config.gmail.clientId,
          client_secret: config.gmail.clientSecret,
          refresh_token: config.gmail.refreshToken,
          grant_type: 'refresh_token',
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15000,
        }
      );

      const token = response.data?.access_token;
      if (!token) {
        throw new Error('Google OAuth token endpoint returned no access_token');
      }

      const expiresIn = Number(response.data?.expires_in) || 3600;
      this.cachedToken = {
        value: token,
        expiresAt: Date.now() + expiresIn * 1000,
      };

      return token;
    } catch (error: any) {
      const errMsg = error.response?.data?.error_description || error.response?.data?.error || error.message;
      logger.error('Failed to obtain Google OAuth2 access token for Gmail', { error: errMsg });
      throw new Error(`Google OAuth2 authentication failed: ${errMsg}`);
    }
  }

  /**
   * Create an authenticated Axios client for the Gmail API.
   */
  private async getClient(): Promise<AxiosInstance> {
    const token = await this.getAccessToken();
    return axios.create({
      baseURL: 'https://gmail.googleapis.com/gmail/v1/users',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  /**
   * Check if a specific Gmail message ID was already reconciled.
   */
  async isMessageProcessed(messageId: string): Promise<boolean> {
    const key = `gmail_processed_${messageId}`;
    const setting = await prisma.setting.findUnique({ where: { key } });
    if (setting) return true;

    // Also check if an existing ReconciliationImport references this messageId
    const existingImport = await prisma.reconciliationImport.findFirst({
      where: { fileName: { contains: messageId } },
      select: { id: true },
    });
    return Boolean(existingImport);
  }

  /**
   * Mark a message as processed in the database to prevent duplicate reconciliation.
   */
  async markMessageProcessed(messageId: string, metadata: Record<string, any> = {}): Promise<void> {
    const key = `gmail_processed_${messageId}`;
    await prisma.setting.upsert({
      where: { key },
      create: {
        key,
        value: JSON.stringify({ processedAt: new Date().toISOString(), ...metadata }),
      },
      update: {
        value: JSON.stringify({ processedAt: new Date().toISOString(), ...metadata }),
      },
    });
  }

  /**
   * Find all attachment parts inside a recursive MIME message structure.
   */
  private extractAttachmentParts(part: any): Array<{ partId: string; filename: string; attachmentId: string; mimeType: string }> {
    const attachments: Array<{ partId: string; filename: string; attachmentId: string; mimeType: string }> = [];

    if (part?.filename && part?.body?.attachmentId) {
      const lower = part.filename.toLowerCase();
      if (lower.endsWith('.csv') || lower.endsWith('.xlsx') || lower.endsWith('.zip')) {
        attachments.push({
          partId: part.partId,
          filename: part.filename,
          attachmentId: part.body.attachmentId,
          mimeType: part.mimeType,
        });
      }
    }

    if (Array.isArray(part?.parts)) {
      for (const subPart of part.parts) {
        attachments.push(...this.extractAttachmentParts(subPart));
      }
    }

    return attachments;
  }

  /**
   * Scan Gmail for settlement reports, download attachments, and automatically reconcile.
   */
  async syncSettlementEmails(options: {
    query?: string;
    maxMessages?: number;
    unreadOnly?: boolean;
    markAsRead?: boolean;
    forceReimport?: boolean;
  } = {}): Promise<GmailSettlementSyncResult> {
    if (!this.isConfigured()) {
      return {
        success: false,
        configured: false,
        emailsScanned: 0,
        emailsProcessed: 0,
        settlementsImported: 0,
        matchedOrdersCount: 0,
        refundsDebitedCount: 0,
        totalAmountSettled: 0,
        results: [],
        errors: ['Gmail credentials not configured in environment (GMAIL_CLIENT_ID / GMAIL_REFRESH_TOKEN)'],
      };
    }

    const userEmail = config.gmail.userEmail || 'me';
    let query = options.query || config.gmail.settlementQuery || 'from:info@easebuzz.com "Settlement Report" has:attachment';
    if (options.unreadOnly) {
      query += ' is:unread';
    }
    const targetLimit = options.maxMessages || 50;

    const result: GmailSettlementSyncResult = {
      success: true,
      configured: true,
      emailsScanned: 0,
      emailsProcessed: 0,
      settlementsImported: 0,
      matchedOrdersCount: 0,
      refundsDebitedCount: 0,
      totalAmountSettled: 0,
      results: [],
      errors: [],
    };

    try {
      const client = await this.getClient();
      logger.info('Scanning Gmail for settlement reports', { query, userEmail, targetLimit });

      let pageToken: string | undefined = undefined;
      const messages: Array<{ id: string; threadId: string }> = [];

      do {
        const pageSize = Math.min(100, targetLimit - messages.length);
        const listResponse: any = await client.get(`/${userEmail}/messages`, {
          params: { q: query, maxResults: pageSize, pageToken },
        });

        const batch: Array<{ id: string; threadId: string }> = listResponse.data?.messages || [];
        messages.push(...batch);
        pageToken = listResponse.data?.nextPageToken;
      } while (pageToken && messages.length < targetLimit);

      result.emailsScanned = messages.length;

      if (messages.length === 0) {
        logger.info('No new settlement messages found in Gmail matching query', { query });
        return result;
      }

      for (const msgRef of messages) {
        const messageId = msgRef.id;

        if (!options.forceReimport && (await this.isMessageProcessed(messageId))) {
          logger.debug('Skipping already processed Gmail message', { messageId });
          continue;
        }

        try {
          const msgResponse = await client.get(`/${userEmail}/messages/${messageId}`, {
            params: { format: 'full' },
          });

          const msgData = msgResponse.data;
          const headers: Array<{ name: string; value: string }> = msgData?.payload?.headers || [];
          const getHeader = (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

          const subject = getHeader('Subject');
          const emailDate = getHeader('Date');
          const snippet = String(msgData?.snippet || '');

          logger.info('Found settlement email in Gmail', { messageId, subject, date: emailDate });

          // Date boundary check: if email is prior to startDate (e.g. 2026-09-24),
          // mark as read and skip extraction as per user requirement.
          const dateMatch = subject.match(/(\d{4}-\d{2}-\d{2})/);
          const parsedEmailDate = dateMatch ? new Date(dateMatch[1]) : (emailDate ? new Date(emailDate) : null);
          const startDate = config.gmail.startDate ? new Date(config.gmail.startDate) : new Date('2026-09-24');

          if (parsedEmailDate && parsedEmailDate < startDate) {
            logger.info('Settlement email is prior to start date; marking read and skipping data extraction', {
              messageId,
              subject,
              emailDate: parsedEmailDate.toISOString(),
              startDate: startDate.toISOString(),
            });
            await this.markMessageProcessed(messageId, { skippedReason: 'PRIOR_TO_START_DATE', subject });
            if (options.markAsRead !== false) {
              await client.post(`/${userEmail}/messages/${messageId}/modify`, {
                removeLabelIds: ['UNREAD'],
              }).catch(() => null);
            }
            continue;
          }

          // Extract Payout ID hint from Subject or Snippet (e.g. "PT7WVA6KEQ")
          const payoutIdMatch = subject.match(/(PT[A-Z0-9]+)/i) || snippet.match(/Payout\s*ID\s*:\s*([A-Z0-9]+)/i);
          const payoutIdHint = payoutIdMatch ? payoutIdMatch[1] : undefined;

          // Locate all report attachments (.csv, .xlsx, .zip)
          const attachments = this.extractAttachmentParts(msgData?.payload);

          if (attachments.length === 0) {
            logger.warn('Settlement email contains no spreadsheet attachments', { messageId, subject });
            continue;
          }

          let emailHadValidImport = false;

          for (const att of attachments) {
            try {
              const attPayoutId = att.filename.match(/(PT[A-Z0-9]+)/i)?.[1] || payoutIdHint;

              // Check if payout was already imported into GatewaySettlementBatch
              if (!options.forceReimport && attPayoutId) {
                const existingBatch = await prisma.gatewaySettlementBatch.findUnique({
                  where: { batchId: attPayoutId },
                  select: { id: true, batchId: true },
                });
                if (existingBatch) {
                  logger.debug('Skipping already imported settlement batch', { batchId: attPayoutId, messageId });
                  continue;
                }
              }

              const attResponse = await client.get(
                `/${userEmail}/messages/${messageId}/attachments/${att.attachmentId}`
              );

              const rawData = attResponse.data?.data;
              if (!rawData) continue;

              // Base64URL decode directly into in-memory buffer (zero disk write)
              const buffer = Buffer.from(rawData.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
              const sheets = await readSpreadsheet(att.filename, buffer);

              if (!sheets.length) {
                logger.warn('Spreadsheet attachment contained no readable rows', { fileName: att.filename });
                continue;
              }

              // Run native gateway settlement reconciliation & populate GatewaySettlementBatch, Order, Refund
              const importRecord = await importGatewaySettlement(
                `${att.filename}#${messageId}`,
                sheets,
                'gmail-settlement-automation',
                'GOKWIK_SETTLEMENT',
                { name: 'Gmail Settlement Automation', role: 'SYSTEM' },
                { remittanceRef: attPayoutId }
              );

              result.settlementsImported++;
              result.matchedOrdersCount += importRecord.matchedCount;
              result.totalAmountSettled = Math.round((result.totalAmountSettled + (importRecord.totalRemittance || 0)) * 100) / 100;

              // Check if any refunds were debited
              const refundCount = (importRecord.matchedOrders || []).filter((o) => (o.amount || 0) < 0).length;
              result.refundsDebitedCount += refundCount;

              result.results.push({
                messageId,
                subject,
                fileName: att.filename,
                utr: importRecord.bankTransactionId || ((importRecord as any).bankTransactionIds?.[0] ?? null),
                matchedCount: importRecord.matchedCount,
                rowCount: importRecord.rowCount,
              });

              emailHadValidImport = true;
            } catch (attError: any) {
              const msg = `Error importing attachment ${att.filename}: ${attError.message}`;
              logger.error(msg, { messageId, error: attError.message });
              result.errors.push(msg);
            }
          }

          if (emailHadValidImport) {
            result.emailsProcessed++;
            await this.markMessageProcessed(messageId, {
              subject,
              attachmentsCount: attachments.length,
            });

            // Mark email as read in Gmail if requested
            if (options.markAsRead !== false) {
              await client.post(`/${userEmail}/messages/${messageId}/modify`, {
                removeLabelIds: ['UNREAD'],
              }).catch((lblErr) => {
                logger.warn('Could not remove UNREAD label from message', { messageId, error: lblErr.message });
              });
            }
          }
        } catch (msgError: any) {
          const msg = `Error processing message ${messageId}: ${msgError.message}`;
          logger.error(msg, { error: msgError.message });
          result.errors.push(msg);
        }
      }

      logger.info('Completed Gmail settlement sync', {
        scanned: result.emailsScanned,
        processed: result.emailsProcessed,
        imported: result.settlementsImported,
        matched: result.matchedOrdersCount,
        refunds: result.refundsDebitedCount,
      });

      return result;
    } catch (error: any) {
      const errMsg = error.response?.data?.error?.message || error.message;
      logger.error('Gmail settlement sync failed', { error: errMsg });
      result.success = false;
      result.errors.push(`Gmail sync error: ${errMsg}`);
      return result;
    }
  }
}

export const gmailSettlementService = new GmailSettlementService();
export default gmailSettlementService;
