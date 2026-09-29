import { describe, it, expect, vi, beforeEach } from 'vitest';
import shippingLabelService from '../src/modules/delhivery/shipping-label.service';
import invoiceService from '../src/modules/invoice/invoice.service';

describe('Combined Label and Invoice Generator (Alternating Sequence)', () => {
  const dummyOrder1: any = {
    id: 101,
    shopifyOrderName: '#YOUTH-101',
    customerName: 'Aarav Patel',
    customerPhone: '9876543210',
    customerAddress: '101 Ring Road',
    customerCity: 'Ahmedabad',
    customerState: 'Gujarat',
    customerPincode: '380001',
    customerCountry: 'India',
    totalAmount: 1499,
    currency: 'INR',
    paymentMethod: 'Prepaid',
    shopifyCreatedAt: new Date('2026-09-28T10:00:00Z'),
    items: [
      {
        id: 1,
        title: 'Silk Embroidered Kurti',
        sku: 'KURTI-SLK-M',
        quantity: 1,
        price: 1499,
      },
    ],
    shipment: {
      id: 201,
      waybillNumber: '123456789012',
      courier: 'Delhivery',
      paymentMode: 'Pre-paid',
      codAmount: 0,
      status: 'IN_TRANSIT',
    },
  };

  const dummyOrder2: any = {
    id: 102,
    shopifyOrderName: '#YOUTH-102',
    customerName: 'Pooja Sharma',
    customerPhone: '9876543211',
    customerAddress: '202 MG Road',
    customerCity: 'Jaipur',
    customerState: 'Rajasthan',
    customerPincode: '302001',
    customerCountry: 'India',
    totalAmount: 2199,
    currency: 'INR',
    paymentMethod: 'COD',
    shopifyCreatedAt: new Date('2026-09-28T11:00:00Z'),
    items: [
      {
        id: 2,
        title: 'Designer Anarkali Suit',
        sku: 'ANARKALI-RED-L',
        quantity: 1,
        price: 2199,
      },
    ],
    shipment: {
      id: 202,
      waybillNumber: '123456789013',
      courier: 'Delhivery',
      paymentMode: 'COD',
      codAmount: 2199,
      status: 'IN_TRANSIT',
    },
  };

  it('generates single order combined document strictly sequenced as Label then Invoice', () => {
    const html = shippingLabelService.generateLabelAndInvoiceHtml(dummyOrder1, '123456789012');

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('label-page');
    expect(html).toContain('invoice-page');
    expect(html).toContain('page-break-after: always');

    // Label content must appear BEFORE Invoice content in the document flow
    const labelPos = html.indexOf('label-page-wrapper');
    const invoicePos = html.indexOf('invoice-page-wrapper');
    expect(labelPos).toBeGreaterThan(-1);
    expect(invoicePos).toBeGreaterThan(-1);
    expect(labelPos).toBeLessThan(invoicePos);

    // Verify order 1 customer & AWB details
    expect(html).toContain('Aarav Patel');
    expect(html).toContain('123456789012');
    expect(html).toContain('#YOUTH-101');
  });

  it('generates multi-order bulk document strictly alternating: Order 1 Label -> Order 1 Invoice -> Order 2 Label -> Order 2 Invoice', () => {
    const orders = [
      { order: dummyOrder1, waybillNumber: '123456789012' },
      { order: dummyOrder2, waybillNumber: '123456789013' },
    ];

    const html = shippingLabelService.generateBulkLabelsAndInvoicesHtml(orders);

    expect(html).toContain('<!DOCTYPE html>');

    // Check positions in HTML
    const order1LabelPos = html.indexOf('123456789012');
    const order1CustomerPos = html.indexOf('Aarav Patel');
    const order2LabelPos = html.indexOf('123456789013');
    const order2CustomerPos = html.indexOf('Pooja Sharma');

    // Order 1 content must appear before Order 2 content
    expect(order1LabelPos).toBeLessThan(order2LabelPos);
    expect(order1CustomerPos).toBeLessThan(order2CustomerPos);

    // Verify alternating label-page-wrapper and invoice-page-wrapper occurrences
    const labelMatches = [...html.matchAll(/class="label-page-wrapper"/g)].map((m) => m.index!);
    const invoiceMatches = [...html.matchAll(/class="invoice-page-wrapper"/g)].map((m) => m.index!);

    expect(labelMatches.length).toBe(2);
    expect(invoiceMatches.length).toBe(2);

    // Strictly: Label 1 < Invoice 1 < Label 2 < Invoice 2
    expect(labelMatches[0]).toBeLessThan(invoiceMatches[0]);
    expect(invoiceMatches[0]).toBeLessThan(labelMatches[1]);
    expect(labelMatches[1]).toBeLessThan(invoiceMatches[1]);
  });
});
