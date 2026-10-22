import { describe, it, expect } from 'vitest';
import { getTrackingUrl, isVelocityCourier, normalizeCourierName } from '../src/utils/courier';
import invoiceService from '../src/modules/invoice/invoice.service';
import shippingLabelService from '../src/modules/delhivery/shipping-label.service';
import kwikengageService from '../src/modules/whatsapp/kwikengage.service';
import { renderTransitDelayEmail, renderInTransitEmail, renderNdrEmail } from '../src/modules/email/email-templates';
import emailLogService from '../src/modules/email/email-log.service';
import { carrierTrackingUrl } from '../frontend/src/lib';

describe('Velocity Tracking URL & Customer Notification Synchronization', () => {
  const velocityAwb = 'VEHR9876543210';
  const amazonVelocityAwb = 'PD1234567890';
  const delhiveryAwb = '30100810012345';

  it('correctly identifies Velocity shipments and resolves standard tracking URL', () => {
    expect(isVelocityCourier('Velocity', null, velocityAwb)).toBe(true);
    expect(isVelocityCourier('Amazon Transportation', null, amazonVelocityAwb)).toBe(true);
    expect(isVelocityCourier('Shipfastt', null, 'VEL12345')).toBe(true);

    expect(getTrackingUrl('Velocity', velocityAwb)).toBe(`https://www.velocityshipping.in/track/${velocityAwb}`);
    expect(getTrackingUrl('Amazon Transportation', amazonVelocityAwb)).toBe(`https://www.velocityshipping.in/track/${amazonVelocityAwb}`);
    expect(getTrackingUrl('Delhivery Express', delhiveryAwb)).toBe(`https://www.delhivery.com/track/package/${delhiveryAwb}`);
  });

  it('generates WhatsApp message with exact Velocity tracking URL', () => {
    const dummyOrder: any = {
      id: 501,
      customerName: 'Priya Verma',
      shopifyOrderName: '#26YOU6001',
      totalAmount: 1299,
      customerPhone: '9876500000',
      paymentMethod: 'COD',
      customerAddress: 'B-402, Royal Residency',
      customerCity: 'Mumbai',
      customerState: 'Maharashtra',
      customerPincode: '400001',
    };

    // ORDER_SHIPPED WhatsApp message
    const shippedMsg = kwikengageService.buildTriggerMessage('ORDER_SHIPPED', dummyOrder, {
      waybillNumber: velocityAwb,
      courierName: 'Velocity',
    });
    expect(shippedMsg).toContain(`https://www.velocityshipping.in/track/${velocityAwb}`);
    expect(shippedMsg).toContain('Velocity');
    expect(shippedMsg).toContain('#26YOU6001');

    // NDR_ALERT WhatsApp message
    const ndrMsg = kwikengageService.buildTriggerMessage('NDR_ALERT', dummyOrder, {
      waybillNumber: velocityAwb,
      courierName: 'Velocity',
      ndrReason: 'Customer premises closed',
    });
    expect(ndrMsg).toContain(`https://www.velocityshipping.in/track/${velocityAwb}`);
    expect(ndrMsg).toContain('Velocity attempted to deliver');
    expect(ndrMsg).not.toContain('delhivery.com');
  });

  it('renders Email templates with Velocity tracking URL and carrier branding', () => {
    const emailData: any = {
      orderName: '#26YOU6001',
      customerName: 'Priya Verma',
      waybillNumber: velocityAwb,
      courier: 'Velocity',
      currentLocation: 'Velocity Hub Mumbai',
    };

    const inTransit = renderInTransitEmail(emailData);
    expect(inTransit.html).toContain(`https://www.velocityshipping.in/track/${velocityAwb}`);
    expect(inTransit.html).toContain('Velocity');

    const transitDelay = renderTransitDelayEmail(emailData);
    expect(transitDelay.html).toContain(`https://www.velocityshipping.in/track/${velocityAwb}`);
    expect(transitDelay.html).toContain('Track on Velocity →');
    expect(transitDelay.html).toContain('Live tracking powered by Velocity Shipping Network');

    const ndr = renderNdrEmail(emailData);
    expect(ndr.html).toContain(`https://www.velocityshipping.in/track/${velocityAwb}`);
    expect(ndr.html).toContain('Velocity attempted to deliver your order');
  });

  it('frontend carrierTrackingUrl produces Velocity tracking links', () => {
    expect(carrierTrackingUrl('Velocity', velocityAwb)).toBe(`https://www.velocityshipping.in/track/${velocityAwb}`);
    expect(carrierTrackingUrl('Amazon Transportation', amazonVelocityAwb)).toBe(`https://www.velocityshipping.in/track/${amazonVelocityAwb}`);
    expect(carrierTrackingUrl('Delhivery Express', delhiveryAwb)).toBe(`https://www.delhivery.com/track/package/${delhiveryAwb}`);
  });
});

