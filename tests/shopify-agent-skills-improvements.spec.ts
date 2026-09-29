import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRetryAfterMs, withRetry, isRetryableError } from '../src/utils/retry';
import { isDuplicateWebhook, resetWebhookCache } from '../src/routes/webhooks';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock axios for shopifyService tests
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockGet = vi.fn();

vi.mock('axios', () => {
  const client = {
    interceptors: { request: { use: vi.fn() } },
    get: (...args: any[]) => mockGet(...args),
    post: (...args: any[]) => mockPost(...args),
    put: (...args: any[]) => mockPut(...args),
  };
  return { default: { create: vi.fn(() => client) } };
});

const { prismaStub } = vi.hoisted(() => ({
  prismaStub: {
    order: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    orderItem: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    shipment: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    syncLog: { create: vi.fn() },
  },
}));
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));

import shopifyService from '../src/modules/shopify/shopify.service';

describe('Shopify Agent Skills Improvements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWebhookCache();
  });

  describe('Rate Limiting & Retry-After Handling', () => {
    it('getRetryAfterMs extracts seconds from integer Retry-After header', () => {
      const error: any = {
        response: {
          headers: {
            'retry-after': '3',
          },
        },
      };
      expect(getRetryAfterMs(error)).toBe(3000);
    });

    it('getRetryAfterMs extracts ms from HTTP Date Retry-After header', () => {
      const future = new Date(Date.now() + 5000).toUTCString();
      const error: any = {
        response: {
          headers: {
            'retry-after': future,
          },
        },
      };
      const ms = getRetryAfterMs(error);
      expect(typeof ms).toBe('number');
      expect(ms).toBeGreaterThanOrEqual(4000);
      expect(ms).toBeLessThanOrEqual(6000);
    });

    it('getRetryAfterMs returns null if no header present', () => {
      expect(getRetryAfterMs({})).toBeNull();
      expect(getRetryAfterMs({ response: {} })).toBeNull();
      expect(getRetryAfterMs({ response: { headers: {} } })).toBeNull();
    });

    it('isRetryableError identifies GraphQL THROTTLED errors', () => {
      const throttledErr: any = new Error('Throttled');
      throttledErr.code = 'THROTTLED';
      expect(isRetryableError(throttledErr)).toBe(true);

      const msgErr = new Error('Shopify rate limit exceeded (THROTTLED)');
      expect(isRetryableError(msgErr)).toBe(true);
    });

    it('withRetry respects Retry-After delay when retrying 429', async () => {
      const err429: any = new Error('rate limited');
      err429.response = { status: 429, headers: { 'retry-after': '0.01' } };

      const fn = vi.fn().mockRejectedValueOnce(err429).mockResolvedValueOnce('success');
      const res = await withRetry(fn, { attempts: 2, baseDelayMs: 1 });
      expect(res).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('GraphQL Client & Schema Validated Operations', () => {
    it('shopifyService.graphql executes query and returns data', async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          data: {
            shop: { name: 'Youthnic Store' },
          },
        },
      });

      const res = await shopifyService.graphql<any>('{ shop { name } }');
      expect(res).toEqual({ shop: { name: 'Youthnic Store' } });
      expect(mockPost).toHaveBeenCalledWith(
        '/graphql.json',
        expect.objectContaining({ query: '{ shop { name } }' })
      );
    });

    it('shopifyService.graphql throws on THROTTLED GraphQL error with THROTTLED code', async () => {
      mockPost.mockResolvedValue({
        data: {
          errors: [
            {
              message: 'Throttled',
              extensions: { code: 'THROTTLED' },
            },
          ],
        },
      });

      await expect(shopifyService.graphql('{ shop { name } }')).rejects.toMatchObject({
        code: 'THROTTLED',
        message: expect.stringContaining('Shopify GraphQL Error: Throttled'),
      });
    });

    it('shopifyService.setOrderMetafields sends validated metafieldsSet mutation', async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          data: {
            metafieldsSet: {
              metafields: [
                { id: 'gid://shopify/Metafield/1', namespace: 'youthnic', key: 'waybill_number', value: 'DEL123' },
              ],
              userErrors: [],
            },
          },
        },
      });

      const result = await shopifyService.setOrderMetafields('1001', [
        { key: 'waybill_number', value: 'DEL123' },
      ]);

      expect(result.success).toBe(true);
      expect(result.metafields).toBeDefined();
      expect(mockPost).toHaveBeenCalledWith(
        '/graphql.json',
        expect.objectContaining({
          variables: {
            metafields: [
              {
                ownerId: 'gid://shopify/Order/1001',
                namespace: 'youthnic',
                key: 'waybill_number',
                value: 'DEL123',
                type: 'single_line_text_field',
              },
            ],
          },
        })
      );
    });

    it('shopifyService.addOrderTags uses atomic tagsAdd GraphQL mutation', async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          data: {
            tagsAdd: {
              node: { id: 'gid://shopify/Order/1001', tags: ['DISPATCHED', 'EXPRESS'] },
              userErrors: [],
            },
          },
        },
      });

      const res = await shopifyService.addOrderTags('1001', ['DISPATCHED', 'EXPRESS']);
      expect(res.success).toBe(true);
      expect(res.tags).toEqual(['DISPATCHED', 'EXPRESS']);
      expect(mockPost).toHaveBeenCalledWith(
        '/graphql.json',
        expect.objectContaining({
          variables: {
            id: 'gid://shopify/Order/1001',
            tags: ['DISPATCHED', 'EXPRESS'],
          },
        })
      );
    });

    it('shopifyService.removeOrderTags uses atomic tagsRemove GraphQL mutation', async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          data: {
            tagsRemove: {
              node: { id: 'gid://shopify/Order/1001', tags: [] },
              userErrors: [],
            },
          },
        },
      });

      const res = await shopifyService.removeOrderTags('1001', ['DISPATCHED']);
      expect(res.success).toBe(true);
      expect(res.tags).toEqual(['DISPATCHED']);
      expect(mockPost).toHaveBeenCalledWith(
        '/graphql.json',
        expect.objectContaining({
          variables: {
            id: 'gid://shopify/Order/1001',
            tags: ['DISPATCHED'],
          },
        })
      );
    });

    it('shopifyService.updateFulfillmentTracking updates tracking via GraphQL', async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          data: {
            fulfillmentTrackingInfoUpdate: {
              fulfillment: { id: 'gid://shopify/Fulfillment/999', status: 'SUCCESS' },
              userErrors: [],
            },
          },
        },
      });

      const res = await shopifyService.updateFulfillmentTracking('999', {
        number: 'DELHI123456',
        url: 'https://delhivery.com/track/DELHI123456',
        company: 'Delhivery',
      });

      expect(res.success).toBe(true);
      expect(res.fulfillment.id).toBe('gid://shopify/Fulfillment/999');
      expect(mockPost).toHaveBeenCalledWith(
        '/graphql.json',
        expect.objectContaining({
          variables: {
            fulfillmentId: 'gid://shopify/Fulfillment/999',
            trackingInfoInput: {
              company: 'Delhivery',
              number: 'DELHI123456',
              url: 'https://delhivery.com/track/DELHI123456',
            },
            notifyCustomer: true,
          },
        })
      );
    });

    it('shopifyService.updateFulfillmentTracking falls back to REST on GraphQL user error', async () => {
      mockPost
        // GraphQL call with userError
        .mockResolvedValueOnce({
          data: {
            data: {
              fulfillmentTrackingInfoUpdate: {
                fulfillment: null,
                userErrors: [{ field: ['fulfillmentId'], message: 'Fulfillment not found' }],
              },
            },
          },
        })
        // REST fallback call
        .mockResolvedValueOnce({
          data: {
            fulfillment: { id: 999 },
          },
        });

      const res = await shopifyService.updateFulfillmentTracking('999', {
        number: 'DELHI123456',
        url: 'https://delhivery.com/track/DELHI123456',
        company: 'Delhivery',
      });

      expect(res.success).toBe(true);
      expect(res.fulfillment.id).toBe(999);
      expect(mockPost).toHaveBeenCalledWith(
        '/fulfillments/999/update_tracking.json',
        expect.objectContaining({
          fulfillment: {
            tracking_info: {
              number: 'DELHI123456',
              url: 'https://delhivery.com/track/DELHI123456',
              company: 'Delhivery',
            },
            notify_customer: true,
          },
        })
      );
    });
  });

  describe('Webhook Deduplication', () => {
    it('isDuplicateWebhook detects duplicate webhook IDs within TTL window', () => {
      const webhookId = 'shopify-hook-uuid-001';
      expect(isDuplicateWebhook(webhookId)).toBe(false);
      expect(isDuplicateWebhook(webhookId)).toBe(true);
      expect(isDuplicateWebhook('shopify-hook-uuid-002')).toBe(false);
    });

    it('resetWebhookCache allows previously seen webhook IDs to be reprocessed', () => {
      const webhookId = 'shopify-hook-uuid-003';
      expect(isDuplicateWebhook(webhookId)).toBe(false);
      expect(isDuplicateWebhook(webhookId)).toBe(true);
      resetWebhookCache();
      expect(isDuplicateWebhook(webhookId)).toBe(false);
    });
  });
});
