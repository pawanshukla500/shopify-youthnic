import { describe, expect, it } from 'vitest';
import { isExpiredSignedUrl, isUsableHttpUrl } from '../src/utils/signed-url';

describe('Delhivery packing-slip signed URLs', () => {
  it('treats the expired S3 packing slip from the operator screenshot as unusable', () => {
    const url =
      'https://express-hq-prod.s3.ap-south-1.amazonaws.com/packing_slip/30100810010205.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260928T044600Z&X-Amz-Expires=86400';
    expect(isExpiredSignedUrl(url)).toBe(true);
    expect(isUsableHttpUrl(url)).toBe(false);
  });

  it('keeps a signature that is still inside its window', () => {
    const start = new Date(Date.now() - 60_000);
    const stamp = start.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const url = `https://express-hq-prod.s3.ap-south-1.amazonaws.com/packing_slip/1.pdf?X-Amz-Date=${stamp}&X-Amz-Expires=86400`;
    expect(isExpiredSignedUrl(url)).toBe(false);
    expect(isUsableHttpUrl(url)).toBe(true);
  });
});
