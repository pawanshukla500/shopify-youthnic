/**
 * Unit tests that pin the Youthnic email-brand identity.
 *
 * Verifies:
 *   - The logo in the email header uses a hosted HTTPS URL (NOT a base64
 *     data URI) — so Outlook desktop / Mac clients render it.
 *   - The image tag has explicit width/height so it renders at a stable
 *     size even when the email client blocks remote image fetches.
 *   - The sender-desk pill renders small + lowercase (the
 *     all-caps DELIVERY@YOUTHNIC.COM bug is gone).
 *   - Brand tagline is rendered from the config.brand.tagline default.
 *
 * No real Resend calls — we render the template and assert on the HTML.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/database/prisma', () => ({ default: {} }));
vi.mock('../src/modules/firebase/firebase.service', () => ({
  default: { uploadOrderArtifact: vi.fn() },
}));

const HOSTED_LOGO_URL =
  'https://storage.googleapis.com/shopify-134b9.firebasestorage.app/public/youthnic-logo.png';

vi.mock('../src/config', () => ({
  config: {
    resend: {
      apiKey: 'test',
      fromEmail: 'Youthnic <delivery@youthnic.com>',
      apiUrl: 'https://api.resend.com',
    },
    brand: {
      logoUrl: HOSTED_LOGO_URL,
      tagline: 'Modernly Ethnic · Surat Fulfillment Center',
    },
  },
}));

describe('Youthnic email brand identity', () => {
  let renderTransitDelay: any;

  beforeAll(async () => {
    const mod = await import('../src/modules/email/email-templates');
    renderTransitDelay = mod.renderTransitDelayEmail;
  });

  const minimalData = {
    orderName: '#1001',
    customerName: 'Test Customer',
    trackingUrl: 'https://shopify.youthnic.shop/api/communications/track/123',
    waybillNumber: '30100810009251',
  };

  it('renders the logo as a hosted HTTPS URL, NOT a base64 data URI', async () => {
    const { html } = renderTransitDelay(
      'In Transit Delay',
      'Dear Test,',
      'Package delayed.',
      minimalData
    );
    expect(html).toContain(`src="${HOSTED_LOGO_URL}"`);
    // Must NOT contain a base64 logo anymore
    expect(html).not.toMatch(/src="data:image\/png;base64,iVBOR/);
  });

  it('gives the logo an explicit width and height so the layout holds when images are blocked', async () => {
    const { html } = renderTransitDelay(
      'In Transit Delay',
      'Dear Test,',
      'Package delayed.',
      minimalData
    );
    const logoMatch = html.match(/<img[^>]*src="[^"]*youthnic-logo\.png"[^>]*>/);
    expect(logoMatch).not.toBeNull();
    expect(logoMatch![0]).toMatch(/width=/);
    expect(logoMatch![0]).toMatch(/height=/);
  });

  it('renders the sender-desk pill as lowercase email (not all-caps)', async () => {
    const { html } = renderTransitDelay(
      'In Transit Delay',
      'Dear Test,',
      'Package delayed.',
      minimalData
    );
    // The transit-delay template uses delivery@youthnic.com as the badge.
    expect(html).toMatch(/delivery@youthnic\.com/);
    // The legacy all-caps version must be gone.
    expect(html).not.toMatch(/DELIVERY@YOUTHNIC\.COM/);
  });

  it('drops the fake PROP0000031386 fallback when no waybill is present', async () => {
    const { html } = renderTransitDelay(
      'In Transit Delay',
      'Dear Test,',
      'Package delayed.',
      { ...minimalData, waybillNumber: '' }
    );
    expect(html).not.toContain('PROP0000031386');
  });

  it('includes the "Track on Delhivery" CTA button so the customer knows the link is third-party', async () => {
    const { html } = renderTransitDelay(
      'In Transit Delay',
      'Dear Test,',
      'Package delayed.',
      minimalData
    );
    expect(html).toMatch(/Track on Delhivery/);
    expect(html).toMatch(/Live tracking powered by Delhivery Express/);
  });

  it('uses the config.brand.tagline under the logo', async () => {
    const { html } = renderTransitDelay(
      'In Transit Delay',
      'Dear Test,',
      'Package delayed.',
      minimalData
    );
    expect(html).toContain('Modernly Ethnic · Surat Fulfillment Center');
  });
});