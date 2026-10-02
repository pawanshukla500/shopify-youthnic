/**
 * Detect AWS SigV4 (and legacy Expires=) signed URLs that Delhivery packing
 * slips use. Those links die within hours; opening a stale one returns S3
 * AccessDenied XML ("Request has expired") instead of a PDF.
 */
export function isExpiredSignedUrl(url: string | null | undefined, skewMs = 60_000): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    const amzDate = parsed.searchParams.get('X-Amz-Date');
    const amzExpires = parsed.searchParams.get('X-Amz-Expires');
    if (amzDate && amzExpires && /^\d+$/.test(amzExpires)) {
      const match = amzDate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      if (match) {
        const start = Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6])
        );
        return Date.now() + skewMs >= start + Number(amzExpires) * 1000;
      }
    }
    const legacy = parsed.searchParams.get('Expires');
    if (legacy && /^\d{9,}$/.test(legacy)) {
      return Date.now() + skewMs >= Number(legacy) * 1000;
    }
    return false;
  } catch {
    return false;
  }
}

export function isUsableHttpUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && url.startsWith('http') && !isExpiredSignedUrl(url);
}
