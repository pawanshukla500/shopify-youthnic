import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

vi.mock('../src/utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { kwikengageService } from '../src/modules/whatsapp/kwikengage.service';
import gokwikService from '../src/modules/payments/gokwik.service';
import { config } from '../src/config';

describe('KwikEngage Service (Official WhatsApp API)', () => {
  const originalConfig = { ...config.kwikengage };
  const clientPost = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    config.kwikengage.apiKey = 'test_kwik_key_123';
    config.kwikengage.merchantId = 'test_merchant_456';
    config.kwikengage.apiUrl = 'https://api.kwikengage.ai/send-message/v2';
    config.kwikengage.senderPhone = '+91 79849 84563';
    config.kwikengage.wabaId = '1173075567986214';

    (kwikengageService as any).client = {
      post: clientPost,
    };
  });

  afterEach(() => {
    Object.assign(config.kwikengage, originalConfig);
  });

  describe('Phone Number Normalization', () => {
    it('normalizes 10-digit Indian numbers to 91XXXXXXXXXX format', () => {
      expect(kwikengageService.normalizePhoneNumber('9825012345')).toBe('919825012345');
    });

    it('normalizes formatted numbers like +91 79849 84563 to 917984984563', () => {
      expect(kwikengageService.normalizePhoneNumber('+91 79849 84563')).toBe('917984984563');
    });

    it('leaves already normalized 12-digit numbers starting with 91 intact', () => {
      expect(kwikengageService.normalizePhoneNumber('919825012345')).toBe('919825012345');
    });

    it('returns empty string for invalid numbers', () => {
      expect(kwikengageService.normalizePhoneNumber('')).toBe('');
      expect(kwikengageService.normalizePhoneNumber('abc')).toBe('');
    });
  });

  describe('Official API Payload Formatting & Sending', () => {
    it('sends session text message with official KwikEngage payload', async () => {
      clientPost.mockResolvedValueOnce({
        data: { success: true, messageId: 'kw_msg_001' },
      });

      const res = await kwikengageService.sendTextMessage('9825012345', 'Hello Customer');
      expect(res.success).toBe(true);
      expect(res.messageId).toBe('kw_msg_001');
      expect(res.provider).toBe('KWIKENGAGE_WHATSAPP');
      expect(clientPost).toHaveBeenCalledWith(
        '',
        {
          to: '919825012345',
          channel: 'whatsapp',
          type: 'session',
          content: { type: 'text', text: 'Hello Customer' },
        },
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'test_kwik_key_123',
            'x-api-key': 'test_kwik_key_123',
            'x-merchant-id': 'test_merchant_456',
          }),
        })
      );
    });

    it('formats template messages with parameters and language code', async () => {
      clientPost.mockResolvedValueOnce({
        data: { status: 'sent', message_id: 'kw_tmpl_789' },
      });

      const res = await kwikengageService.sendTemplateMessage(
        '9825012345',
        'order_confirmed',
        ['Pawan', 'YOUTH-1001', '1499'],
        'Fallback text preview'
      );

      expect(res.success).toBe(true);
      expect(res.messageId).toBe('kw_tmpl_789');
      expect(clientPost).toHaveBeenCalledWith(
        '',
        {
          to: '919825012345',
          channel: 'whatsapp',
          type: 'template',
          content: {
            type: 'template',
            template: {
              template_id: 'order_confirmed',
              language: 'en',
              parameters: ['Pawan', 'YOUTH-1001', '1499'],
            },
          },
        },
        expect.any(Object)
      );
    });

    it('formats session media messages with caption', async () => {
      clientPost.mockResolvedValueOnce({
        data: { success: true, id: 'media_001' },
      });

      const res = await kwikengageService.sendMediaMessage(
        '9825012345',
        'https://youthnic.com/cdn/receipt.jpg',
        'image',
        'Your invoice receipt'
      );

      expect(res.success).toBe(true);
      expect(res.messageId).toBe('media_001');
      expect(clientPost).toHaveBeenCalledWith(
        '',
        {
          to: '919825012345',
          channel: 'whatsapp',
          type: 'session',
          content: {
            type: 'media',
            media: {
              url: 'https://youthnic.com/cdn/receipt.jpg',
              type: 'image',
              caption: 'Your invoice receipt',
            },
          },
        },
        expect.any(Object)
      );
    });

    it('detects 24-hour session window expiry and flags requiresTemplate', async () => {
      clientPost.mockRejectedValueOnce({
        response: {
          status: 400,
          data: {
            statusCode: 400,
            message: "You can no longer reply directly to this user as it's been over 24 hours since their last message. You may now only send a template message on WhatsApp",
            error: 'Bad Request',
          },
        },
      });

      const res = await kwikengageService.sendTextMessage('9426279142', 'Test text');
      expect(res.success).toBe(false);
      expect(res.requiresTemplate).toBe(true);
      expect(res.error).toContain('outside 24-hour session window');
    });

    it('builds trigger messages correctly for TRANSIT_DELAY, IN_TRANSIT, and DISPATCH_DELAY', () => {
      const order = {
        customerName: 'Pawan Shukla',
        shopifyOrderName: '#26YOU5752',
        totalAmount: 1499,
      };

      const transitDelayMsg = kwikengageService.buildTriggerMessage('TRANSIT_DELAY', order, {
        waybillNumber: '30100810010054',
        delayReason: 'Logistics routing check',
        newEstimatedDelivery: 'Within 2 days',
      });
      expect(transitDelayMsg).toContain('brief transit delay');
      expect(transitDelayMsg).toContain('30100810010054');
      expect(transitDelayMsg).toContain('Logistics routing check');

      const inTransitMsg = kwikengageService.buildTriggerMessage('IN_TRANSIT', order, {
        waybillNumber: '30100810010054',
        currentLocation: 'Bhiwandi Hub',
      });
      expect(inTransitMsg).toContain('currently in transit');
      expect(inTransitMsg).toContain('Bhiwandi Hub');

      const dispatchDelayMsg = kwikengageService.buildTriggerMessage('DISPATCH_DELAY', order);
      expect(dispatchDelayMsg).toContain('Youthnic Dispatch Update');
      expect(dispatchDelayMsg).toContain('Surat Fulfillment Center');
    });

    it('builds approved template parameters accurately matching Meta approved schemas', () => {
      const order = {
        customerName: 'Pawan Shukla',
        shopifyOrderName: '#26YOU5752',
        totalAmount: 1499,
        paymentMethod: 'Prepaid',
        customerCity: 'Surat',
      };

      const confirmedParams = kwikengageService.buildTriggerTemplateParams('ORDER_CONFIRMED', order);
      expect(confirmedParams).toEqual(['Pawan Shukla', '#26YOU5752', '1499', 'Surat']);

      const shippedParams = kwikengageService.buildTriggerTemplateParams('ORDER_SHIPPED', order, {
        courierName: 'Delhivery Express',
        waybillNumber: '30100810010054',
      });
      expect(shippedParams).toEqual(['Pawan Shukla', '#26YOU5752', 'Delhivery Express', '30100810010054']);

      const ofdParams = kwikengageService.buildTriggerTemplateParams('OUT_FOR_DELIVERY', order, {
        courierName: 'Delhivery Express',
      });
      expect(ofdParams).toEqual(['Pawan Shukla', '#26YOU5752', 'Delhivery Express', 'Prepaid (Already Paid)']);

      const deliveredParams = kwikengageService.buildTriggerTemplateParams('DELIVERED', order);
      expect(deliveredParams).toEqual(['Pawan Shukla', '#26YOU5752']);

      const ndrParams = kwikengageService.buildTriggerTemplateParams('NDR_ALERT', order, {
        ndrReason: 'Customer unreachable / premises closed',
        waybillNumber: '30100810010054',
      });
      expect(ndrParams).toEqual(['Pawan Shukla', '#26YOU5752', 'Customer unreachable / premises closed', '30100810010054']);

      const refundParams = kwikengageService.buildTriggerTemplateParams('REFUND_PROCESSED', order);
      expect(refundParams).toEqual(['Pawan Shukla', '#26YOU5752', '1499', 'Original Payment Method (GoKwik / Easebuzz)']);
    });

    it('falls back to simulation mode cleanly when API key is missing', async () => {
      config.kwikengage.apiKey = '';

      const res = await kwikengageService.sendTextMessage('9825012345', 'Simulated message');
      expect(res.success).toBe(true);
      expect(res.simulated).toBe(true);
      expect(res.messageId).toMatch(/^kwikengage_sim_/);
      expect(clientPost).not.toHaveBeenCalled();
    });
  });

  describe('KwikEngage Delivery Flow Coordination', () => {
    it('skips duplicate WhatsApp dispatch when KwikEngage automated journey flow is active', async () => {
      const sendTriggerSpy = vi.spyOn(kwikengageService, 'sendCriticalTrigger');
      config.kwikengage.flowOrderDeliveredActive = true;
      config.kwikengage.dispatchDelivered = true;

      const notificationEngine = (await import('../src/modules/notifications/notification.service')).default;
      const sendEmailSpy = vi.spyOn(notificationEngine as any, 'sendLifecycleEmail').mockResolvedValue(undefined);

      const mockOrder: any = {
        id: 999,
        customerName: 'Pawan Shukla',
        customerPhone: '9426279142',
        shopifyOrderName: '#26YOU5752',
        totalAmount: 1499,
        customerEmail: 'pawan@example.com',
      };

      await notificationEngine.notifyDelivered(mockOrder, '30100810010054');

      expect(sendTriggerSpy).not.toHaveBeenCalled();
      expect(sendEmailSpy).toHaveBeenCalledWith(mockOrder, 'DELIVERED', {
        waybillNumber: '30100810010054',
        courier: 'Delhivery Express',
      });

      sendTriggerSpy.mockRestore();
      sendEmailSpy.mockRestore();
    });

    it('dispatches WhatsApp template when KwikEngage automated flow is disabled and dispatchDelivered is true', async () => {
      const sendTriggerSpy = vi.spyOn(kwikengageService, 'sendCriticalTrigger').mockResolvedValue({
        success: true,
        provider: 'KWIKENGAGE_WHATSAPP',
        recipient: '919426279142',
      });
      config.kwikengage.flowOrderDeliveredActive = false;
      config.kwikengage.dispatchDelivered = true;

      const notificationEngine = (await import('../src/modules/notifications/notification.service')).default;
      const sendEmailSpy = vi.spyOn(notificationEngine as any, 'sendLifecycleEmail').mockResolvedValue(undefined);

      const mockOrder: any = {
        id: 999,
        customerName: 'Pawan Shukla',
        customerPhone: '9426279142',
        shopifyOrderName: '#26YOU5752',
        totalAmount: 1499,
        customerEmail: 'pawan@example.com',
      };

      await notificationEngine.notifyDelivered(mockOrder, '30100810010054');

      expect(sendTriggerSpy).toHaveBeenCalledWith('DELIVERED', mockOrder, {
        waybillNumber: '30100810010054',
        courierName: 'Delhivery Express',
      });
      expect(sendEmailSpy).toHaveBeenCalledWith(mockOrder, 'DELIVERED', {
        waybillNumber: '30100810010054',
        courier: 'Delhivery Express',
      });

      sendTriggerSpy.mockRestore();
      sendEmailSpy.mockRestore();
    });
  });

  describe('Diagnostic Ping', () => {
    it('returns ok status and latency when endpoint responds', async () => {
      const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
        status: 200,
        data: { status: 'healthy' },
      } as any);

      const ping = await kwikengageService.ping();
      expect(ping.status).toBe('ok');
      expect(ping.latencyMs).toBeGreaterThanOrEqual(0);
      expect(ping.apiKeyConfigured).toBe(true);
      expect(ping.merchantIdConfigured).toBe(true);
      getSpy.mockRestore();
    });

    it('handles simulated state when API key is empty', async () => {
      config.kwikengage.apiKey = '';

      const ping = await kwikengageService.ping();
      expect(ping.status).toBe('ok');
      expect(ping.apiKeyConfigured).toBe(false);
      expect(ping.message).toContain('Sandbox / Simulated Mode');
    });
  });
});

