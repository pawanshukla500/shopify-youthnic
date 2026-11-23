import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prismaStub, axiosPost, emailLogStub, kwikengageStub, firebaseStub } = vi.hoisted(() => ({
  prismaStub: {
    order: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    return: { findMany: vi.fn(), update: vi.fn() },
    orderItem: { findMany: vi.fn() },
    gatewaySettlementRefund: { findMany: vi.fn() },
    emailLog: { findMany: vi.fn() },
  },
  axiosPost: vi.fn(),
  emailLogStub: {
    findDeliveredNotification: vi.fn(),
    createLog: vi.fn(),
    updateStatus: vi.fn(),
  },
  kwikengageStub: {
    sendCriticalTrigger: vi.fn(),
  },
  firebaseStub: {
    syncCustomerHistory: vi.fn(),
  },
}));

vi.mock('axios', () => ({
  default: {
    post: axiosPost,
    create: vi.fn(() => ({
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    })),
  },
}));
vi.mock('../src/database/prisma', () => ({ default: prismaStub }));
vi.mock('../src/modules/email/email-log.service', () => ({ default: emailLogStub }));
vi.mock('../src/modules/whatsapp/kwikengage.service', () => ({ default: kwikengageStub }));
vi.mock('../src/modules/firebase/firebase.service', () => ({ default: firebaseStub }));
vi.mock('../src/config', () => ({
  config: {
    appBaseUrl: 'https://oms.youthnic.com',
    shopify: {
      shopDomain: 'test.myshopify.com',
      apiVersion: '2026-07',
      clientId: '',
      clientSecret: '',
      accessToken: 'shpat_test',
      tokenRefreshSkew: 300,
      webhookSecret: 'secret',
      syncStartDate: new Date('2026-09-25T00:00:00+05:30'),
    },
    resend: {
      apiKey: 're_test_key',
      fromEmail: 'Youthnic <delivery@youthnic.com>',
      replyToEmail: 'contact@youthnic.com',
      apiUrl: 'https://api.resend.com',
    },
    brand: {
      logoUrl: 'https://cdn.example.com/youthnic-logo.png',
      tagline: 'Modernly Ethnic · Surat Fulfillment Center',
    },
    delhivery: {
      seller: { pincode: '395002' },
      shippingMode: 'Surface',
    },
  },
}));

import {
  extractRefundDetailsFromShopify,
  formatCustomerRefundSource,
  formatManualRefundSource,
  resolveOrderRefundSummary,
  syncOrderRefundDetails,
} from '../src/modules/returns/refund-details';
import {
  renderRefundRrnUpdateEmail,
  renderReturnRefundEmail,
} from '../src/modules/email/email-templates';
import resendService, { senderForTemplate } from '../src/modules/email/resend.service';
import notificationEngine from '../src/modules/notifications/notification.service';
import shopifyService from '../src/modules/shopify/shopify.service';

