import { describe, it, expect, vi } from 'vitest';
import { withRetry, isRetryableError } from '../src/utils/retry';

describe('withRetry — prevents API fallback on transient errors', () => {
  it('returns on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 then succeeds', async () => {
    const err429: any = new Error('rate limited');
    err429.response = { status: 429 };
    const fn = vi.fn().mockRejectedValueOnce(err429).mockResolvedValueOnce('recovered');
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1 })).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 400 (permanent)', async () => {
    const err400: any = new Error('bad request');
    err400.response = { status: 400 };
    const fn = vi.fn().mockRejectedValue(err400);
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after max attempts on 503', async () => {
    const err503: any = new Error('unavailable');
    err503.response = { status: 503 };
    const fn = vi.fn().mockRejectedValue(err503);
    await expect(withRetry(fn, { attempts: 2, baseDelayMs: 1 })).rejects.toThrow('unavailable');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('isRetryableError', () => {
  it('marks network codes retryable', () => {
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
  });

  it('marks 429/502/503/504 retryable, 400/401/404 not', () => {
    expect(isRetryableError({ response: { status: 429 } })).toBe(true);
    expect(isRetryableError({ response: { status: 503 } })).toBe(true);
    expect(isRetryableError({ response: { status: 400 } })).toBe(false);
    expect(isRetryableError({ response: { status: 401 } })).toBe(false);
    expect(isRetryableError({ response: { status: 404 } })).toBe(false);
  });
});

describe('auth middleware — WhatsApp webhook stays public (CRM inbound)', () => {
  it('exempts /webhooks/whatsapp from Firebase auth', async () => {
    const { requireAuth } = await import('../src/middleware/auth.middleware');
    const next = vi.fn();
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await requireAuth({ path: '/webhooks/whatsapp', query: {}, headers: {} } as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('still blocks /orders without token', async () => {
    const { requireAuth } = await import('../src/middleware/auth.middleware');
    const next = vi.fn();
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await requireAuth({ path: '/orders', query: {}, headers: {} } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