describe('GoKwik Payment & Integrated Refund API', () => {
  const origGkConfig = { ...config.gokwik };
  const gkPost = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    config.gokwik.appId = 'test_gk_app_id';
    config.gokwik.appSecret = 'test_gk_app_secret';
    config.gokwik.merchantId = 'youthnic';
    config.gokwik.apiUrl = 'https://gkx.gokwik.co';
    config.gokwik.verifyEnabled = true;
    config.gokwik.statusPath = '';
    config.gokwik.refundPath = '/v3/orders/update';

    (gokwikService as any).client = {
      post: gkPost,
    };
  });

  afterEach(() => {
    Object.assign(config.gokwik, origGkConfig);
    (gokwikService as any).initClient();
  });

  describe('Order & Payment Status Verification (/v3/orders/fetch)', () => {
    it('fetches order details using merchant_order_id via POST /v3/orders/fetch', async () => {
      gkPost.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            gokwik_order_id: 'GK-98765',
            merchant_order_id: 'YOUTH-1001',
            status: 'CONFIRMED',
            payment_status: 'PAID',
            payment_method: 'UPI',
            total: 1499,
            transaction_id: 'txn_123456',
          },
        },
      });

      const res = await gokwikService.fetchOrder('YOUTH-1001');

      expect(res.success).toBe(true);
      expect(res.data?.merchant_order_id).toBe('YOUTH-1001');
      expect(res.data?.payment_status).toBe('PAID');
      expect(gkPost).toHaveBeenCalledWith(
        '/v3/orders/fetch',
        { merchant_order_id: 'YOUTH-1001' }
      );
    });

    it('verifies paid order status correctly via verifyPayment', async () => {
      gkPost.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            merchant_order_id: 'YOUTH-1001',
            payment_status: 'PAID',
            payment_mode: 'prepaid',
            total: 1499,
            transaction_id: 'txn_123456',
          },
        },
      });

      const res = await gokwikService.verifyPayment('YOUTH-1001');
      expect(res.verified).toBe(true);
      expect(res.status).toBe('PAID');
      expect(res.transactionId).toBe('txn_123456');
      expect(res.amount).toBe(1499);
    });

    it('identifies uncaptured or failed payments correctly', async () => {
      gkPost.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            merchant_order_id: 'YOUTH-1002',
            payment_status: 'FAILED',
          },
        },
      });

      const res = await gokwikService.verifyPayment('YOUTH-1002');
      expect(res.verified).toBe(false);
      expect(res.status).toBe('FAILED');
    });
  });

  describe('Integrated Refund API (/v3/orders/update)', () => {
    it('posts refund amount and note to GoKwik update order endpoint', async () => {
      gkPost.mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            refund_id: 'rfnd_gk_555',
            refund_amount: 599,
            order_status: 'Cancelled',
          },
        },
      });

      const res = await gokwikService.processRefund(
        'YOUTH-1001',
        599,
        'Customer returned size M Kurta',
        { orderStatus: 'Cancelled' }
      );

      expect(res.success).toBe(true);
      expect(res.refundId).toBe('rfnd_gk_555');
      expect(res.message).toContain('Refund request initiated successfully');
      expect(gkPost).toHaveBeenCalledWith(
        '/v3/orders/update',
        {
          merchant_order_id: 'YOUTH-1001',
          refund_amount: 599,
          order_note: 'Customer returned size M Kurta',
          order_status: 'Cancelled',
        }
      );
    });

    it('handles refund failures and captures error message', async () => {
      gkPost.mockRejectedValueOnce({
        response: {
          status: 400,
          data: { error: 'Order cannot be refunded after 30 days' },
        },
      });

      const res = await gokwikService.processRefund(
        'YOUTH-1003',
        899,
        'Late return'
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('Order cannot be refunded after 30 days');
    });
  });

  describe('GoKwik Webhook Processing', () => {
    it('parses refund.successful and normalizes payload structure', () => {
      const webhookPayload = {
        event: 'refund.successful',
        entity: 'refund',
        data: {
          merchant_order_id: 'YOUTH-1001',
          refund_id: 'gk_rf_999',
          amount: 599,
          status: 'SUCCESS',
        },
      };

      const parsed = gokwikService.processWebhook(webhookPayload);
      expect(parsed.isRefund).toBe(true);
      expect(parsed.isPayment).toBe(false);
      expect(parsed.event).toBe('refund.successful');
      expect(parsed.merchantOrderId).toBe('YOUTH-1001');
      expect(parsed.refundId).toBe('gk_rf_999');
      expect(parsed.amount).toBe(599);
    });

    it('parses payment.successful and normalizes payload structure', () => {
      const webhookPayload = {
        event: 'payment.successful',
        entity: 'payment',
        data: {
          merchantReferenceId: 'YOUTH-1005',
          transactionPaymentId: 'pay_gk_888',
          amount: 1999,
          status: 'SUCCESS',
        },
      };

      const parsed = gokwikService.processWebhook(webhookPayload);
      expect(parsed.isPayment).toBe(true);
      expect(parsed.isRefund).toBe(false);
      expect(parsed.merchantOrderId).toBe('YOUTH-1005');
      expect(parsed.paymentId).toBe('pay_gk_888');
      expect(parsed.amount).toBe(1999);
    });
  });
});
