import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaMock, predictRtoRiskMock } = vi.hoisted(() => ({
  prismaMock: {
    order: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  predictRtoRiskMock: vi.fn(),
}));

// ─── Mock Logger ───
vi.mock('../src/utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../src/database/prisma', () => ({ default: prismaMock }));

vi.mock('../src/modules/payments/gokwik.service', () => ({
  default: {
    predictRtoRisk: predictRtoRiskMock,
  },
  gokwikService: {
    predictRtoRisk: predictRtoRiskMock,
  },
}));

import orderService from '../src/modules/orders/order.service';

describe('OrderService - evaluateOrderRtoRisk (GoKwik RTO Predict Integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('evaluates COD order via GoKwik Predict API and persists risk level & reason to DB', async () => {
    const mockOrder: any = {
      id: 101,
      shopifyOrderId: 'gid://shopify/Order/555101',
      shopifyOrderName: '#26YOU5901',
      customerName: 'Pawan Shukla',
      customerPhone: '9426279142',
      customerEmail: 'pawan@example.com',
      customerAddress: '101 Lotus Residency, Vesu',
      customerCity: 'Surat',
      customerState: 'Gujarat',
      customerPincode: '395007',
      totalAmount: 1499,
      paymentMethod: 'COD',
      shopifyCreatedAt: new Date('2026-11-16T10:00:00Z'),
      tags: '',
      deliverOrderCount: 1,
      items: [
        {
          id: 1,
          title: 'Embroidered Kurta - Teal',
          quantity: 1,
          price: 1499,
          sku: 'YTH-EMB-01',
        },
      ],
      shipment: null,
    };

    prismaMock.order.findUnique.mockResolvedValueOnce(mockOrder);
    prismaMock.order.update.mockResolvedValueOnce({
      ...mockOrder,
      rtoRiskLevel: 'LOW',
      rtoRiskReason: 'Customer has 92% delivery rate on GoKwik network',
    });

    predictRtoRiskMock.mockResolvedValueOnce({
      success: true,
      riskFlag: 'LOW',
      riskScore: 8,
      riskReason: 'Customer has 92% delivery rate on GoKwik network',
      allowCod: true,
      incentivizePrepaid: false,
      requestId: 'req_101',
    });

    const res = await orderService.evaluateOrderRtoRisk(101);

    expect(res.orderId).toBe(101);
    expect(res.rtoRiskLevel).toBe('LOW');
    expect(res.rtoRiskReason).toBe('Customer has 92% delivery rate on GoKwik network');
    expect(res.source).toBe('GOKWIK_PREDICT_API');
    expect(res.allowCod).toBe(true);
    expect(res.riskScore).toBe(8);

    expect(predictRtoRiskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantOrderId: '#26YOU5901',
        totalPrice: 1499,
        paymentMethod: 'COD',
        customer: expect.objectContaining({
          firstName: 'Pawan',
          lastName: 'Shukla',
          phone: '9426279142',
        }),
        shippingAddress: expect.objectContaining({
          city: 'Surat',
          postcode: '395007',
        }),
        lineItems: [
          expect.objectContaining({
            name: 'Embroidered Kurta - Teal',
            quantity: 1,
            price: 1499,
          }),
        ],
      })
    );

    expect(prismaMock.order.update).toHaveBeenCalledWith({
      where: { id: 101 },
      data: {
        rtoRiskLevel: 'LOW',
        rtoRiskReason: 'Customer has 92% delivery rate on GoKwik network',
      },
    });
  });

  it('correctly maps HIGH risk from GoKwik and flags restriction', async () => {
    const mockOrder: any = {
      id: 102,
      shopifyOrderId: 'gid://shopify/Order/555102',
      shopifyOrderName: '#26YOU5902',
      customerName: 'High Risk Buyer',
      customerPhone: '9999999999',
      customerAddress: 'Unknown Lane',
      customerCity: 'Nowhere',
      customerState: 'State',
      customerPincode: '000000',
      totalAmount: 2999,
      paymentMethod: 'COD',
      tags: '',
      items: [],
      shipment: null,
    };

    prismaMock.order.findUnique.mockResolvedValueOnce(mockOrder);
    prismaMock.order.update.mockResolvedValueOnce({
      ...mockOrder,
      rtoRiskLevel: 'HIGH',
    });

    predictRtoRiskMock.mockResolvedValueOnce({
      success: true,
      riskFlag: 'HIGH',
      riskScore: 94,
      riskReason: 'High return / fake address history detected',
      allowCod: false,
      incentivizePrepaid: true,
    });

    const res = await orderService.evaluateOrderRtoRisk(102);

    expect(res.rtoRiskLevel).toBe('HIGH');
    expect(res.allowCod).toBe(false);
    expect(res.source).toBe('GOKWIK_PREDICT_API');
    expect(res.riskScore).toBe(94);
    expect(prismaMock.order.update).toHaveBeenCalledWith({
      where: { id: 102 },
      data: {
        rtoRiskLevel: 'HIGH',
        rtoRiskReason: 'High return / fake address history detected',
      },
    });
  });

  it('handles prepaid orders immediately as zero RTO risk without network call', async () => {
    const mockOrder: any = {
      id: 103,
      shopifyOrderName: '#26YOU5903',
      paymentMethod: 'Prepaid',
      totalAmount: 1999,
      rtoRiskLevel: 'LOW',
      rtoRiskReason: 'Prepaid order (Zero RTO risk: payment captured upfront)',
      deliverOrderCount: null,
      items: [],
    };

    prismaMock.order.findUnique.mockResolvedValueOnce(mockOrder);

    const res = await orderService.evaluateOrderRtoRisk(103);

    expect(res.rtoRiskLevel).toBe('LOW');
    expect(res.source).toBe('HEURISTIC_FALLBACK');
    expect(res.allowCod).toBe(false);
    expect(predictRtoRiskMock).not.toHaveBeenCalled();
  });

  it('falls back safely to heuristic rules when GoKwik Predict API fails', async () => {
    const mockOrder: any = {
      id: 104,
      shopifyOrderName: '#26YOU5904',
      customerName: 'Repeat Customer',
      paymentMethod: 'COD',
      totalAmount: 999,
      tags: 'COD_CONFIRMED',
      deliverOrderCount: 3,
      items: [],
      shipment: null,
    };

    prismaMock.order.findUnique.mockResolvedValueOnce(mockOrder);
    prismaMock.order.update.mockResolvedValueOnce(mockOrder);

    // API error simulation
    predictRtoRiskMock.mockResolvedValueOnce({
      success: false,
      riskFlag: 'UNKNOWN',
      error: 'GoKwik gateway timeout',
    });

    const res = await orderService.evaluateOrderRtoRisk(104);

    expect(res.source).toBe('HEURISTIC_FALLBACK');
    expect(res.rtoRiskLevel).toBe('LOW'); // Because tags contain COD_CONFIRMED
    expect(res.rtoRiskReason).toContain('WhatsApp / GoKwik confirmation');
    expect(res.allowCod).toBe(true);

    expect(prismaMock.order.update).toHaveBeenCalledWith({
      where: { id: 104 },
      data: {
        rtoRiskLevel: 'LOW',
        rtoRiskReason: 'Customer verified intent via WhatsApp / GoKwik confirmation',
      },
    });
  });

  it('throws descriptive error if order is not found', async () => {
    prismaMock.order.findUnique.mockResolvedValueOnce(null);

    await expect(orderService.evaluateOrderRtoRisk(9999)).rejects.toThrow('Order 9999 not found');
  });
});
