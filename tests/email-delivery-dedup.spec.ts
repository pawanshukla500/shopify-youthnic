import { beforeEach, describe, expect, it, vi } from 'vitest';

const { axiosPost } = vi.hoisted(() => ({ axiosPost: vi.fn() }));
vi.mock('axios', () => ({ default: { post: axiosPost } }));

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { emailLogStub } = vi.hoisted(() => ({
  emailLogStub: {
    findDeliveredNotification: vi.fn(),
    createLog: vi.fn(),
    updateStatus: vi.fn(),
  },
}));
vi.mock('../src/modules/email/email-log.service', () => ({ default: emailLogStub }));

vi.mock('../src/config', () => ({
  config: {
    appBaseUrl: 'https://oms.youthnic.com',
    resend: {
      apiKey: 'test-key',
      fromEmail: 'Youthnic <delivery@youthnic.com>',
      replyToEmail: 'contact@youthnic.com',
      apiUrl: 'https://api.resend.com',
    },
    brand: {
      logoUrl: 'https://cdn.example.com/youthnic-logo.png',
      tagline: 'Modernly Ethnic · Surat Fulfillment Center',
    },
  },
}));

import resendService from '../src/modules/email/resend.service';

describe('Resend customer email idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not send a refund email twice for the same order', async () => {
    emailLogStub.findDeliveredNotification.mockResolvedValue({
      id: 44,
      subject: 'Refund complete',
    });

    const result = await resendService.sendEmail({
      to: 'customer@example.com',
      templateType: 'RETURN_REFUND',
      orderId: 1001,
      data: { orderName: '#1001', customerName: 'Customer' },
    });

    expect(result).toMatchObject({ success: true, mode: 'SKIPPED', logId: 44 });
    expect(emailLogStub.createLog).not.toHaveBeenCalled();
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it('sets every outbound reply address to the Google Workspace support inbox', async () => {
    emailLogStub.findDeliveredNotification.mockResolvedValue(null);
    emailLogStub.createLog.mockResolvedValue({ id: 45 });
    emailLogStub.updateStatus.mockResolvedValue({ id: 45, resendId: 'res_45' });
    axiosPost.mockResolvedValue({ data: { id: 'res_45' } });

    await resendService.sendEmail({
      to: 'customer@example.com',
      templateType: 'SUPPORT_REPLY',
      orderId: 1002,
      replyTo: 'return@youthnic.com',
      data: { orderName: '#1002', customerName: 'Customer' },
    });

    expect(axiosPost).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reply_to: 'contact@youthnic.com' }),
      expect.any(Object)
    );
  });
});