describe('Refund RRN, ARN & Source extraction', () => {
  it('extracts Refund RRN, Refund ARN, UPI handle and Easebuzz source from GoKwik Shopify attributes', () => {
    const res = extractRefundDetailsFromShopify({
      noteAttributes: [
        { name: 'GoKwik_Payment_ID', value: 'KWIKYZ427BTU7669682MP' },
        { name: 'Payment_Provider_Name', value: 'easebuzz' },
        { name: 'Payment_Provider_Payment_ID', value: 'E26102218SPE8A' },
        { name: 'Payment_Reference_ID', value: '666125441526' },
        { name: 'Payment_Method', value: 'UPI' },
        { name: 'Payment_Sub_Method', value: '@okicici' },
        { name: 'Refund RRN', value: '104519502377' },
        { name: 'Refund ARN', value: 'RVL9Z7IJ39' },
      ],
      tags: 'GoKwik, Refund_initiated, Refund_credited, Refunded, UPI',
      paymentGateway: 'Gokwik UPI',
      paymentMethod: 'Pre-paid',
      refunds: [
        {
          id: 1118690967751,
          created_at: '2026-11-21T11:50:42+05:30',
          transactions: [
            {
              id: 20976152412359,
              kind: 'refund',
              status: 'success',
              gateway: 'Gokwik UPI',
              payment_id: '#26YOU6138.2',
              amount: '2105.04',
              processed_at: '2026-11-21T11:50:42+05:30',
              receipt: {
                payment_provider: 'easebuzz',
                payment_method: 'UPI',
                payment_sub_method: '@okicici',
                payment_reference_id: '666125441526',
              },
            },
          ],
        },
      ],
    });

    expect(res).toMatchObject({
      paymentInstrument: 'UPI (@okicici)',
      paymentProvider: 'Easebuzz',
      shopifyRefundId: '1118690967751',
      refundTransactionId: '#26YOU6138.2',
      refundRrn: '104519502377',
      refundArn: 'RVL9Z7IJ39',
      refundSource: 'UPI (@okicici) · Easebuzz',
      customerRefundSource: 'Original UPI (@okicici) via Easebuzz',
      refundGatewayStatus: 'CREDITED',
      refundAmount: 2105.04,
    });
  });

  it('never mistakes original checkout Payment_Reference_ID for Refund RRN while refund is still INITIATED', () => {
    const res = extractRefundDetailsFromShopify({
      noteAttributes: [
        { name: 'Payment_Provider_Name', value: 'easebuzz' },
        { name: 'Payment_Reference_ID', value: '630059793263' },
        { name: 'Payment_Method', value: 'UPI' },
        { name: 'Payment_Sub_Method', value: '@ptaxis' },
      ],
      tags: 'GoKwik, Refund_initiated, Refunded, UPI',
      paymentGateway: 'Gokwik UPI',
      paymentMethod: 'Pre-paid',
      refunds: [
        {
          id: 1118855626951,
          created_at: '2026-11-23T12:50:39+05:30',
          transactions: [
            {
              id: 20984269177031,
              kind: 'refund',
              status: 'success',
              gateway: 'Gokwik UPI',
              payment_id: '#26YOU6197.2',
              amount: '1273.02',
              receipt: {
                payment_provider: 'easebuzz',
                payment_reference_id: '630059793263',
                payment_method: 'UPI',
                payment_sub_method: '@ptaxis',
              },
            },
          ],
        },
      ],
    });

    expect(res.refundRrn).toBeNull();
    expect(res.refundArn).toBeNull();
    expect(res.refundGatewayStatus).toBe('INITIATED');
    expect(res.refundSource).toBe('UPI (@ptaxis) · Easebuzz');
    expect(res.shopifyRefundId).toBe('1118855626951');
  });

  it('extracts Card brand + ARN for card refunds and acquirer_data RRN/ARN from direct gateway receipts', () => {
    const cardRes = extractRefundDetailsFromShopify({
      noteAttributes: [
        { name: 'Payment_Provider_Name', value: 'easebuzz' },
        { name: 'Payment_Method', value: 'Cards' },
        { name: 'Payment_Sub_Method', value: 'VISA' },
        { name: 'Refund ARN', value: 'R57DZML587' },
      ],
      tags: 'Cards, Refund_initiated, Refund_credited, Refunded',
      paymentGateway: 'Gokwik Cards',
    });

    expect(cardRes.paymentInstrument).toBe('VISA Card');
    expect(cardRes.refundSource).toBe('VISA Card · Easebuzz');
    expect(cardRes.customerRefundSource).toBe('Original VISA Card via Easebuzz');
    expect(cardRes.refundArn).toBe('R57DZML587');
    expect(cardRes.refundRrn).toBeNull();
    expect(cardRes.refundGatewayStatus).toBe('CREDITED');

    const directRes = extractRefundDetailsFromShopify({
      paymentGateway: 'razorpay',
      transactions: [
        {
          kind: 'refund',
          status: 'success',
          gateway: 'razorpay',
          amount: '999.00',
          receipt: {
            payment_method: 'UPI',
            vpa: '@ybl',
            acquirer_data: { rrn: '631299887766', arn: 'ARN998877' },
          },
        },
      ],
    });
    expect(directRes.refundRrn).toBe('631299887766');
    expect(directRes.refundArn).toBe('ARN998877');
    expect(directRes.refundSource).toBe('UPI (@ybl) · Razorpay');
  });

  it('never leaks Youthnic internal bank account details in customer-facing refund source', () => {
    const adminSource = formatManualRefundSource('UPI', 'HDFC Current ****4321');
    expect(adminSource).toBe('Manual UPI · HDFC Current ****4321');

    const custFromMode = formatCustomerRefundSource({
      manualMode: 'UPI',
      refundSource: adminSource,
    });
    expect(custFromMode).toBe('Direct UPI Transfer');
    expect(custFromMode).not.toContain('HDFC');
    expect(custFromMode).not.toContain('4321');

    const custFromInternalString = formatCustomerRefundSource({
      refundSource: 'Manual Bank Transfer · ICICI Ops 8899',
    });
    expect(custFromInternalString).toBe('Direct Bank Transfer (IMPS / NEFT)');
    expect(custFromInternalString).not.toContain('ICICI');
    expect(custFromInternalString).not.toContain('8899');
  });

  it('merges order, return, gateway settlement refund and email log into one OrderRefundSummary', () => {
    const summary = resolveOrderRefundSummary({
      order: {
        id: 2019,
        totalAmount: 2105.04,
        financialStatus: 'refunded',
        status: 'REFUNDED',
        paymentMethod: 'Pre-paid',
        paymentGateway: 'Gokwik UPI',
        paymentProvider: 'Easebuzz',
        paymentReference: '666125441526',
        tags: 'Refund_initiated, Refund_credited',
        additionalDetails: [
          { name: 'Payment_Method', value: 'UPI' },
          { name: 'Payment_Sub_Method', value: '@okicici' },
          { name: 'Refund RRN', value: '104519502377' },
        ],
      },
      returns: [
        {
          id: 26,
          refundStatus: 'PROCESSED',
          returnStatus: 'REFUNDED',
          refundAmount: 2105.04,
          shopifyRefundId: '1118690967751',
          refundProcessedAt: new Date('2026-11-21T06:20:42Z'),
        },
      ],
      gatewaySettlementRefunds: [
        {
          refundId: 'RVL9Z7IJ39',
          bankUtr: 'HDFCH01421070008',
          refundAmount: 2105.04,
          createdAt: new Date('2026-11-23T07:00:06Z'),
        },
      ],
      refundEmailLogs: [
        {
          id: 900,
          templateType: 'REFUND_RRN_UPDATE',
          status: 'SENT',
          sentAt: new Date('2026-11-21T08:05:00Z'),
        },
      ],
    });

    expect(summary).toMatchObject({
      isRefunded: true,
      isManualCod: false,
      refundAmount: 2105.04,
      shopifyRefundId: '1118690967751',
      refundRrn: '104519502377',
      refundArn: 'RVL9Z7IJ39',
      settlementBatchUtr: 'HDFCH01421070008',
      refundSource: 'UPI (@okicici) · Easebuzz',
      customerRefundSource: 'Original UPI (@okicici) via Easebuzz',
      refundGatewayStatus: 'SETTLED',
      checkoutReference: '666125441526',
    });
    expect(summary.rrnEmailSentAt).toBe('2026-11-21T08:05:00.000Z');
  });
});

