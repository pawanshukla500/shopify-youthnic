import { describe, it, expect } from 'vitest';
import { isVelocityCourier, isDelhiveryCourier, normalizeCourierName } from '../src/utils/courier';
import shippingLabelService from '../src/modules/delhivery/shipping-label.service';
import { mergePdfBuffers } from '../src/utils/pdf-merger';
import { PDFDocument } from 'pdf-lib';

describe('Velocity & Amazon Shipping Bulk Label Verification', () => {
  const dummyAmazonVelocityOrder: any = {
    id: 6001,
    shopifyOrderId: 'gid://shopify/Order/6001',
    shopifyOrderName: '#26YOU6001',
    customerName: 'Rajni Bala',
    customerEmail: 'rajni@example.com',
    customerPhone: '+919871324353',
    customerAddress: 'Quarter number 67, double storey flats, Kabul Nagar, Shahdara',
    customerCity: 'Shahdara',
    customerState: 'Delhi',
    customerPincode: '110032',
    paymentMethod: 'COD',
    totalAmount: 814.0,
    shopifyCreatedAt: new Date('2026-10-21T10:00:00Z'),
    items: [
      {
        id: 1,
        title: 'Rust Cotton Blend Ajrak Block Print Straight Kurta',
        variantTitle: 'XL',
        sku: 'BT216-Geomi-Rust_XL',
        quantity: 1,
        price: 799.0,
      },
    ],
    shipment: {
      id: 101,
      courier: 'Amazon Transportation',
      waybillNumber: '374645218626',
      labelUrl:
        'https://velocity-shazam-prod.s3.ap-south-1.amazonaws.com/labels/amazon/2026-10-21/374645218626.pdf',
      paymentMode: 'COD',
      status: 'CREATED',
    },
  };

  const dummyDelhiveryOrder: any = {
    id: 5001,
    shopifyOrderId: 'gid://shopify/Order/5001',
    shopifyOrderName: '#26YOU5001',
    customerName: 'Ananya Sharma',
    customerEmail: 'ananya@example.com',
    customerPhone: '+919876543210',
    customerAddress: '123 Park Street',
    customerCity: 'Kolkata',
    customerState: 'West Bengal',
    customerPincode: '700016',
    paymentMethod: 'PREPAID',
    totalAmount: 1499.0,
    shopifyCreatedAt: new Date('2026-10-21T10:00:00Z'),
    items: [
      {
        id: 2,
        title: 'Blue Floral Anarkali Kurta',
        variantTitle: 'M',
        sku: 'BT100-Blue_M',
        quantity: 1,
        price: 1499.0,
      },
    ],
    shipment: {
      id: 102,
      courier: 'Delhivery Surface',
      waybillNumber: '123456789012',
      labelUrl: null,
      paymentMode: 'Prepaid',
      status: 'CREATED',
    },
  };

  describe('Courier Classification', () => {
    it('identifies Amazon Transportation as Velocity/Amazon courier and never Delhivery', () => {
      expect(isVelocityCourier('Amazon Transportation')).toBe(true);
      expect(isVelocityCourier('Amazon Shipping')).toBe(true);
      expect(isVelocityCourier('Amazon ATS')).toBe(true);
      expect(isVelocityCourier(undefined, 'https://velocity-shazam-prod.s3.ap-south-1.amazonaws.com/labels/amazon/374645218626.pdf')).toBe(true);
      expect(isVelocityCourier('Amazon Transportation', null, '374645218626')).toBe(true);

      expect(isDelhiveryCourier('Amazon Transportation')).toBe(false);
      expect(isDelhiveryCourier('Amazon Shipping')).toBe(false);
    });

    it('normalizes courier name to Amazon Transportation for Amazon variants', () => {
      expect(normalizeCourierName('Amazon Transportation')).toBe('Amazon Transportation');
      expect(normalizeCourierName('Amazon Shipping')).toBe('Amazon Transportation');
    });

    it('correctly keeps Delhivery as Delhivery', () => {
      expect(isDelhiveryCourier('Delhivery Surface')).toBe(true);
      expect(isVelocityCourier('Delhivery Surface')).toBe(false);
    });
  });

  describe('HTML Label Rendering for Velocity / Amazon Orders', () => {
    it('never renders Delhivery logo on Velocity / Amazon labels', () => {
      const html = shippingLabelService.generateSingleLabelHtml(
        dummyAmazonVelocityOrder,
        dummyAmazonVelocityOrder.shipment.waybillNumber
      );

      // Must NOT contain Delhivery logo or alt text
      expect(html).not.toContain('alt="Delhivery"');
      expect(html).not.toContain('delhivery-logo-img');

      // Must NOT contain Delhivery sort codes
      expect(html).not.toContain('DEL / OBN');

      // Must contain Amazon carrier branding
      expect(html).toContain('amazon');
      expect(html).toContain('transportation services');
      expect(html).toContain('carrier-amazon');

      // Must contain correct AWB and Order Name
      expect(html).toContain('374645218626');
      expect(html).toContain('26YOU6001');
      expect(html).toContain('Rajni Bala');
      expect(html).toContain('AMZN / 110032');
    });

    it('renders Delhivery logo on Delhivery labels', () => {
      const html = shippingLabelService.generateSingleLabelHtml(
        dummyDelhiveryOrder,
        dummyDelhiveryOrder.shipment.waybillNumber
      );

      expect(html).toContain('alt="Delhivery"');
      expect(html).toContain('delhivery-logo-img');
      expect(html).toContain('CCU / SAL');
    });
  });

  describe('Bulk Printable Labels Page', () => {
    it('renders generic Youthnic bulk header without hardcoded Delhivery', () => {
      const html = shippingLabelService.generateBulkPrintableLabelsPage([
        { order: dummyAmazonVelocityOrder, waybillNumber: dummyAmazonVelocityOrder.shipment.waybillNumber },
        { order: dummyDelhiveryOrder, waybillNumber: dummyDelhiveryOrder.shipment.waybillNumber },
      ]);

      expect(html).toContain('<title>Bulk Shipping Labels (2 Orders)</title>');
      expect(html).toContain('Youthnic · Bulk 4R Shipping Labels');
      expect(html).not.toContain('Youthnic · Bulk Delhivery 4R Shipping Labels');
    });

    it('embeds PDF canvas container when pdfBuffer is provided', () => {
      const fakePdfBuffer = Buffer.from('%PDF-1.4 test buffer long enough to pass length check 1234567890');
      const html = shippingLabelService.generateBulkPrintableLabelsPage([
        {
          order: dummyAmazonVelocityOrder,
          waybillNumber: dummyAmazonVelocityOrder.shipment.waybillNumber,
          pdfBuffer: fakePdfBuffer,
        },
      ]);

      expect(html).toContain('data-pdf-base64');
      expect(html).toContain('pdf-canvas-container');
      expect(html).toContain('official-label-canvas');
      expect(html).toContain('pdf.js');
    });
  });

  describe('PDF Merging Service', () => {
    it('merges multiple PDF buffers into a single valid multi-page PDF document', async () => {
      const doc1 = await PDFDocument.create();
      doc1.addPage([288, 432]); // 4x6"
      const bytes1 = await doc1.save();

      const doc2 = await PDFDocument.create();
      doc2.addPage([288, 432]);
      const bytes2 = await doc2.save();

      const mergedBuffer = await mergePdfBuffers([Buffer.from(bytes1), Buffer.from(bytes2)]);
      expect(mergedBuffer).toBeInstanceOf(Buffer);
      expect(mergedBuffer.length).toBeGreaterThan(100);

      const parsed = await PDFDocument.load(mergedBuffer);
      expect(parsed.getPageCount()).toBe(2);
    });
  });
});
