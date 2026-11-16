import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { gmailSettlementService } from '../src/modules/accounts/gmail-settlement.service';
import { config } from '../src/config';
import prisma from '../src/database/prisma';
import * as reconciliationService from '../src/modules/accounts/reconciliation.service';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

describe('Gmail Settlement Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.gmail.clientId = 'test-client-id';
    config.gmail.clientSecret = 'test-client-secret';
    config.gmail.refreshToken = 'test-refresh-token';
    config.gmail.userEmail = 'me';
    config.gmail.settlementQuery = 'from:info@easebuzz.com "Settlement Report" has:attachment';
    (gmailSettlementService as any).cachedToken = null;
    vi.spyOn(prisma.gatewaySettlementBatch, 'findUnique').mockResolvedValue(null);
  });

  describe('Configuration & Authentication', () => {
    it('detects when Gmail API is configured', () => {
      expect(gmailSettlementService.isConfigured()).toBe(true);

      config.gmail.clientId = '';
      expect(gmailSettlementService.isConfigured()).toBe(false);
    });

    it('fetches and caches Google OAuth2 access token via refresh token', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'mock-access-token-123',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      const token = await gmailSettlementService.getAccessToken();
      expect(token).toBe('mock-access-token-123');

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://oauth2.googleapis.com/token',
        expect.any(URLSearchParams),
        expect.objectContaining({ headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
      );

      // Second call uses cache without calling token endpoint again
      const cached = await gmailSettlementService.getAccessToken();
      expect(cached).toBe('mock-access-token-123');
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('Message Deduplication', () => {
    it('checks if a message was already processed via prisma setting or imports', async () => {
      const findUniqueSpy = vi.spyOn(prisma.setting, 'findUnique').mockResolvedValueOnce({
        id: 1,
        key: 'gmail_processed_msg_101',
        value: JSON.stringify({ processedAt: new Date().toISOString() }),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const isProcessed = await gmailSettlementService.isMessageProcessed('msg_101');
      expect(isProcessed).toBe(true);
      expect(findUniqueSpy).toHaveBeenCalledWith({ where: { key: 'gmail_processed_msg_101' } });
    });

    it('marks message as processed in database', async () => {
      const upsertSpy = vi.spyOn(prisma.setting, 'upsert').mockResolvedValueOnce({} as any);

      await gmailSettlementService.markMessageProcessed('msg_102', { subject: 'Settlement Report' });
      expect(upsertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key: 'gmail_processed_msg_102' },
        })
      );
    });
  });

  describe('Full Automated Ingestion & Reconciliation', () => {
    it('queries Gmail, downloads CSV attachment, and calls importGatewaySettlement', async () => {
      // 1. Mock OAuth token
      mockedAxios.post.mockResolvedValueOnce({
        data: { access_token: 'mock-token', expires_in: 3600 },
      });

      // 2. Mock client.get responses
      const mockGet = vi.fn();
      const mockPost = vi.fn().mockResolvedValue({ data: {} });
      mockedAxios.create.mockReturnValue({
        get: mockGet,
        post: mockPost,
      } as any);

      // List messages response
      mockGet.mockResolvedValueOnce({
        data: {
          messages: [{ id: 'msg_test_001', threadId: 'thread_001' }],
        },
      });

      // Message detail response
      mockGet.mockResolvedValueOnce({
        data: {
          id: 'msg_test_001',
          snippet: 'Your payout has been made successfully. Payout ID : PT7WVA6KEQ Amount Paid: 5633.01',
          payload: {
            headers: [
              { name: 'Subject', value: 'Settlement Report for 2026-11-12 - MID-159037' },
              { name: 'Date', value: 'Thu, 12 Nov 2026 11:27:00 +0530' },
            ],
            parts: [
              {
                filename: '2026-11-12-PT7WVA6KEQ-MID-159037.csv',
                mimeType: 'text/csv',
                body: { attachmentId: 'att_999' },
              },
            ],
          },
        },
      });

      // Attachment download response (Base64url CSV data)
      const sampleCsv = [
        '"PAYOUTS - PT7WVA6KEQ"',
        '"BANK DETAILS","","","TRANSACTION DETAILS"',
        '"NEFT Ref. No.","YESF263166456982"',
        '"SETTLED TRANSACTIONS"',
        '"#","Easebuzz Trxn ID","Merchant Trxn ID","Transaction Date","Transaction Amount","Settlement Amount"',
        '"1","E2611111A8MBE1","KWIKBTV1GPNP7802938MP","2026-11-11","1052.52","1021.47"',
        '"SPLIT REFUND TRANSACTIONS"',
        '"#","Refund ID","Easebuzz Trxn ID"',
      ].join('\r\n');

      const base64UrlData = Buffer.from(sampleCsv, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

      mockGet.mockResolvedValueOnce({
        data: { data: base64UrlData },
      });

      // Mock isMessageProcessed to false
      vi.spyOn(prisma.setting, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.reconciliationImport, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.setting, 'upsert').mockResolvedValue({} as any);

      // Mock importGatewaySettlement
      const importSpy = vi.spyOn(reconciliationService, 'importGatewaySettlement').mockResolvedValueOnce({
        kind: 'GOKWIK_SETTLEMENT',
        fileName: '2026-11-12-PT7WVA6KEQ-MID-159037.csv#msg_test_001',
        rowCount: 1,
        matchedCount: 1,
        unmatched: [],
        columns: { order: 'Merchant Trxn ID', date: 'Transaction Date', amount: 'Settlement Amount' },
        notes: [],
        totalRemittance: 1021.47,
        bankTransactionId: 'YESF263166456982',
        state: 'Completed',
        matchedOrders: [
          { orderId: 2290, shopifyOrderName: '#26YOU6456', amount: 1021.47, utr: 'YESF263166456982' },
        ],
        extractedFiles: [],
        storageMode: 'POSTGRESQL_RELATIONAL_DATA',
        zipStoredOnDisk: false,
        bankTransactionIds: ['YESF263166456982'],
        missingUtrCount: 0,
        settlementRefs: ['PT7WVA6KEQ'],
        singleSettlement: true,
      });

      const syncResult = await gmailSettlementService.syncSettlementEmails({
        query: 'from:info@easebuzz.com "Settlement Report"',
      });

      expect(syncResult.success).toBe(true);
      expect(syncResult.emailsScanned).toBe(1);
      expect(syncResult.emailsProcessed).toBe(1);
      expect(syncResult.settlementsImported).toBe(1);
      expect(syncResult.matchedOrdersCount).toBe(1);
      expect(syncResult.totalAmountSettled).toBe(1021.47);
      expect(importSpy).toHaveBeenCalledWith(
        '2026-11-12-PT7WVA6KEQ-MID-159037.csv#msg_test_001',
        expect.any(Array),
        'gmail-settlement-automation',
        'GOKWIK_SETTLEMENT',
        expect.any(Object),
        expect.objectContaining({ remittanceRef: 'PT7WVA6KEQ' })
      );

      // Check that UNREAD label was removed
      expect(mockPost).toHaveBeenCalledWith(
        '/me/messages/msg_test_001/modify',
        { removeLabelIds: ['UNREAD'] }
      );
    });

    it('handles multiple payout messages within the same email thread independently', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { access_token: 'mock-token', expires_in: 3600 },
      });

      const mockGet = vi.fn();
      const mockPost = vi.fn().mockResolvedValue({ data: {} });
      mockedAxios.create.mockReturnValue({
        get: mockGet,
        post: mockPost,
      } as any);

      // Thread has 2 distinct payout messages on the same day (9:50 AM and 10:01 AM)
      mockGet.mockResolvedValueOnce({
        data: {
          messages: [
            { id: 'msg_payout_1', threadId: 'thread_multi' },
            { id: 'msg_payout_2', threadId: 'thread_multi' },
          ],
        },
      });

      // Message 1 detail: Payout PTNZB9BN8C
      mockGet.mockResolvedValueOnce({
        data: {
          id: 'msg_payout_1',
          snippet: 'Payout ID : PTNZB9BN8C Amount Paid : 7735.97',
          payload: {
            headers: [{ name: 'Subject', value: 'Settlement Report for 2026-11-16 - MID-159037' }],
            parts: [{ filename: '2026-11-16-PTNZB9BN8C-MID-159037.csv', mimeType: 'text/csv', body: { attachmentId: 'att_1' } }],
          },
        },
      });

      const csvData1 = Buffer.from('"PAYOUTS - PTNZB9BN8C"\r\n"NEFT Ref. No.","YESF111"\r\n"SETTLED TRANSACTIONS"\r\n"#","Merchant Trxn ID","Settlement Amount"\r\n"1","KWIK1","7735.97"')
        .toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
      mockGet.mockResolvedValueOnce({ data: { data: csvData1 } });

      // Message 2 detail: Payout PTXOPPF8CU
      mockGet.mockResolvedValueOnce({
        data: {
          id: 'msg_payout_2',
          snippet: 'Payout ID : PTXOPPF8CU Amount Paid : 7362.27',
          payload: {
            headers: [{ name: 'Subject', value: 'Settlement Report for 2026-11-16 - MID-159037' }],
            parts: [{ filename: '2026-11-16-PTXOPPF8CU-MID-159037.csv', mimeType: 'text/csv', body: { attachmentId: 'att_2' } }],
          },
        },
      });

      const csvData2 = Buffer.from('"PAYOUTS - PTXOPPF8CU"\r\n"NEFT Ref. No.","YESF222"\r\n"SETTLED TRANSACTIONS"\r\n"#","Merchant Trxn ID","Settlement Amount"\r\n"1","KWIK2","7362.27"')
        .toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
      mockGet.mockResolvedValueOnce({ data: { data: csvData2 } });

      vi.spyOn(prisma.setting, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.gatewaySettlementBatch, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.setting, 'upsert').mockResolvedValue({} as any);

      const importSpy = vi.spyOn(reconciliationService, 'importGatewaySettlement')
        .mockResolvedValueOnce({
          kind: 'GOKWIK_SETTLEMENT',
          fileName: '2026-11-16-PTNZB9BN8C-MID-159037.csv#msg_payout_1',
          rowCount: 1,
          matchedCount: 1,
          unmatched: [],
          columns: {} as any,
          notes: [],
          totalRemittance: 7735.97,
          bankTransactionId: 'YESF111',
          state: 'Completed',
          matchedOrders: [],
          extractedFiles: [],
          storageMode: 'POSTGRESQL_RELATIONAL_DATA',
          zipStoredOnDisk: false,
        })
        .mockResolvedValueOnce({
          kind: 'GOKWIK_SETTLEMENT',
          fileName: '2026-11-16-PTXOPPF8CU-MID-159037.csv#msg_payout_2',
          rowCount: 1,
          matchedCount: 1,
          unmatched: [],
          columns: {} as any,
          notes: [],
          totalRemittance: 7362.27,
          bankTransactionId: 'YESF222',
          state: 'Completed',
          matchedOrders: [],
          extractedFiles: [],
          storageMode: 'POSTGRESQL_RELATIONAL_DATA',
          zipStoredOnDisk: false,
        });

      const syncResult = await gmailSettlementService.syncSettlementEmails({
        unreadOnly: true,
      });

      expect(syncResult.success).toBe(true);
      expect(syncResult.emailsProcessed).toBe(2);
      expect(syncResult.settlementsImported).toBe(2);
      expect(syncResult.totalAmountSettled).toBe(15098.24);
      expect(importSpy).toHaveBeenCalledTimes(2);
      expect(mockPost).toHaveBeenCalledWith('/me/messages/msg_payout_1/modify', { removeLabelIds: ['UNREAD'] });
      expect(mockPost).toHaveBeenCalledWith('/me/messages/msg_payout_2/modify', { removeLabelIds: ['UNREAD'] });
    });
  });
});
