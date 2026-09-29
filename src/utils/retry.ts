/**
 * Retry helper with exponential backoff + jitter.
 * Prevents transient courier/gateway blips (network reset, 429, 502/503/504)
 * from surfacing as hard API fallbacks (UNKNOWN tracking, failed sync, lost notification).
 */

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (error: any) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getRetryAfterMs(error: any): number | null {
  const headers = error?.response?.headers;
  if (!headers) return null;

  const retryAfterHeader =
    headers['retry-after'] ||
    headers['Retry-After'] ||
    headers['retry-after-ms'] ||
    headers['Retry-After-Ms'];

  if (!retryAfterHeader) return null;

  if (headers['retry-after-ms'] || headers['Retry-After-Ms']) {
    const ms = parseFloat(String(retryAfterHeader));
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
  }

  const rawStr = String(retryAfterHeader).trim();
  // 1. Check if it's purely a numeric seconds value (integer or float)
  const numeric = parseFloat(rawStr);
  if (!Number.isNaN(numeric) && /^\d+(\.\d+)?$/.test(rawStr)) {
    return numeric > 0 ? Math.round(numeric * 1000) : null;
  }

  // 2. Check if it's an HTTP-Date
  const parsedDate = Date.parse(rawStr);
  if (!Number.isNaN(parsedDate)) {
    const diff = parsedDate - Date.now();
    return diff > 0 ? diff : 0;
  }

  return null;
}

export function isRetryableError(error: any): boolean {
  const code = error?.code as string | undefined;
  const status = error?.response?.status as number | undefined;

  // Network-level transient failures
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ERR_NETWORK'
  ) {
    return true;
  }

  // No response at all (timeout / DNS / socket hangup) — retryable
  if (!status && (error?.request || error?.message?.includes('timeout'))) {
    return true;
  }

  // Rate-limited or upstream unavailable
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  // Shopify GraphQL throttled error
  if (
    error?.extensions?.code === 'THROTTLED' ||
    error?.message?.toLowerCase().includes('throttled') ||
    error?.message?.toLowerCase().includes('rate limit')
  ) {
    return true;
  }

  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 400;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const shouldRetry = options.retryOn ?? isRetryableError;

  let lastError: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const canRetry = attempt < attempts && shouldRetry(error);
      if (!canRetry) throw error;

      const retryAfterMs = getRetryAfterMs(error);
      let delayMs: number;
      if (retryAfterMs !== null) {
        // Honor Shopify Retry-After header with small jitter buffer
        delayMs = Math.min(maxDelayMs, retryAfterMs + 100 + Math.random() * 200);
      } else {
        // Exponential backoff with ±20% jitter to avoid thundering herd on cron
        const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        delayMs = exp * (0.8 + Math.random() * 0.4);
      }
      await sleep(Math.round(delayMs));
    }
  }
  throw lastError;
}

export default withRetry;