describe('Refund customer email templates & delivery deduplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emailLogStub.createLog.mockResolvedValue({ id: 501 });
    emailLogStub.updateStatus.mockResolvedValue({ id: 501, resendId: 'res_501' });
    axiosPost.mockResolvedValue({ data: { id: 'res_501' } });
    kwikengageStub.sendCriticalTrigger.mockResolvedValue({ success: true });
    firebaseStub.syncCustomerHistory.mockResolvedValue(undefined);
    prismaStub.return.update.mockResolvedValue({});
  });

  it('renders Refund RRN, Refund ARN, real Shopify Refund ID & exact Refund Source and escapes HTML', () => {
    const { subject, html } = renderReturnRefundEmail({
      orderName: '#26YOU6138',
      customerName: 'Khushbu <script>alert(1)</script>',
      refundAmount: 2105.04,
      refundId: '1118690967751',
      refundRrn: '104519502377',
      refundArn: 'RVL9Z7IJ39',
      refundSource: 'Original UPI (@okicici) via Easebuzz',
      returnWaybill: 'VELR1494131364',
      refundGatewayStatus: 'CREDITED',
      refundContext: 'RETURN',
    });

    expect(subject).toContain('104519502377');
    expect(subject).toContain('2,105.04');
    expect(html).toContain('104519502377');
    expect(html).toContain('RVL9Z7IJ39');
    expect(html).toContain('1118690967751');
    expect(html).toContain('Original UPI (@okicici) via Easebuzz');
    expect(html).toContain('VELR1494131364');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders RTO and pending-RRN copy accurately without falsely claiming QC inspection', () => {
    const { html } = renderReturnRefundEmail({
      orderName: '#26YOU6197',
      customerName: 'Tanisha',
      refundAmount: 1273.02,
      refundId: '1118855626951',
      refundSource: 'Original UPI (@ptaxis) via Easebuzz',
      refundGatewayStatus: 'INITIATED',
      refundContext: 'RTO',
    });

    expect(html).toContain('undelivered');
    expect(html).toContain('Original UPI (@ptaxis) via Easebuzz');
    expect(html).toContain('Generating via bank network');
    expect(html).not.toContain('Passed & Approved');
  });

  it('renders REFUND_RRN_UPDATE email with prominent Bank RRN and sends from refunds@youthnic.com', () => {
    expect(senderForTemplate('REFUND_RRN_UPDATE').from).toBe('Youthnic Refunds <refunds@youthnic.com>');
    const { subject, html } = renderRefundRrnUpdateEmail({
      orderName: '#26YOU6197',
      customerName: 'Tanisha',
      refundAmount: 1273.02,
      refundId: '1118855626951',
      refundRrn: '104611223344',
      refundArn: 'R9ABC12345',
      refundSource: 'Original UPI (@ptaxis) via Easebuzz',
    });

    expect(subject).toBe('Refund Credited · Bank RRN 104611223344 for Order #26YOU6197 · Youthnic');
    expect(html).toContain('104611223344');
    expect(html).toContain('R9ABC12345');
    expect(html).toContain('Original UPI (@ptaxis) via Easebuzz');
  });

  it('deduplicates automated REFUND_RRN_UPDATE emails but permits explicit operator force resend', async () => {
    emailLogStub.findDeliveredNotification.mockResolvedValueOnce({ id: 77, subject: 'Already sent' });

    const skipped = await resendService.sendEmail({
      to: 'buyer@example.com',
      templateType: 'REFUND_RRN_UPDATE',
      orderId: 2019,
      data: { orderName: '#26YOU6197', customerName: 'Tanisha', refundRrn: '104611223344' },
    });
    expect(skipped).toMatchObject({ success: true, mode: 'SKIPPED', logId: 77 });
    expect(axiosPost).not.toHaveBeenCalled();

    const forced = await resendService.sendEmail({
      to: 'buyer@example.com',
      templateType: 'RETURN_REFUND',
      orderId: 2019,
      force: true,
      data: { orderName: '#26YOU6197', customerName: 'Tanisha', refundRrn: '104611223344', refundAmount: 1273.02 },
    });
    expect(forced).toMatchObject({ success: true, mode: 'LIVE' });
    expect(axiosPost).toHaveBeenCalledTimes(1);
  });

  it('notifyRefundRrnUpdated sends REFUND_RRN_UPDATE when earlier RETURN_REFUND lacked RRN, and skips if already sent with same RRN', async () => {
    const order = {
      id: 2019,
      shopifyOrderName: '#26YOU6197',
      shopifyOrderNumber: 6197,
      customerName: 'Tanisha',
      customerEmail: 'tanisha@example.com',
      customerPhone: '919999999999',
      totalAmount: 1273.02,
      paymentMethod: 'Pre-paid',
      paymentGateway: 'Gokwik UPI',
      paymentProvider: 'Easebuzz',
    } as any;

    const summary = resolveOrderRefundSummary({
      order: {
        ...order,
        financialStatus: 'refunded',
        refundRrn: '104611223344',
        refundArn: 'R9ABC12345',
        refundSource: 'UPI (@ptaxis) · Easebuzz',
      },
      returns: [{ id: 24, shopifyRefundId: '1118855626951', refundStatus: 'PROCESSED', refundAmount: 1273.02 }],
    });

    // Prior RETURN_REFUND had no RRN -> should send REFUND_RRN_UPDATE
    emailLogStub.findDeliveredNotification
      .mockResolvedValueOnce({ id: 3855, metadata: { refundId: '1118855626951', refundRrn: null } })
      .mockResolvedValueOnce(null);

    const sent = await notificationEngine.notifyRefundRrnUpdated(order, summary, { id: 24 } as any);
    expect(sent).toBe(true);
    expect(emailLogStub.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        templateType: 'REFUND_RRN_UPDATE',
        metadata: expect.objectContaining({
          refundRrn: '104611223344',
          refundArn: 'R9ABC12345',
          refundSource: 'Original UPI (@ptaxis) via Easebuzz',
        }),
      })
    );

    // Prior RETURN_REFUND already carried this exact RRN -> skip!
    vi.clearAllMocks();
    emailLogStub.findDeliveredNotification.mockResolvedValueOnce({
      id: 3856,
      metadata: { refundRrn: '104611223344' },
    });
    const skipped = await notificationEngine.notifyRefundRrnUpdated(order, summary, { id: 24 } as any);
    expect(skipped).toBe(false);
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it('syncOrderRefundDetails fetches live Shopify RRN/ARN, persists to Order & Return, and triggers RRN email once', async () => {
    const baseOrder = {
      id: 2019,
      shopifyOrderId: '18968329158855',
      shopifyOrderName: '#26YOU6197',
      shopifyOrderNumber: 6197,
      customerName: 'Tanisha',
      customerEmail: 'tanisha@example.com',
      customerPhone: '919999999999',
      totalAmount: 1273.02,
      paymentMethod: 'Pre-paid',
      paymentGateway: 'Gokwik UPI',
      paymentProvider: 'Easebuzz',
      financialStatus: 'refunded',
      status: 'REFUNDED',
      tags: 'GoKwik, Refund_initiated, Refunded',
      additionalDetails: [{ name: 'Payment_Method', value: 'UPI' }, { name: 'Payment_Sub_Method', value: '@ptaxis' }],
      refundRrn: null,
      refundArn: null,
      refundSource: null,
      refundGatewayStatus: 'INITIATED',
      items: [],
      returns: [
        {
          id: 24,
          isExchange: false,
          returnStatus: 'REFUNDED',
          refundStatus: 'PROCESSED',
          shopifyRefundId: '1118855626951',
          refundAmount: 1273.02,
          refundProcessedAt: new Date(),
          refundRrn: null,
          refundArn: null,
          refundSource: null,
          refundGatewayStatus: 'INITIATED',
          items: [],
        },
      ],
      accountTrailEvents: [],
    };

    prismaStub.order.findUnique
      .mockResolvedValueOnce(baseOrder)
      .mockResolvedValueOnce({
        ...baseOrder,
        refundRrn: '104611223344',
        refundArn: 'R9ABC12345',
        refundSource: 'UPI (@ptaxis) · Easebuzz',
        refundGatewayStatus: 'CREDITED',
      });
    prismaStub.gatewaySettlementRefund.findMany.mockResolvedValue([]);
    prismaStub.emailLog.findMany.mockResolvedValue([]);
    prismaStub.order.update.mockResolvedValue({});
    prismaStub.return.update.mockResolvedValue({});

    vi.spyOn(shopifyService, 'fetchOrderRefundData').mockResolvedValueOnce({
      order: {
        tags: 'GoKwik, Refund_initiated, Refund_credited, Refunded',
        payment_gateway_names: ['Gokwik UPI'],
        note_attributes: [
          { name: 'Payment_Provider_Name', value: 'easebuzz' },
          { name: 'Payment_Method', value: 'UPI' },
          { name: 'Payment_Sub_Method', value: '@ptaxis' },
          { name: 'Refund RRN', value: '104611223344' },
          { name: 'Refund ARN', value: 'R9ABC12345' },
        ],
      },
      refunds: [{ id: 1118855626951, created_at: new Date().toISOString(), transactions: [] }],
      transactions: [],
    });

    const notifySpy = vi.spyOn(notificationEngine, 'notifyRefundRrnUpdated').mockResolvedValueOnce(true);

    const res = await syncOrderRefundDetails(2019, { sendEmailOnNewRrn: true });

    expect(res.updated).toBe(true);
    expect(res.newReferenceFound).toBe(true);
    expect(res.emailSent).toBe(true);
    expect(prismaStub.order.update).toHaveBeenCalledWith({
      where: { id: 2019 },
      data: expect.objectContaining({
        paymentInstrument: 'UPI (@ptaxis)',
        refundRrn: '104611223344',
        refundArn: 'R9ABC12345',
        refundSource: 'UPI (@ptaxis) · Easebuzz',
        refundGatewayStatus: 'CREDITED',
      }),
    });
    expect(prismaStub.return.update).toHaveBeenCalledWith({
      where: { id: 24 },
      data: expect.objectContaining({
        refundRrn: '104611223344',
        refundArn: 'R9ABC12345',
        refundSource: 'UPI (@ptaxis) · Easebuzz',
        refundGatewayStatus: 'CREDITED',
      }),
    });
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });
});
