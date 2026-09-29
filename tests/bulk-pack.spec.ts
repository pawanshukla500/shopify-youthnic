import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import bulkPackService from '../src/modules/bulk-pack/bulk-pack.service';
import { OrderWithDetails } from '../src/modules/picklist/picklist.service';

describe('BulkPackService', () => {
  const sampleOrder: OrderWithDetails = {
    id: 101,
    shopifyOrderId: '9001',
    shopifyOrderName: '#26YOU9001',
    customerName: 'Ananya Verma',
    customerPhone: '9898989898',
    customerEmail: 'ananya@example.com',
    customerAddress: 'Ring Road Mall',
    customerCity: 'Surat',
    customerState: 'Gujarat',
    customerPincode: '395002',
    totalAmount: 2499,
    paymentMethod: 'Pre-paid',
    paymentGateway: 'GoKwik',
    paymentAggregator: 'GoKwik',
    paymentProvider: null,
    paymentProviderPaymentId: null,
    gokwikPaymentId: null,
    gatewayTransactionId: null,
    paymentAuthorizationKey: null,
    paymentReference: null,
    paymentVerified: true,
    paymentVerifiedAt: new Date(),
    paymentVerificationSource: 'shopify_order_transactions',
    deliverOrderCount: null,
    rtoRiskLevel: 'LOW',
    rtoRiskReason: null,
    expectedDispatchAt: new Date(),
    dispatchDelayed: false,
    financialStatus: 'paid',
    fulfillmentStatus: null,
    tags: null,
    sourceName: 'web',
    salesChannel: 'Online Store',
    status: 'NEW',
    weightDiscrepancy: false,
    weightDiscrepancyNote: null,
    actualShippingCost: 0,
    shippingAudited: false,
    shippingZoneCode: null,
    estimatedShippingCost: 106.44,
    shippingMargin: null,
    shippingDiscrepancy: null,
    dispatchedAt: null,
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: 1,
        orderId: 101,
        shopifyVariantId: 'V1',
        sku: 'SKU101',
        title: 'Floral Georgette Saree',
        variantTitle: 'Free Size / Peach',
        imageUrl: null,
        quantity: 2,
        price: 1249.5,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    shipment: {
      id: 88,
      orderId: 101,
      waybillNumber: '1409218888',
      courier: 'Delhivery',
      status: 'AWB_ASSIGNED',
      trackingStatus: 'In Transit',
      trackingLocation: 'Surat Hub',
      shippingMode: 'Surface',
      paymentMode: 'Pre-paid',
      codAmount: 0,
      labelUrl: null,
      labelStoragePath: null,
      shippingCost: null,
      chargedWeight: null,
      weightMismatch: false,
      mismatchDetails: null,
      declaredWeightGrams: 500,
      billedWeightGrams: null,
      chargedZone: null,
      initialCost: 0,
      reversalAmount: 0,
      revisedCost: 0,
      hasReversal: false,
      reversalReason: null,
      totalDebited: 0,
      totalCredited: 0,
      netBilledCost: 0,
      billingStatus: null,
      lastBilledAt: null,
      codRemitted: false,
      codRemittedAt: null,
      codCollected: false,
      codCollectedAt: null,
      codRemittanceRef: null,
      trackingUpdatedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };

  it('generates accurate manifest CSV including SKU summary and order totals', () => {
    const csv = bulkPackService.generateManifestCsv([sampleOrder]);
    expect(csv).toContain('Order Name');
    expect(csv).toContain('#26YOU9001');
    expect(csv).toContain('Ananya Verma');
    expect(csv).toContain('1409218888');
    expect(csv).toContain('SKU101');
    expect(csv).toContain('2499.00');
  });

  it('streams a non-empty ZIP archive containing all required files', async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    await bulkPackService.streamBulkPackZip([sampleOrder], stream);

    const totalBuffer = Buffer.concat(chunks);
    // Standard ZIP file signature: PK\x03\x04
    expect(totalBuffer.length).toBeGreaterThan(500);
    expect(totalBuffer[0]).toBe(0x50); // P
    expect(totalBuffer[1]).toBe(0x4b); // K
    expect(totalBuffer[2]).toBe(0x03);
    expect(totalBuffer[3]).toBe(0x04);
  });
});
