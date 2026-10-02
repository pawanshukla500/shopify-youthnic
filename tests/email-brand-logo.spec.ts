/**
 * Unit tests that pin the Youthnic email-brand identity across every render
 * function (transit delay, return initiated, refund, support reply, etc.).
 *
 * Verifies:
 *   - The logo in the email header uses a hosted HTTPS URL (NOT a base64
 *     data URI) — so Outlook desktop / Mac clients render it.
 *   - The image tag has explicit width/height so it renders at a stable
 *     size even when the email client blocks remote image fetches.
 *   - The sender-desk pill renders small + lowercase (the
 *     all-caps DELIVERY@YOUTHNIC.COM bug is gone in EVERY template).
 *   - Brand tagline is rendered from the config.brand.tagline default.
 *
 * No real Resend calls — we render templates and assert on the HTML.
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
  let templates: any;
  let renderTransitDelay: any;
  let renderReturnInitiated: any;
  let renderReturnRefund: any;
  let renderSupportReply: any;
  let renderNdrEmail: any;

  beforeAll(async () => {
    templates = await import('../src/modules/email/email-templates');
    renderTransitDelay = templates.renderTransitDelayEmail;
    renderReturnInitiated = templates.renderReturnInitiatedEmail;
    renderReturnRefund = templates.renderReturnRefundEmail;
    renderSupportReply = templates.renderSupportReplyEmail;
    renderNdrEmail = templates.renderNdrEmail;
  });

  const baseData = {
    orderName: '#1001',
    customerName: 'Test Customer',
    trackingUrl: 'https://shopify.youthnic.shop/api/communications/track/123',
    waybillNumber: '30100810009251',
  };

  // Helper: assert the brand invariants on any HTML output.
  function assertBrandInvariants(html: string, ctx: string) {
    // Logo: hosted URL, not base64.
    expect(html, `${ctx}: logo must be hosted URL`).toContain(`src="${HOSTED_LOGO_URL}"`);
    expect(html, `${ctx}: no base64 inline logo`).not.toMatch(
      /src="data:image\/png;base64,iVBOR/
    );
    // Logo must have explicit width/height for layout stability.
    const logoMatch = html.match(/<img[^>]*src="[^"]*youthnic-logo\.png"[^>]*>/);
    expect(logoMatch, `${ctx}: <img> tag present`).not.toBeNull();
    expect(logoMatch![0], `${ctx}: width attr`).toMatch(/width=/);
    expect(logoMatch![0], `${ctx}: height attr`).toMatch(/height=/);
    // Brand tagline from config.
    expect(html, `${ctx}: tagline`).toContain('Modernly Ethnic · Surat Fulfillment Center');
    // ALL-CAPS legacy must be gone from this template too.
    expect(html, `${ctx}: no DELIVERY@YOUTHNIC.COM`).not.toMatch(/DELIVERY@YOUTHNIC\.COM/);
    expect(html, `${ctx}: no RETURN@YOUTHNIC.COM`).not.toMatch(/RETURN@YOUTHNIC\.COM/);
    expect(html, `${ctx}: no REFUND@YOUTHNIC.COM`).not.toMatch(/REFUND@YOUTHNIC\.COM/);
    expect(html, `${ctx}: no CONTACT@YOUTHNIC.COM`).not.toMatch(/CONTACT@YOUTHNIC\.COM/);
  }

  it('transit delay: brand invariants hold', () => {
    const { html } = renderTransitDelay(
      'In Transit Delay',
      'Dear Test,',
      'Package delayed.',
      baseData
    );
    assertBrandInvariants(html, 'transit-delay');
    expect(html).toMatch(/delivery@youthnic\.com/);
    expect(html).toMatch(/Track on Delhivery/);
  });

  it('uses the current WhatsApp helpline in the shared customer-care footer', () => {
    const { html } = renderTransitDelay(baseData);
    expect(html).toContain('+91 79849 84563');
    expect(html).toContain('https://wa.me/917984984563');
    expect(html).not.toContain('88661 54721');
  });

  it('return initiated: brand invariants hold', () => {
    const { html } = renderReturnInitiated(baseData);
    assertBrandInvariants(html, 'return-initiated');
    expect(html).toMatch(/returns@youthnic\.com/);
  });

  it('return refund: brand invariants hold', () => {
    const { html } = renderReturnRefund(baseData);
    assertBrandInvariants(html, 'return-refund');
    expect(html).toMatch(/refunds@youthnic\.com/);
  });

  it('support reply: brand invariants hold', () => {
    const { html } = renderSupportReply(baseData);
    assertBrandInvariants(html, 'support-reply');
    expect(html).toMatch(/support@youthnic\.com/);
  });

  it('ndr: brand invariants hold', () => {
    const { html } = renderNdrEmail(baseData);
    assertBrandInvariants(html, 'ndr');
    expect(html).toMatch(/delivery@youthnic\.com/);
  });

  it('drops the fake PROP0000031386 fallback across all templates', () => {
    for (const [name, fn] of [
      ['transit-delay', renderTransitDelay],
      ['return-initiated', renderReturnInitiated],
      ['return-refund', renderReturnRefund],
      ['support-reply', renderSupportReply],
      ['ndr', renderNdrEmail],
    ] as const) {
      const html = (fn as any)(baseData, ...(name === 'transit-delay' ? ['Dear Test,', 'Body.'] : []));
      expect(html.html, `${name}: no fake AWB`).not.toContain('PROP0000031386');
    }
  });

  it('delhivery tracking link uses the official Delhivery URL', () => {
    const { html } = renderTransitDelay(
      'In Transit Delay',
      'Dear Test,',
      'Body.',
      baseData
    );
    expect(html).toMatch(/delhivery\.com\/track\/package\//);
    expect(html).toMatch(/rel="noopener noreferrer"/);
  });
});