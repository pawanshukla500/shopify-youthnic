import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyticsService } from '../src/modules/analytics/analytics.service';
import prisma from '../src/database/prisma';
import { resendService } from '../src/modules/email/resend.service';

vi.mock('../src/database/prisma', () => ({
  default: {
    order: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    return: {
      findMany: vi.fn(),
    },
    emailLog: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../src/modules/email/resend.service', () => ({
  resendService: {
    sendEmail: vi.fn(),
  },
}));

describe('AnalyticsService (Executive Reporter, Account Strategist, Report Distribution)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('computes comprehensive analytics with executive insights and RFM customer accounts', async () => {
    const mockOrders = [
      {
        id: 1,
        shopifyOrderName: '#26YOU101',
        customerName: 'Aarav Patel',
        customerPhone: '919876543210',
        customerEmail: 'aarav@example.com',
        customerCity: 'Ahmedabad',
        customerState: 'Gujarat',
        totalAmount: 1200,
        paymentMethod: 'Pre-paid',
        status: 'DELIVERED',
        gatewayFee: 30,
        createdAt: new Date('2026-10-01'),
        shopifyCreatedAt: new Date('2026-10-01'),
        items: [{ quantity: 1 }],
        shipment: { courier: 'Delhivery', initialCost: 110, netBilledCost: 110 },
      },
      {
        id: 2,
        shopifyOrderName: '#26YOU102',
        customerName: 'Aarav Patel',
        customerPhone: '919876543210',
        customerEmail: 'aarav@example.com',
        customerCity: 'Ahmedabad',
        customerState: 'Gujarat',
        totalAmount: 2000,
        paymentMethod: 'Pre-paid',
        status: 'DELIVERED',
        gatewayFee: 50,
        createdAt: new Date('2026-10-15'),
        shopifyCreatedAt: new Date('2026-10-15'),
        items: [{ quantity: 2 }],
        shipment: { courier: 'Delhivery', initialCost: 120, netBilledCost: 120 },
      },
      {
        id: 3,
        shopifyOrderName: '#26YOU103',
        customerName: 'Priya Sharma',
        customerPhone: '919876543211',
        customerEmail: 'priya@example.com',
        customerCity: 'Mumbai',
        customerState: 'Maharashtra',
        totalAmount: 850,
        paymentMethod: 'COD',
        status: 'RTO_DELIVERED',
        gatewayFee: null,
        createdAt: new Date('2026-10-20'),
        shopifyCreatedAt: new Date('2026-10-20'),
        items: [{ quantity: 1 }],
        shipment: { courier: 'Velocity', initialCost: 100, reversalAmount: 95 },
      },
    ];

    (prisma.order.findMany as any).mockResolvedValueOnce(mockOrders);
    (prisma.return.findMany as any).mockResolvedValueOnce([{ refundAmount: 0 }]);
    (prisma.emailLog.findFirst as any).mockResolvedValueOnce(null);
    (prisma.emailLog.count as any).mockResolvedValueOnce(0);

    const report = await analyticsService.computeComprehensiveAnalyticsReport();

    expect(report.success).toBe(true);
    expect(report.kpis.totalOrders).toBe(3);
    expect(report.kpis.totalGrossRevenue).toBe(4050);
    expect(report.kpis.totalPrepaidOrders).toBe(2);
    expect(report.kpis.totalCodOrders).toBe(1);

    // Executive Insights (/agency-analytics-reporter)
    expect(report.executiveInsights).toBeDefined();
    expect(report.executiveInsights.realizedNetMargin).toBeGreaterThan(0);
    expect(report.executiveInsights.deliverySuccessRate).toBeGreaterThan(0);
    expect(report.executiveInsights.strategicRecommendations).toHaveLength(3);

    // Account Strategist (/agency-account-strategist)
    expect(report.accountStrategist.totalCustomerAccounts).toBe(2);
    expect(report.accountStrategist.repeatCustomerAccounts).toBe(1); // Aarav has 2 orders
    expect(report.accountStrategist.repeatCustomerRate).toBe(50);
    expect(report.accountStrategist.topAccounts).toHaveLength(2);

    // Aarav should be a Champion (2 delivered prepaid orders, >3000 spend)
    const aarav = report.accountStrategist.topAccounts.find((a) => a.phone === '919876543210');
    expect(aarav).toBeDefined();
    expect(aarav?.segment).toBe('CHAMPION');
    expect(aarav?.healthScore).toBe('GREEN');

    // Priya should be flagged as AT_RISK due to RTO
    const priya = report.accountStrategist.topAccounts.find((a) => a.phone === '919876543211');
    expect(priya).toBeDefined();
    expect(priya?.segment).toBe('AT_RISK');
    expect(priya?.healthScore).toBe('RED');

    // Report Distribution Status (/agency-report-distribution-agent)
    expect(report.distributionSchedule).toBeDefined();
    expect(report.distributionSchedule.dailyReport.status).toBe('ACTIVE');
    expect(report.distributionSchedule.weeklyReport.status).toBe('ACTIVE');
  });

  it('distributes analytics report and creates an audit log entry', async () => {
    (prisma.order.findMany as any).mockResolvedValueOnce([]);
    (prisma.return.findMany as any).mockResolvedValueOnce([]);
    (prisma.emailLog.findFirst as any).mockResolvedValueOnce(null);
    (prisma.emailLog.count as any).mockResolvedValueOnce(1);

    (resendService.sendEmail as any).mockResolvedValueOnce({
      success: true,
      mode: 'SENT',
      logId: 999,
      recipient: 'accounts@youthnic.com',
      subject: 'Youthnic Executive Analytics Digest',
    });
    (prisma.emailLog.update as any).mockResolvedValueOnce({ id: 999 });

    const result = await analyticsService.distributeAnalyticsReport({
      recipientEmail: 'accounts@youthnic.com',
      recipientName: 'Finance Desk',
      reportType: 'EXECUTIVE_PL_DIGEST',
      notes: 'Weekly financial distribution for board review',
    });

    expect(result.success).toBe(true);
    expect(result.logId).toBe(999);
    expect(result.status).toBe('SENT');
    expect(resendService.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'accounts@youthnic.com',
        templateType: 'CUSTOM',
      })
    );
    expect(prisma.emailLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 999 },
        data: expect.objectContaining({
          templateType: 'ANALYTICS_REPORT_DISTRIBUTION',
        }),
      })
    );
  });

  it('validates recipient email before distribution', async () => {
    await expect(
      analyticsService.distributeAnalyticsReport({
        recipientEmail: 'invalid-email',
        reportType: 'EXECUTIVE_PL_DIGEST',
      })
    ).rejects.toThrow('A valid recipient email address is required');
  });
});
