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

      // Exponential backoff with ±20% jitter to avoid thundering herd on cron
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = exp * (0.8 + Math.random() * 0.4);
      await sleep(Math.round(jitter));
    }
  }
  throw lastError;
}

export default withRetry;
