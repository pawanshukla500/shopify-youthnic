import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { getTrackingUrl } from '../../utils/courier';

export interface CreateEmailLogInput {
  orderId?: number | null;
  shopifyOrderName?: string | null;
  recipientEmail: string;
  recipientName?: string | null;
  subject: string;
  templateType: string;
  status?: string;
  resendId?: string | null;
  waybillNumber?: string | null;
  courier?: string | null;
  currentLocation?: string | null;
  delayReason?: string | null;
  expectedDeliveryDate?: string | null;
  htmlPreview?: string | null;
  errorMessage?: string | null;
  metadata?: any;
}

export interface GetEmailLogsParams {
  page?: number;
  limit?: number;
  orderId?: number;
  templateType?: string;
  status?: string;
  converted?: boolean;
  search?: string;
}

class EmailLogService {
  /**
   * Record a dispatched or simulated email communication
   */
  async createLog(input: CreateEmailLogInput) {
    try {
      const log = await prisma.emailLog.create({
        data: {
          orderId: input.orderId || null,
          shopifyOrderName: input.shopifyOrderName || null,
          recipientEmail: input.recipientEmail,
          recipientName: input.recipientName || null,
          subject: input.subject,
          templateType: input.templateType,
          status: input.status || 'PENDING',
          resendId: input.resendId || null,
          waybillNumber: input.waybillNumber || null,
          courier: input.courier || 'Delhivery Express',
          currentLocation: input.currentLocation || null,
          delayReason: input.delayReason || null,
          expectedDeliveryDate: input.expectedDeliveryDate || null,
          htmlPreview: input.htmlPreview || null,
          errorMessage: input.errorMessage || null,
          metadata: input.metadata || undefined,
          sentAt: input.status === 'SENT' || input.status === 'SIMULATED' ? new Date() : null,
        },
      });
      return log;
    } catch (error) {
      logger.error('Failed to create EmailLog:', error);
      throw error;
    }
  }

  /**
   * Update log delivery status and Resend ID
   */
  async updateStatus(
    id: number,
    data: {
      status: string;
      resendId?: string | null;
      errorMessage?: string | null;
      sentAt?: Date;
    }
  ) {
    return prisma.emailLog.update({
      where: { id },
      data: {
        status: data.status,
        ...(data.resendId !== undefined && { resendId: data.resendId }),
        ...(data.errorMessage !== undefined && { errorMessage: data.errorMessage }),
        ...(data.sentAt !== undefined && { sentAt: data.sentAt }),
      },
    });
  }

  /**
   * Finds a successful/simulated notification for an order and template.
   * A cutoff can be used for repeatable notices such as transit delays.
   */
  async findDeliveredNotification(
    orderId: number,
    templateType: string,
    createdAfter?: Date
  ) {
    return prisma.emailLog.findFirst({
      where: {
        orderId,
        templateType,
        status: { in: ['PENDING', 'SENT', 'DELIVERED', 'SIMULATED'] },
        ...(createdAfter ? { createdAt: { gte: createdAfter } } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Record customer conversion / response
   */
  async recordConversion(
    id: number,
    data?: { action?: string; metadata?: any }
  ) {
    return prisma.emailLog.update({
      where: { id },
      data: {
        converted: true,
        conversionAction: data?.action || 'CUSTOMER_ENGAGED',
        conversionAt: new Date(),
        lastEngagedAt: new Date(),
        clickCount: { increment: 1 },
        ...(data?.metadata && { metadata: data.metadata }),
      },
    });
  }

  /**
   * Track customer tracking link click and redirect
   */
  async trackClick(id: number) {
    try {
      const log = await prisma.emailLog.findUnique({
        where: { id },
        include: { order: { include: { shipment: true } } },
      });

      if (log) {
        await prisma.emailLog.update({
          where: { id },
          data: {
            converted: true,
            conversionAction: 'TRACKING_LINK_CLICKED',
            conversionAt: log.conversionAt || new Date(),
            lastEngagedAt: new Date(),
            clickCount: { increment: 1 },
          },
        });
      }

      const waybill = log?.waybillNumber || log?.order?.shipment?.waybillNumber;
      if (waybill) {
        const courier = log?.courier || log?.order?.shipment?.courier || (log?.order as any)?.courierPartner;
        const labelUrl = log?.order?.shipment?.labelUrl;
        return getTrackingUrl(courier, waybill, labelUrl) || `https://www.delhivery.com/track/package/${waybill}`;
      }
      return 'https://youthnic2024.myshopify.com';
    } catch (error) {
      logger.error(`Failed to track click for email log #${id}:`, error);
      return 'https://youthnic2024.myshopify.com';
    }
  }

  /**
   * Retrieve email logs with filtering and pagination
   */
  async getLogs(params: GetEmailLogsParams = {}) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 20));
    const skip = (page - 1) * limit;

    const where: any = {};

    if (params.orderId) {
      where.orderId = Number(params.orderId);
    }
    if (params.templateType) {
      where.templateType = params.templateType;
    }
    if (params.status) {
      where.status = params.status;
    }
    if (typeof params.converted === 'boolean') {
      where.converted = params.converted;
    }
    if (params.search && params.search.trim()) {
      const q = params.search.trim();
      where.OR = [
        { recipientEmail: { contains: q, mode: 'insensitive' } },
        { recipientName: { contains: q, mode: 'insensitive' } },
        { shopifyOrderName: { contains: q, mode: 'insensitive' } },
        { waybillNumber: { contains: q, mode: 'insensitive' } },
        { subject: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [total, logs] = await Promise.all([
      prisma.emailLog.count({ where }),
      prisma.emailLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          order: {
            select: {
              id: true,
              shopifyOrderName: true,
              status: true,
              totalAmount: true,
              paymentMethod: true,
            },
          },
        },
      }),
    ]);

    return {
      logs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get single log details
   */
  async getLogById(id: number) {
    return prisma.emailLog.findUnique({
      where: { id },
      include: {
        order: {
          include: {
            items: true,
            shipment: true,
          },
        },
      },
    });
  }

  /**
   * Aggregate statistics for communications dashboard
   */
  async getStats() {
    const [totalLogs, sentLogs, convertedLogs, transitDelays, dispatchDelays, typeGroups] =
      await Promise.all([
        prisma.emailLog.count(),
        prisma.emailLog.count({
          where: { status: { in: ['SENT', 'DELIVERED', 'SIMULATED'] } },
        }),
        prisma.emailLog.count({
          where: { converted: true },
        }),
        prisma.emailLog.count({
          where: { templateType: 'TRANSIT_DELAY' },
        }),
        prisma.emailLog.count({
          where: { templateType: 'DISPATCH_DELAY' },
        }),
        prisma.emailLog.groupBy({
          by: ['templateType'],
          _count: { id: true },
        }),
      ]);

    const conversionRatePercent =
      totalLogs > 0 ? Math.round((convertedLogs / totalLogs) * 1000) / 10 : 0;
    const deliveryRatePercent =
      totalLogs > 0 ? Math.round((sentLogs / totalLogs) * 1000) / 10 : 100;

    const byTemplate: Record<string, number> = {};
    for (const group of typeGroups) {
      byTemplate[group.templateType] = group._count.id;
    }

    return {
      totalSent: totalLogs,
      deliveredCount: sentLogs,
      convertedCount: convertedLogs,
      conversionRatePercent,
      deliveryRatePercent,
      transitDelaysCount: transitDelays,
      dispatchDelaysCount: dispatchDelays,
      byTemplate,
    };
  }
}

export const emailLogService = new EmailLogService();
export default emailLogService;