describe('4x6" Thermal GST Tax Invoice Layout & Print Standard', () => {
  const dummyOrder: any = {
    id: 601,
    shopifyOrderNumber: '6001',
    shopifyOrderName: '#26YOU6001',
    customerName: 'Ananya Deshmukh',
    customerPhone: '9822012345',
    customerAddress: 'Flat 501, Greenfield Heights',
    customerCity: 'Pune',
    customerState: 'Maharashtra',
    customerPincode: '411001',
    totalAmount: 1899,
    paymentMethod: 'COD',
    shopifyCreatedAt: new Date('2026-10-15T10:00:00Z'),
    items: [
      {
        id: 1,
        title: 'Georgette Foil Print Kurti Set with Dupatta',
        sku: 'KURTI-FOIL-L',
        variantTitle: 'Large',
        quantity: 1,
        price: 1899,
      },
    ],
    shipment: {
      id: 701,
      waybillNumber: 'VEHR1122334455',
      courier: 'Velocity',
      paymentMode: 'COD',
      codAmount: 1899,
      status: 'SHIPPED',
    },
  };

  it('renders single 4x6" thermal invoice HTML with required GST fields and Velocity AWB', () => {
    const html = invoiceService.generateInvoiceHtml(dummyOrder);

    // Thermal wrapper & container
    expect(html).toContain('invoice-wrapper');
    expect(html).toContain('invoice-container');

    // Branding & GST
    expect(html).toContain('YOUTHNIC');
    expect(html).toContain('VB EXPORTS');
    expect(html).toContain('24AAFFV1234P1Z8');
    expect(html).toContain('TAX INVOICE');
    expect(html).toContain('INV-2026-6001');
    expect(html).toContain('#26YOU6001');

    // Carrier identification
    expect(html).toContain('Velocity AWB:');
    expect(html).toContain('VEHR1122334455');

    // Customer & destination
    expect(html).toContain('Ananya Deshmukh');
    expect(html).toContain('9822012345');
    expect(html).toContain('Greenfield Heights');
    expect(html).toContain('Pune, Maharashtra - 411001');
    expect(html).toContain('Place of Supply: <strong>Maharashtra (27)</strong>');
    expect(html).toContain('CASH ON DELIVERY: COLLECT ₹1899.00');

    // Item row
    expect(html).toContain('KURTI-FOIL-L');
    expect(html).toContain('6204'); // HSN code
    expect(html).toContain('₹1899.00');

    // Tax calculation: Maharashtra buyer = IGST (5%)
    expect(html).toContain('IGST (5%):');
    expect(html).toContain('INVOICE TOTAL:');
    expect(html).toContain('In Words:');
    expect(html).toContain('One Thousand Eight Hundred Ninety Nine Rupees Only');

    // Footer & Signatory
    expect(html).toContain('Youthnic 7-day hassle-free return');
    expect(html).toContain('AUTHORISED SIGNATORY');
  });

  it('enforces 100mm x 150mm thermal print CSS rules', () => {
    const styles = invoiceService.getInvoiceStyles();
    expect(styles).toContain('size: 100mm 150mm');
    expect(styles).toContain('width: 100mm');
    expect(styles).toContain('height: 150mm');
    expect(styles).toContain('max-height: 150mm');
    expect(styles).toContain('page-break-after: always');
    expect(styles).toContain('overflow: hidden');
  });

  it('enforces matching 100mm x 150mm dimensions in combined Label + Invoice styles', () => {
    const combinedStyles = shippingLabelService.getCombinedStyles();
    expect(combinedStyles).toContain('size: 100mm 150mm');
    expect(combinedStyles).toContain('.invoice-wrapper');
    expect(combinedStyles).toContain('.label-wrapper');
    expect(combinedStyles).toContain('width: 100mm !important');
    expect(combinedStyles).toContain('height: 150mm !important');
  });
});
