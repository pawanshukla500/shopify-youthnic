import axios, { AxiosInstance } from 'axios';
import { config } from '../../config';
import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { isUsableHttpUrl } from '../../utils/signed-url';
import { withRetry } from '../../utils/retry';
import { Order } from '@prisma/client';
import { reverseProductDescription } from '../returns/return-reasons';
import {
  isExistingPickupError,
  planWarehousePickupSlot,
  readPickupId,
} from './pickup-schedule';

/**
 * Delhivery B2C API Service
 *
 * All production APIs use base URL: https://track.delhivery.com
 * Staging base URL: https://staging-express.delhivery.com
 *
 * API endpoints (from official Delhivery developer portal):
 *   1. Pincode Serviceability:  GET  /c/api/pin-codes/json/?filter_codes={pin}
 *   2. Expected TAT:             GET  /api/dc/expected_tat?origin_pin={origin}&destination_pin={dest}&mot=S
 *   3. Fetch Waybill (single):   GET  /waybill/api/fetch/json/?token={token}
 *   4. Fetch Waybill (bulk):     GET  /waybill/api/bulk/json/?token={token}&count={n}
 *   5. Shipment Creation:        POST /api/cmu/create.json  (body: format=json&data={JSON_STRING})
 *   6. Shipment Tracking:        GET  /api/v1/packages/json/?waybill={awb}&ref_ids={order_id}
 *   7. Generate Label:           GET  /api/p/packing_slip?wbns={awb}&pdf=true&pdf_size={size}
 *   8. Pickup Request:           POST /fm/request/new/  (JSON body)
 *   9. Shipment Cancellation:    POST /api/p/edit  (JSON body: {waybill, cancellation})
 *  10. NDR Action:               POST /api/p/update  (RE-ATTEMPT/PICKUP_RESCHEDULE/DEFER_DLV/EDIT_DETAILS → UPL id)
 *      NDR UPL status:           GET  /api/cmu/get_bulk_upl/{uplId}?verbose=true
 *  11. Warehouse create/edit:    POST /api/backend/clientwarehouse/create|edit/ (one-time pickup registration)
 *  11. Download Document:        GET  /api/rest/fetch/pkg/document/?doc_type={type}&waybill={awb}
 *  12. RVP with QC:              POST /api/cmu/create.json  (same as creation, with qc_type + custom_qc)
 */
class DelhiveryService {
  private client: AxiosInstance;

  constructor() {
    // All B2C APIs use a single base URL
    this.client = axios.create({
      baseURL: config.delhivery.baseUrl,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    // Authenticate per request so a missing token surfaces as an actionable
    // error at the call site rather than as an opaque 401 from Delhivery.
    this.client.interceptors.request.use((requestConfig) => {
      if (!config.delhivery.apiToken) {
        throw new Error(
          'DELHIVERY_API_TOKEN is not set. Add the production token from the Delhivery panel to your environment.'
        );
      }
      requestConfig.headers['Authorization'] = `Token ${config.delhivery.apiToken}`;
      return requestConfig;
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 1. PINCODE SERVICEABILITY
  // ═══════════════════════════════════════════════════════════

  /**
   * Check if a pincode is serviceable by Delhivery.
   * GET /c/api/pin-codes/json/?filter_codes={pincode}
   *
   * Returns: { serviceable: boolean, remark: string }
   * - Empty list = NSZ (non-serviceable)
   * - remark "Embargo" = temporary NSZ
   * - blank remark = serviceable
   */
  async checkPincodeServiceability(pincode: string): Promise<{
    serviceable: boolean;
    remark: string;
    codAvailable: boolean;
    prepaidAvailable: boolean;
  }> {
    try {
      const response = await this.client.get('/c/api/pin-codes/json/', {
        params: { filter_codes: pincode },
      });

      const data = response.data;
      const pinData = data?.delivery_codes?.[0]?.postal_code;
      const pincodeList = data?.delivery_codes || [];

      if (pincodeList.length === 0) {
        logger.info('Pincode not serviceable (NSZ)', { pincode });
        return { serviceable: false, remark: 'NSZ', codAvailable: false, prepaidAvailable: false };
      }

      const remark = pinData?.remark || '';
      const codAvailable = pinData?.cod === 'Y' || pinData?.cod === true;
      const prepaidAvailable = pinData?.pre_paid === 'Y' || pinData?.pre_paid === true;
      const serviceable = remark !== 'Embargo';

      logger.info('Pincode serviceability checked', {
        pincode,
        serviceable,
        remark,
        cod: codAvailable,
        prepaid: prepaidAvailable,
      });

      return { serviceable, remark, codAvailable, prepaidAvailable };
    } catch (error: any) {
      logger.error('Failed to check pincode serviceability', {
        pincode,
        error: error.message,
      });
      // Do not create a shipment when serviceability could not be verified.
      return {
        serviceable: false,
        remark: 'SERVICEABILITY_CHECK_FAILED',
        codAvailable: false,
        prepaidAvailable: false,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 2. EXPECTED TAT
  // ═══════════════════════════════════════════════════════════

  /**
   * Get expected Turn Around Time (delivery days) between two pincodes.
   * GET /api/dc/expected_tat?origin_pin={origin}&destination_pin={dest}&mot=S&pdt=B2C
   *
   * mot: 'S' = Surface, 'E' = Express, 'N' = NDD (Next Day Delivery)
   */
  async getExpectedTAT(
    originPin: string,
    destinationPin: string,
    mot: string = 'S'
  ): Promise<{ tatDays: number | null; expectedDeliveryDate: string | null }> {
    try {
      const response = await this.client.get('/api/dc/expected_tat', {
        params: {
          origin_pin: originPin,
          destination_pin: destinationPin,
          mot,
          pdt: 'B2C',
        },
      });

      const data = response.data;
      const tatDays = data?.expected_tat ? parseInt(data.expected_tat, 10) : null;
      const expectedDeliveryDate = data?.expected_delivery_date || null;

      logger.info('Expected TAT fetched', { originPin, destinationPin, tatDays });
      return { tatDays, expectedDeliveryDate };
    } catch (error: any) {
      logger.error('Failed to fetch expected TAT', {
        originPin,
        destinationPin,
        error: error.message,
      });
      return { tatDays: null, expectedDeliveryDate: null };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 3. WAYBILL MANAGEMENT
  // ═══════════════════════════════════════════════════════════

  /**
   * Fetch a single waybill number.
   * GET /waybill/api/fetch/json/?token={token}
   *
   * Note: Delhivery recommends pre-fetching waybills and storing them
   * rather than fetching on-demand during order creation.
   */
  async fetchSingleWaybill(): Promise<string> {
    try {
      const response = await this.client.get('/waybill/api/fetch/json/', {
        params: { token: config.delhivery.apiToken },
      });
      const waybill = response.data;
      logger.info('Single waybill fetched', { waybill });
      return waybill;
    } catch (error: any) {
      logger.error('Failed to fetch single waybill', { error: error.message });
      throw error;
    }
  }

  /**
   * Fetch waybills in bulk (up to 10,000).
   * GET /waybill/api/bulk/json/?token={token}&count={count}
   *
   * Note: Waybills are generated in batches of 25 at the backend.
   * Using them immediately may cause errors — store and use later.
   */
  async fetchBulkWaybills(count: number): Promise<string[]> {
    try {
      const response = await this.client.get('/waybill/api/bulk/json/', {
        params: { token: config.delhivery.apiToken, count },
      });
      const waybills = response.data;
      logger.info('Bulk waybills fetched', { count: waybills.length });
      return waybills;
    } catch (error: any) {
      logger.error('Failed to fetch bulk waybills', { error: error.message });
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 4. SHIPMENT CREATION (ORDER CREATION / MANIFEST)
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a forward shipment on Delhivery.
   * POST /api/cmu/create.json
   *
   * IMPORTANT: The body must be URL-encoded form data:
   *   format=json&data={JSON_STRING}
   * NOT a JSON body.
   *
   * If a pre-fetched waybill is available, it will be passed in the payload.
   * Otherwise, Delhivery will auto-generate one.
   */
  async createShipment(
    order: Order,
    options: { itemCount?: number } = {}
  ): Promise<{ waybillNumber: string; labelUrl?: string }> {
    const codAmount = order.paymentMethod === 'COD' ? order.totalAmount : 0;
    const paymentMode = order.paymentMethod === 'COD' ? 'COD' : 'Prepaid';

    // Check pincode serviceability before creating shipment
    const serviceability = await this.checkPincodeServiceability(order.customerPincode);
    if (!serviceability.serviceable) {
      throw new Error(
        `Pincode ${order.customerPincode} is not serviceable by Delhivery (${serviceability.remark})`
      );
    }

    // If COD order, check if COD is available at this pincode
    if (paymentMode === 'COD' && !serviceability.codAvailable) {
      logger.warn('COD not available at this pincode, falling back to prepaid', {
        pincode: order.customerPincode,
      });
    }

    // ─── Package dimensions & declared weight ─────────────────────────────────
    // Single-piece shipment (≤1 unique line item): 22 × 20 × 3 cm
    // Multi-piece shipment (≥2 line items):       22 × 20 × 5 cm
    // Declared weight: 500g (caps most SKU profile under Delhivery's 500g slab;
    //   actual items are typically 350–450g so we never cross into the next slab).
    const lineItemCount = options.itemCount ?? 1;
    const isMultiItem = lineItemCount > 1;
    const shipmentLengthCm = isMultiItem
      ? config.delhivery.multiItemLengthCm
      : config.delhivery.singleItemLengthCm;
    const shipmentBreadthCm = isMultiItem
      ? config.delhivery.multiItemBreadthCm
      : config.delhivery.singleItemBreadthCm;
    const shipmentHeightCm = isMultiItem
      ? config.delhivery.multiItemHeightCm
      : config.delhivery.singleItemHeightCm;
    const declaredWeightGrams = config.delhivery.declaredWeightGrams;

    // Build the shipment payload
    const shipmentData = {
      shipments: [
        {
          name: order.customerName,
          order: order.shopifyOrderName.replace('#', ''),
          phone: order.customerPhone,
          add: order.customerAddress,
          pin: order.customerPincode,
          city: order.customerCity,
          state: order.customerState,
          country: order.customerCountry,
          payment_mode: paymentMode,
          cod_amount: codAmount > 0 ? codAmount.toString() : '',
          total_amount: order.totalAmount.toString(),
          shipping_mode: config.delhivery.shippingMode,
          order_date: order.shopifyCreatedAt.toISOString().split('T')[0],
          return_name: config.delhivery.seller.name,
          return_add: config.delhivery.seller.address,
          return_city: config.delhivery.seller.city,
          return_state: config.delhivery.seller.state,
          return_country: 'India',
          return_pin: config.delhivery.seller.pincode,
          return_phone: config.delhivery.seller.phone,
          seller_name: config.delhivery.seller.name,
          seller_add: config.delhivery.seller.address,
          // Attribute to configured Shopify channel in Delhivery One (Shopify: youthnic2024)
          channel: 'youthnic2024',
          channel_name: 'Shopify: youthnic2024',
          source: 'Shopify',
          sales_channel: 'youthnic2024',
          // Package dimensions & declared weight (kept under Delhivery's 500g slab
          // and 22×20×5 cm envelope size to minimise logistic cost).
          shipment_length: shipmentLengthCm,
          shipment_breadth: shipmentBreadthCm,
          shipment_width: shipmentBreadthCm,
          shipment_height: shipmentHeightCm,
          weight: declaredWeightGrams,           // grams
          gm: declaredWeightGrams,               // alias used by some B2C endpoints
          // Pre-allocated Delhivery waybill passed directly to manifest API
          waybill: '',
        },
      ],
      pickup_location: {
        name: config.delhivery.pickupLocation,
      },
    };

    // 1. Pre-fetch an official Delhivery AWB number so we are guaranteed a valid waybill.
    // The number is only kept after Delhivery accepts the manifest. A low-wallet
    // rejection must not leave this reserved id on the order.
    let waybillNumber = '';
    let manifestSaved = false;
    try {
      waybillNumber = await this.fetchSingleWaybill();
      shipmentData.shipments[0].waybill = waybillNumber;
      logger.info('Pre-fetched Delhivery waybill for shipment', {
        shopifyOrderId: order.shopifyOrderId,
        waybillNumber,
      });
    } catch (wbErr: any) {
      logger.warn('Failed to pre-fetch Delhivery waybill, falling back to Delhivery auto-assignment', {
        error: wbErr.message,
      });
    }

    try {
      // CRITICAL: Body must be URL-encoded form data, not JSON
      const formData = `format=json&data=${encodeURIComponent(JSON.stringify(shipmentData))}`;

      let manifestRemark = '';
      let packageStatus = '';
      try {
        const response = await this.client.post('/api/cmu/create.json', formData, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        });

        // Extract returned waybill if Delhivery provided one
        const returnedWaybill =
          response.data?.packages?.[0]?.waybill ||
          response.data?.shipments?.[0]?.waybill ||
          response.data?.waybill;

        if (returnedWaybill) {
          waybillNumber = returnedWaybill;
        }

        packageStatus = response.data?.packages?.[0]?.status || (response.data?.success === false ? 'Fail' : '');
        const acknowledged = response.data?.success === true || /^(success|manifested)$/i.test(packageStatus);
        if (!acknowledged && packageStatus !== 'Fail' && response.data?.success !== false) {
          await prisma.order.updateMany({
            where: { id: order.id, status: { in: ['NEW', 'DISPATCH_PENDING'] } },
            data: { supportFlag: 'MANIFEST_REVIEW', hasUrgentSupport: true },
          });
          throw new Error('Manifest outcome unconfirmed. Check this order in Delhivery ONE before another dispatch.');
        }
        const remarks = response.data?.packages?.[0]?.remarks || [];
        manifestRemark = remarks.join('; ') || response.data?.rmk || '';

        if (/^fail$/i.test(packageStatus) || response.data?.success === false || manifestRemark.toLowerCase().includes('insufficient balance')) {
          const detailedError = manifestRemark.toLowerCase().includes('insufficient balance')
            ? 'Delhivery Manifest Failed: Insufficient balance in Delhivery prepaid wallet. Please recharge your Delhivery One account.'
            : (manifestRemark || 'Delhivery manifest was rejected by courier.');
          
          logger.error('Delhivery manifest returned non-success remark', {
            shopifyOrderId: order.shopifyOrderId,
            remarks: manifestRemark,
            reservedWaybill: waybillNumber || null,
          });

          // The pre-fetched number is not a shipment. Drop it so the order
          // stays in Ready to Dispatch instead of showing a dead carrier ID.
          waybillNumber = '';
          await this.recordRejectedManifest(order, paymentMode, codAmount, detailedError);
          throw new Error(detailedError);
        }
      } catch (cmuErr: any) {
        if (!cmuErr?.response && /Manifest Failed|rejected by courier|insufficient balance/i.test(cmuErr?.message || '')) {
          throw cmuErr;
        }
        const rawErr = cmuErr.response?.data?.rmk || cmuErr.message || '';
        if (!cmuErr.response || cmuErr.response.status >= 500) {
          await prisma.order.updateMany({
            where: { id: order.id, status: { in: ['NEW', 'DISPATCH_PENDING'] } },
            data: { supportFlag: 'MANIFEST_REVIEW', hasUrgentSupport: true },
          });
        }
        const detailedError = rawErr.toLowerCase().includes('insufficient balance')
          ? 'Delhivery Manifest Failed: Insufficient balance in Delhivery prepaid wallet. Please recharge your Delhivery One account.'
          : (rawErr || 'Delhivery manifest API call failed.');

        logger.error('Delhivery /api/cmu/create.json call encountered error', {
          error: detailedError,
          reservedWaybill: waybillNumber || null,
        });

        waybillNumber = '';
        await this.recordRejectedManifest(order, paymentMode, codAmount, detailedError);
        throw new Error(detailedError);
      }

      if (!waybillNumber) {
        logger.error('Delhivery did not return a waybill number and pre-fetch was unavailable', {
          shopifyOrderId: order.shopifyOrderId,
          remark: manifestRemark,
        });
        throw new Error(`Delhivery waybill generation failed: ${manifestRemark || 'No waybill assigned'}`);
      }

      // Upsert the shipment in DB with the official Delhivery waybill
      const omsManifestedAt = new Date();
      await prisma.shipment.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          waybillNumber,
          manifestedByOms: true,
          manifestPickupLocation: config.delhivery.pickupLocation,
          omsManifestedAt,
          courier: 'Delhivery',
          paymentMode,
          codAmount: codAmount,
          declaredValue: order.totalAmount,
          status: 'CREATED',
          errorMessage: null,
        },
        update: {
          waybillNumber,
          pickupBatchKey: null,
          manifestedByOms: true,
          manifestPickupLocation: config.delhivery.pickupLocation,
          omsManifestedAt,
          courier: 'Delhivery',
          paymentMode,
          codAmount: codAmount,
          declaredValue: order.totalAmount,
          status: 'CREATED',
          errorMessage: null,
        },
      });

      // Update order status to DISPATCHED, unless a Shopify cancel landed while
      // the manifest call was running (dispatchOrder then cancels this AWB).
      await prisma.order.updateMany({
        where: { id: order.id, status: { in: ['NEW', 'DISPATCH_PENDING'] } },
        data: { status: 'DISPATCHED' },
      });
      manifestSaved = true;

      // Generate and save the label URL (if Delhivery cloud packing slip is ready)
      let labelUrl = '';
      try {
        labelUrl = await this.generateLabel(waybillNumber);
        if (labelUrl) {
          await prisma.shipment.update({
            where: { orderId: order.id },
            data: { labelUrl },
          });
        }
      } catch {
        // Label fallback is generated on-the-fly
      }

      // Pickup is queued by dispatchOrder after its cancellation-safe promotion.

      logger.info('Shipment successfully dispatched on Delhivery', {
        shopifyOrderId: order.shopifyOrderId,
        waybillNumber,
        labelUrl: labelUrl || 'Standard 4R Thermal Generated',
        manifestRemark: manifestRemark || undefined,
      });

      return { waybillNumber, labelUrl };
    } catch (error: any) {
      logger.error('Failed to create Delhivery shipment', {
        shopifyOrderId: order.shopifyOrderId,
        error: error.response?.data || error.message,
      });

      // A reserved waybill is cleared only when Delhivery never accepted the manifest.
      if (manifestSaved) throw error;

      await prisma.shipment.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          waybillNumber: null,
          courier: 'Delhivery',
          paymentMode,
          codAmount: codAmount,
          declaredValue: order.totalAmount,
          status: 'ERROR',
          errorMessage: error.response?.data?.error || error.message,
          labelUrl: null,
          trackingStatus: null,
        },
        update: {
          waybillNumber: null,
          labelUrl: null,
          trackingStatus: null,
          status: 'ERROR',
          errorMessage: error.response?.data?.error || error.message,
        },
      });

      const leaveAsIs = [
        'CANCELLED',
        'RTO_INITIATED',
        'RTO_DELIVERED',
        'RETURN_REQUESTED',
        'RETURN_DISPATCHED',
        'RETURN_RECEIVED',
        'DELIVERED',
        'REFUNDED',
      ];
      if (!leaveAsIs.includes(order.status)) {
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'DISPATCH_PENDING' },
        });
      }

      throw error;
    }
  }

  /**
   * Manifest was refused. The reserved waybill is not a Delhivery shipment.
   * Drop it and send the order back to Ready to Dispatch, except cancel / RTO / delivered.
   */
  private async recordRejectedManifest(
    order: Order,
    paymentMode: string,
    codAmount: number,
    errorMessage: string
  ): Promise<void> {
    await prisma.shipment.upsert({
      where: { orderId: order.id },
      create: {
        orderId: order.id,
        waybillNumber: null,
        courier: 'Delhivery',
        paymentMode,
        codAmount,
        declaredValue: order.totalAmount,
        status: 'ERROR',
        errorMessage,
        labelUrl: null,
        trackingStatus: null,
      },
      update: {
        waybillNumber: null,
        courier: 'Delhivery',
        status: 'ERROR',
        errorMessage,
        labelUrl: null,
        trackingStatus: null,
      },
    });

    const leaveAsIs = [
      'CANCELLED',
      'RTO_INITIATED',
      'RTO_DELIVERED',
      'RETURN_REQUESTED',
      'RETURN_DISPATCHED',
      'RETURN_RECEIVED',
      'DELIVERED',
      'REFUNDED',
    ];
    if (!leaveAsIs.includes(order.status)) {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'DISPATCH_PENDING' },
      });
    }
  }

  /**
   * Create a reverse pickup (RVP / DTO) on Delhivery — the API equivalent of
   * Delhivery ONE → Delivered order → Initiate Return.
   *
   * Same manifestation endpoint as a forward order. payment_mode "Pickup"
   * tells Delhivery to collect from the customer and drop at the registered
   * warehouse. Delhivery schedules that customer pickup automatically.
   * Do not also call POST /fm/request/new/ for a reverse shipment.
   */
  async createReturnShipment(
    order: Order,
    returnReason: string,
    forwardWaybill?: string,
    items?: Array<{ title?: string | null; sku?: string | null; quantity?: number | null }>
  ): Promise<{ waybillNumber: string; pickupAutomatic: true }> {
    if (!order.customerPincode || !order.customerPhone || !order.customerAddress) {
      throw new Error('Customer address, phone, and pincode are required before a reverse pickup can be booked.');
    }

    try {
      const serviceability = await this.checkPincodeServiceability(order.customerPincode);
      if (!serviceability.serviceable) {
        throw new Error(`Pincode ${order.customerPincode} is not serviceable for reverse pickup`);
      }
    } catch (err: any) {
      if (String(err?.message || '').includes('not serviceable')) throw err;
      logger.warn('Reverse serviceability check failed, continuing to manifest', {
        shopifyOrderId: order.shopifyOrderId,
        error: err.message,
      });
    }

    const lines = items?.length ? items : [];
    const itemCount = Math.max(1, lines.length);
    const isMultiItem = itemCount > 1;
    const quantity = lines.reduce((sum, line) => sum + Math.max(1, Number(line.quantity) || 1), 0) || 1;
    const productText = lines
      .map((line) => [line.title, line.sku ? `(${line.sku})` : ''].filter(Boolean).join(' '))
      .filter(Boolean)
      .join(', ');
    const productsDesc = reverseProductDescription(returnReason, productText);
    // Same sale-order id Delhivery One prefills on Initiate Return. A new
    // waybill is passed explicitly, which is what lets this order id repeat.
    const saleOrderId = order.shopifyOrderName.replace('#', '').replace(/[^A-Za-z0-9_-]/g, '');

    const shipmentData = {
      shipments: [
        {
          name: order.customerName,
          order: saleOrderId,
          phone: order.customerPhone,
          add: order.customerAddress,
          pin: order.customerPincode,
          city: order.customerCity,
          state: order.customerState,
          country: order.customerCountry || 'India',
          payment_mode: 'Pickup',
          products_desc: productsDesc || returnReason,
          total_amount: String(order.totalAmount || 0),
          cod_amount: '0',
          quantity: String(quantity),
          shipping_mode: config.delhivery.shippingMode,
          address_type: 'home',
          order_date: new Date().toISOString().split('T')[0],
          // Ties the reverse order to the delivered forward AWB.
          ref_waybill: forwardWaybill || '',
          reference_number: forwardWaybill || order.shopifyOrderName.replace('#', ''),
          return_name: config.delhivery.seller.name,
          return_add: config.delhivery.seller.address,
          return_city: config.delhivery.seller.city,
          return_state: config.delhivery.seller.state,
          return_country: 'India',
          return_pin: config.delhivery.seller.pincode,
          return_phone: config.delhivery.seller.phone,
          seller_name: config.delhivery.seller.name,
          seller_add: config.delhivery.seller.address,
          shipment_length: isMultiItem ? config.delhivery.multiItemLengthCm : config.delhivery.singleItemLengthCm,
          shipment_breadth: isMultiItem ? config.delhivery.multiItemBreadthCm : config.delhivery.singleItemBreadthCm,
          shipment_height: isMultiItem ? config.delhivery.multiItemHeightCm : config.delhivery.singleItemHeightCm,
          shipment_width: isMultiItem ? config.delhivery.multiItemBreadthCm : config.delhivery.singleItemBreadthCm,
          weight: config.delhivery.declaredWeightGrams,
          gm: config.delhivery.declaredWeightGrams,
          waybill: '',
        },
      ],
      pickup_location: {
        name: config.delhivery.pickupLocation,
      },
    };

    let prefetched = '';
    try {
      const fetched = await this.fetchSingleWaybill();
      if (typeof fetched === 'string' && /^\d{8,}$/.test(fetched.trim())) {
        prefetched = fetched.trim();
        shipmentData.shipments[0].waybill = prefetched;
      }
    } catch (wbErr: any) {
      logger.warn('Reverse waybill pre-fetch failed, Delhivery will assign one', { error: wbErr.message });
    }

    try {
      const formData = `format=json&data=${encodeURIComponent(JSON.stringify(shipmentData))}`;
      const response = await this.client.post('/api/cmu/create.json', formData, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      const pkg = response.data?.packages?.[0] || response.data?.shipments?.[0] || {};
      const remarks = Array.isArray(pkg.remarks) ? pkg.remarks.join('; ') : String(pkg.remarks || response.data?.rmk || '');
      const packageStatus = String(pkg.status || (response.data?.success === false ? 'Fail' : ''));
      const waybillNumber = String(pkg.waybill || response.data?.waybill || prefetched || '').trim();

      if (
        packageStatus.toLowerCase() === 'fail' ||
        response.data?.success === false ||
        remarks.toLowerCase().includes('insufficient balance')
      ) {
        const detailed = remarks.toLowerCase().includes('insufficient balance')
          ? 'Delhivery reverse pickup failed: insufficient prepaid wallet balance. Recharge Delhivery ONE and try again.'
          : remarks || 'Delhivery rejected the reverse pickup.';
        throw new Error(detailed);
      }

      if (!/^\d{8,}$/.test(waybillNumber)) {
        throw new Error(remarks || 'Delhivery did not assign a reverse waybill. The return was not created.');
      }

      logger.info('Return shipment (RVP) created on Delhivery', {
        shopifyOrderId: order.shopifyOrderId,
        forwardWaybill,
        returnWaybill: waybillNumber,
      });

      return { waybillNumber, pickupAutomatic: true };
    } catch (error: any) {
      const raw = error.response?.data?.rmk || error.response?.data?.packages?.[0]?.remarks || error.message;
      const message = Array.isArray(raw) ? raw.join('; ') : String(raw || 'Delhivery reverse pickup failed');
      logger.error('Failed to create Delhivery RVP shipment', {
        shopifyOrderId: order.shopifyOrderId,
        error: message,
      });
      if (error instanceof Error && error.message === message) throw error;
      throw new Error(message);
    }
  }

  /**
   * Create a reverse pickup with doorstep Quality Check (QC).
   * This uses the parametric QC model — FE answers questions at the customer's door.
   * Pickup only happens if all mandatory QC questions pass.
   *
   * QC questions must be pre-mapped with Delhivery's BD team.
   */
  async createReturnWithQC(
    order: Order,
    returnReason: string,
    qcItems: Array<{
      item: string;
      description: string;
      quantity: number;
      brand?: string;
      productCategory?: string;
      images?: string[];
      questions: Array<{
        questionsId: string;
        options?: string[];
        value: string[];
        required: boolean;
        type: 'varchar' | 'multi';
        quesImages?: string[];
      }>;
    }>,
    forwardWaybill?: string
  ): Promise<{ waybillNumber: string }> {
    const shipmentData = {
      shipments: [
        {
          name: order.customerName,
          order: `RET-${order.shopifyOrderName.replace('#', '')}`,
          phone: order.customerPhone,
          add: order.customerAddress,
          pin: order.customerPincode,
          city: order.customerCity,
          state: order.customerState,
          country: order.customerCountry,
          payment_mode: 'Pickup',
          products_desc: returnReason,
          total_amount: '0',
          cod_amount: '',
          shipping_mode: config.delhivery.shippingMode,
          order_date: new Date().toISOString().split('T')[0],
          // Link back to original forward waybill / order
          ref_waybill: forwardWaybill || '',
          reference_number: forwardWaybill || order.shopifyOrderName.replace('#', ''),
          return_name: config.delhivery.seller.name,
          return_add: config.delhivery.seller.address,
          return_city: config.delhivery.seller.city,
          return_state: config.delhivery.seller.state,
          return_country: 'India',
          return_pin: config.delhivery.seller.pincode,
          return_phone: config.delhivery.seller.phone,
          seller_name: config.delhivery.seller.name,
          seller_add: config.delhivery.seller.address,
          waybill: '',
          // QC-specific fields
          qc_type: 'param',
          custom_qc: qcItems.map((item) => ({
            item: item.item,
            description: item.description,
            images: item.images || [],
            return_reason: returnReason,
            quantity: item.quantity,
            brand: item.brand || '',
            product_category: item.productCategory || '',
            questions: item.questions.map((q) => ({
              questions_id: q.questionsId,
              options: q.options || [],
              value: q.value,
              required: q.required,
              type: q.type,
              ques_images: q.quesImages || [],
            })),
          })),
        },
      ],
      pickup_location: {
        name: config.delhivery.pickupLocation,
      },
    };

    try {
      const formData = `format=json&data=${encodeURIComponent(JSON.stringify(shipmentData))}`;

      const response = await this.client.post('/api/cmu/create.json', formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const waybillNumber =
        response.data?.packages?.[0]?.waybill ||
        response.data?.shipments?.[0]?.waybill ||
        response.data?.waybill;

      if (!waybillNumber) {
        throw new Error('No waybill number returned for RVP QC shipment');
      }

      logger.info('RVP QC shipment created on Delhivery', {
        shopifyOrderId: order.shopifyOrderId,
        returnWaybill: waybillNumber,
      });

      return { waybillNumber };
    } catch (error: any) {
      logger.error('Failed to create RVP QC shipment', {
        shopifyOrderId: order.shopifyOrderId,
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 5. SHIPMENT TRACKING
  // ═══════════════════════════════════════════════════════════

  /**
   * Track a shipment by waybill number.
   * GET /api/v1/packages/json/?waybill={waybill}
   *
   * Can track up to 50 waybills (comma-separated).
   * Returns scan details with status, status_type, location, timestamps.
   *
   * Status Types (from package lifecycle):
   *   UD = Undelivered (Manifested, Not Picked, In Transit, Pending, Dispatched)
   *   DL = Delivered (Delivered, RTO, DTO)
   *   RT = Return (In Transit, Pending, Dispatched)
   *   PP = Pickup Planned (Open, Scheduled, Dispatched)
   *   PU = Picked Up (In Transit, Pending, Dispatched)
   *   CN = Canceled (Canceled, Closed)
   */
  async trackShipment(waybillNumber: string): Promise<{
    status: string;
    statusType: string;
    location?: string;
    scanDateTime?: string;
    remarks?: string;
    receivedBy?: string;
    history: Array<{
      status: string;
      statusType: string;
      location: string;
      dateTime: string;
      date?: string;
      remark?: string;
    }>;
    pickupDone?: boolean;
    pickedupDate?: string | null;
    pickUpDate?: string | null;
    dispatchCount?: number;
    originRecieveDate?: string | null;
    expectedDeliveryDate?: string | null;
    statusCode?: string;
    referenceNo?: string;
  }> {
    try {
      // Retry transient courier blips (429/5xx/timeout) instead of falling back to UNKNOWN.
      const response = await withRetry(
        () =>
          this.client.get('/api/v1/packages/json/', {
            params: { waybill: waybillNumber },
          }),
        { attempts: 3, baseDelayMs: 500 }
      );

      const shipmentData = response.data?.ShipmentData?.[0]?.Shipment;

      if (!shipmentData) {
        logger.warn('No tracking data found for waybill', { waybillNumber });
        return { status: 'UNKNOWN', statusType: '', history: [] };
      }

      // Real shape: scans live at Shipment.Scans[].ScanDetail (verified 2026-09-28
      // against live AWB 30100810010054). Legacy top-level ScanDetail kept as fallback.
      const rawScans: any[] = Array.isArray(shipmentData.Scans)
        ? shipmentData.Scans.map((w: any) => w?.ScanDetail).filter(Boolean)
        : [];
      const legacyScans: any[] = Array.isArray(response.data?.ShipmentData?.[0]?.ScanDetail)
        ? response.data.ShipmentData[0].ScanDetail
        : [];
      const scanDetails = rawScans.length ? rawScans : legacyScans;

      const latestStatus = shipmentData.Status || {};
      const history = scanDetails.map((scan: any) => ({
        status: scan.Scan || scan.Instructions || 'SCAN',
        statusType: scan.ScanType || '',
        location: scan.ScanLocation || scan.ScannedLocation || '',
        dateTime: scan.ScanDateTime || scan.StatusDateTime,
        date: scan.ScanDateTime || scan.StatusDateTime,
        remark: scan.Instructions,
      }));

      // Pickup-done signals straight from Delhivery (null = not yet picked up):
      //   PickedupDate (note Delhivery's typo, single 'e'), OriginRecieveDate, DispatchCount.
      const pickedupDate: string | null = shipmentData.PickedupDate || null;
      const pickUpDate: string | null = shipmentData.PickUpDate || null;
      const dispatchCount: number = Number(shipmentData.DispatchCount || 0);
      const originRecieveDate: string | null = shipmentData.OriginRecieveDate || null;
      const pickupDone = Boolean(
        pickedupDate ||
          originRecieveDate ||
          dispatchCount > 0 ||
          history.some((h: any) => /pick.*up|received|reached.*origin|in transit|dispatched|out for delivery|delivered/i.test(`${h.status} ${h.remark || ''}`))
      );

      return {
        status: latestStatus.Status,
        statusType: latestStatus.StatusType,
        location: latestStatus.StatusLocation,
        scanDateTime: latestStatus.ScanDateTime || latestStatus.StatusDateTime,
        remarks: latestStatus.Instructions,
        receivedBy: latestStatus.RecievedBy,
        history,
        pickupDone,
        pickedupDate,
        pickUpDate,
        dispatchCount,
        originRecieveDate,
        expectedDeliveryDate:
          shipmentData.ExpectedDeliveryDate || shipmentData.PromisedDeliveryDate || null,
        statusCode: latestStatus.StatusCode,
        referenceNo: shipmentData.ReferenceNo,
      };
    } catch (error: any) {
      logger.error('Failed to track shipment', {
        waybillNumber,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Track multiple shipments at once (up to 50 waybills).
   */
  async trackMultipleShipments(waybillNumbers: string[]): Promise<any> {
    if (waybillNumbers.length > 50) {
      throw new Error('Cannot track more than 50 waybills in a single request');
    }
    const combined = waybillNumbers.join(',');
    try {
      const response = await withRetry(
        () =>
          this.client.get('/api/v1/packages/json/', {
            params: { waybill: combined },
          }),
        { attempts: 3, baseDelayMs: 500 }
      );
      return response.data?.ShipmentData || [];
    } catch (error: any) {
      logger.error('Failed to track multiple shipments', { error: error.message });
      throw error;
    }
  }

  /**
   * Fetch shipment details for up to 50 order reference IDs at once.
   * GET /api/v1/packages/json/?ref_ids={ref_ids}
   * Used to reconcile Delhivery One channel orders against OMS database.
   */
  async fetchPackagesByRefIds(refIds: string[]): Promise<any[]> {
    if (!refIds.length) return [];
    const chunks: string[] = [];
    for (let i = 0; i < refIds.length; i += 50) {
      chunks.push(refIds.slice(i, i + 50).join(','));
    }

    const allData: any[] = [];
    for (const chunk of chunks) {
      try {
        const response = await this.client.get('/api/v1/packages/json/', {
          params: { ref_ids: chunk },
        });
        const raw = response.data;
        const shipmentData = raw?.ShipmentData || raw?.packages || raw?.shipments || raw?.data || [];
        if (Array.isArray(shipmentData)) {
          allData.push(...shipmentData);
        } else if (shipmentData && typeof shipmentData === 'object') {
          allData.push(shipmentData);
        }
      } catch (error: any) {
        logger.warn('Failed to fetch Delhivery packages by ref_ids', {
          error: error.message,
          chunk,
        });
      }
    }
    return allData;
  }

  // ═══════════════════════════════════════════════════════════
  // 6. SHIPMENT UPDATION
  // ═══════════════════════════════════════════════════════════

  /**
   * Update the supported shipment fields.
   * POST /api/p/edit
   *
   * Delhivery only permits updates for specific package statuses. Payment
   * mode changes use `pt`, weight uses `gm`, and phone is sent as a list.
   */
  async updateShipment(
    waybillNumber: string,
    updates: {
      name?: string;
      phone?: string[];
      paymentMode?: 'COD' | 'Prepaid';
      codAmount?: number;
      address?: string;
      productsDescription?: string;
      weightGrams?: number;
      heightCm?: number;
      widthCm?: number;
      lengthCm?: number;
    }
  ): Promise<any> {
    // Fail fast per Edit Order docs: allowed = Manifested/In Transit/Pending/Scheduled;
    // blocked = Delivered/Dispatched/LOST/RTO/DTO/Picked Up/Collected.
    // Our equivalents of blocked: DELIVERED, OUT_FOR_DELIVERY (Dispatched), RTO,
    // RTO_DELIVERED (DTO), PICKED_UP (Picked Up), CANCELLED.
    try {
      const current = await prisma.shipment.findFirst({
        where: { waybillNumber },
        select: { status: true },
      });
      const blocked: string[] = [
        'DELIVERED',
        'OUT_FOR_DELIVERY',
        'RTO',
        'RTO_DELIVERED',
        'PICKED_UP',
        'CANCELLED',
      ];
      if (current && blocked.includes(current.status)) {
        throw new Error(
          `Edit blocked: package is ${current.status} (Delhivery allows edits only for Manifested/In Transit/Pending/Scheduled).`
        );
      }
    } catch (guardErr: any) {
      if (guardErr.message?.startsWith('Edit blocked:')) throw guardErr;
      // DB lookup failure must not block the edit itself — log and continue.
      logger.warn('Edit guard lookup failed, proceeding with Delhivery edit', {
        waybillNumber,
        error: guardErr.message,
      });
    }

    const payload: Record<string, unknown> = { waybill: waybillNumber };

    if (updates.name !== undefined) payload.name = updates.name;
    if (updates.phone !== undefined) payload.phone = updates.phone;
    if (updates.paymentMode !== undefined) payload.pt = updates.paymentMode;
    if (updates.codAmount !== undefined) payload.cod = updates.codAmount;
    if (updates.address !== undefined) payload.add = updates.address;
    if (updates.productsDescription !== undefined) payload.products_desc = updates.productsDescription;
    if (updates.weightGrams !== undefined) payload.gm = updates.weightGrams;
    if (updates.heightCm !== undefined) payload.shipment_height = updates.heightCm;
    if (updates.widthCm !== undefined) payload.shipment_width = updates.widthCm;
    if (updates.lengthCm !== undefined) payload.shipment_length = updates.lengthCm;

    try {
      const response = await this.client.post('/api/p/edit', payload);
      logger.info('Shipment updated on Delhivery', { waybillNumber });
      return response.data;
    } catch (error: any) {
      logger.error('Failed to update Delhivery shipment', {
        waybillNumber,
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 7. E-WAY BILL UPDATE
  // ═══════════════════════════════════════════════════════════

  /**
   * Attach or update an e-way bill for a shipment.
   * PUT /api/rest/ewaybill/{waybill}/
   */
  async updateEwaybill(
    waybillNumber: string,
    invoiceNumber: string,
    ewaybillNumber: string
  ): Promise<any> {
    try {
      const response = await this.client.put(
        `/api/rest/ewaybill/${encodeURIComponent(waybillNumber)}/`,
        {
          data: [{ dcn: invoiceNumber, ewbn: ewaybillNumber }],
        }
      );
      logger.info('E-way bill updated on Delhivery', { waybillNumber });
      return response.data;
    } catch (error: any) {
      logger.error('Failed to update Delhivery e-way bill', {
        waybillNumber,
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 8. SHIPPING COST
  // ═══════════════════════════════════════════════════════════

  /**
   * Get an approximate shipping charge.
   * GET /api/kinko/v1/invoice/charges/.json
   *
   * The result is an estimate and may differ from the final invoice.
  /**
   * Calculate freight charges using Delhivery Commercial B2C Rate Matrix (Surat Origin).
   * Used for offline/instant calculations and fallback if the live rate API is unreachable.
   */
  calculateRateCardMatrix(params: {
    mode: 'E' | 'S';
    chargeableWeightGrams: number;
    originPincode: string;
    destinationPincode: string;
    shipmentStatus: 'Delivered' | 'RTO' | 'DTO';
    paymentType: 'Pre-paid' | 'COD';
    codAmount?: number;
  }) {
    const dest = (params.destinationPincode || '').trim();
    let zoneCode = 'D';
    let zone = 'Zone D - National (Rest of India)';
    let baseFreight = 82;
    let addlWeightRate = 45;

    // Zone detection from Surat Warehouse (395002)
    if (dest.startsWith('395') || dest.startsWith('394')) {
      zoneCode = 'A';
      zone = 'Zone A - Local (Surat City)';
      baseFreight = 40;
      addlWeightRate = 22;
    } else if (
      dest.startsWith('36') ||
      dest.startsWith('37') ||
      dest.startsWith('38') ||
      dest.startsWith('39')
    ) {
      zoneCode = 'B';
      zone = 'Zone B - Within State (Gujarat)';
      baseFreight = 52;
      addlWeightRate = 30;
    } else if (
      dest.startsWith('40') ||
      dest.startsWith('41') ||
      dest.startsWith('42') ||
      dest.startsWith('43') ||
      dest.startsWith('44')
    ) {
      zoneCode = 'C';
      zone = 'Zone C - Regional Metro (Maharashtra)';
      baseFreight = 68;
      addlWeightRate = 38;
    } else if (
      dest.startsWith('79') ||
      dest.startsWith('78') ||
      dest.startsWith('19') ||
      dest.startsWith('18')
    ) {
      zoneCode = 'E';
      zone = 'Zone E - Special (North-East / J&K)';
      baseFreight = 105;
      addlWeightRate = 60;
    }

    if (params.mode === 'E') {
      baseFreight += 25; // Express air premium
    }

    // Weight calculation
    const weightGrams = Math.max(100, params.chargeableWeightGrams || 500);
    const extraWeight = Math.max(0, weightGrams - 500);
    const extraSlabs = Math.ceil(extraWeight / 500);
    const weightCharges = extraSlabs * addlWeightRate;

    // Fuel surcharge: 10% on freight
    const fuelSurcharge = Math.round((baseFreight + weightCharges) * 0.1 * 100) / 100;

    // COD handling fee: ₹38 or 1.5% of COD amount (whichever is higher)
    const isCod = params.paymentType === 'COD';
    const codAmount = params.codAmount || 0;
    const codCharge = isCod ? Math.max(38, Math.round(codAmount * 0.015 * 100) / 100) : 0;

    // Subtotal before tax
    const subtotal = Math.round((baseFreight + weightCharges + fuelSurcharge + codCharge) * 100) / 100;

    // GST (18%)
    const gst = Math.round(subtotal * 0.18 * 100) / 100;

    // Total cost of AWB
    const totalAmount = Math.round((subtotal + gst) * 100) / 100;

    return {
      status: 'success',
      zoneCode,
      zone,
      mode: params.mode === 'E' ? 'Express Air' : 'Surface Ground',
      chargeableWeightGrams: weightGrams,
      originPincode: params.originPincode,
      destinationPincode: params.destinationPincode,
      paymentMode: params.paymentType,
      charges: {
        base: baseFreight,
        weightCharge: weightCharges,
        fuelSurcharge,
        codCharge,
        subtotal,
        gst,
      },
      total_amount: totalAmount,
      totalAmount,
      isEstimate: true,
      source: config.delhivery.apiToken ? 'delhivery_api' : 'commercial_rate_matrix',
    };
  }

  /**
   * Get an approximate shipping charge.
   * GET /api/kinko/v1/invoice/charges/.json
   *
   * Calls Delhivery Rate API when token is configured; otherwise uses commercial rate matrix.
   */
  async calculateShippingCost(params: {
    mode: 'E' | 'S';
    chargeableWeightGrams: number;
    originPincode: string;
    destinationPincode: string;
    shipmentStatus: 'Delivered' | 'RTO' | 'DTO';
    paymentType: 'Pre-paid' | 'COD';
    codAmount?: number;
    length?: number;
    breadth?: number;
    height?: number;
    packageType?: 'box' | 'flyer';
  }): Promise<any> {
    if (config.delhivery.apiToken) {
      try {
        const response = await this.client.get('/api/kinko/v1/invoice/charges/.json', {
          params: {
            md: params.mode,
            cgm: params.chargeableWeightGrams,
            o_pin: params.originPincode,
            d_pin: params.destinationPincode,
            ss: params.shipmentStatus,
            pt: params.paymentType,
            l: params.length,
            b: params.breadth,
            h: params.height,
            ipkg_type: params.packageType,
          },
        });
        if (response.data && (Array.isArray(response.data) ? response.data.length > 0 : Object.keys(response.data).length > 0)) {
          const raw = Array.isArray(response.data) ? response.data[0] : response.data;
          const totalAmount = raw.total_amount || raw.rate || raw.charge_amount || 0;
          return {
            status: 'success',
            originPincode: params.originPincode,
            destinationPincode: params.destinationPincode,
            paymentMode: params.paymentType,
            charges: raw,
            total_amount: totalAmount,
            totalAmount,
            source: 'delhivery_live_api',
          };
        }
      } catch (error: any) {
        logger.warn('Delhivery live rate calculation API unavailable, falling back to commercial rate matrix', {
          originPincode: params.originPincode,
          destinationPincode: params.destinationPincode,
          error: error.response?.data || error.message,
        });
      }
    }

    return this.calculateRateCardMatrix(params);
  }

  /**
   * Delhivery's own rate-card charge for one leg, from the live API only.
   * GET /api/kinko/v1/invoice/charges/.json (ss = Delivered | RTO | DTO).
   *
   * Throws when the API is not configured or returns no amount. It never
   * falls back to calculateRateCardMatrix (an approximation): this number is
   * written into the accounts report as the shipping cost until the actual
   * billed charge from the wallet ledger replaces it.
   */
  async fetchLiveShippingRate(params: {
    mode: 'E' | 'S';
    chargeableWeightGrams: number;
    originPincode: string;
    destinationPincode: string;
    shipmentStatus: 'Delivered' | 'RTO' | 'DTO';
    paymentType: 'Pre-paid' | 'COD';
    codAmount?: number;
  }): Promise<{ total: number; zone?: string; chargedWeightGrams?: number; raw: any }> {
    if (!config.delhivery.apiToken) {
      throw new Error('DELHIVERY_API_TOKEN is not configured');
    }
    const response = await withRetry(
      () =>
        this.client.get('/api/kinko/v1/invoice/charges/.json', {
          params: {
            md: params.mode,
            cgm: params.chargeableWeightGrams,
            o_pin: params.originPincode,
            d_pin: params.destinationPincode,
            ss: params.shipmentStatus,
            pt: params.paymentType,
            ...(params.paymentType === 'COD' && params.codAmount ? { cod: params.codAmount } : {}),
          },
        }),
      { attempts: 2, baseDelayMs: 2000 }
    );
    const raw = Array.isArray(response.data) ? response.data[0] : response.data;
    const total = Number(raw?.total_amount);
    if (!raw || !Number.isFinite(total) || total <= 0) {
      throw new Error('Delhivery rate API returned no amount');
    }
    return {
      total: Math.round(total * 100) / 100,
      zone: raw.zone || undefined,
      chargedWeightGrams: Number(raw.charged_weight) || undefined,
      raw,
    };
  }

  /**
   * Helper to estimate Delhivery logistics charges for a given order.
   * Uses warehouse origin pincode and customer destination pincode.
   */
  async calculateOrderLogisticCharges(
    order: Order,
    weightGrams: number = 500
  ): Promise<any> {
    const originPincode = config.delhivery.seller.pincode;
    const destinationPincode = order.customerPincode;
    const paymentType = order.paymentMethod === 'COD' ? 'COD' : 'Pre-paid';
    const mode = (config.delhivery.shippingMode === 'Express' ? 'E' : 'S') as 'E' | 'S';

    return this.calculateShippingCost({
      mode,
      chargeableWeightGrams: weightGrams,
      originPincode,
      destinationPincode,
      shipmentStatus: 'Delivered',
      paymentType,
      codAmount: order.paymentMethod === 'COD' ? order.totalAmount : 0,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 9. GENERATE SHIPPING LABEL
  // ═══════════════════════════════════════════════════════════

  /**
   * Generate a shipping label PDF for a waybill.
   * GET /api/p/packing_slip?wbns={waybill}&pdf=true&pdf_size={size}
   *
   * pdf_size: 'A4' (8x11) or '4R' (4x6 inch)
   * Returns: S3 URL of the PDF
   */
  async generateLabel(waybillNumber: string): Promise<string> {
    // Try the canonical /api/p/packing_slip endpoint first.
    // Delhivery's response shape varies by account type:
    //   { packages: [{ pdf_download_link }] } — most common
    //   { packages: [{ pdf_url }] } — newer accounts
    //   { label_url, label_pdf } — old API
    // We pull from every shape we know about before declaring failure.
    const candidateUrls: Array<string | undefined> = [];

    try {
      const response = await this.client.get('/api/p/packing_slip', {
        params: {
          wbns: waybillNumber,
          pdf: true,
          pdf_size: config.delhivery.labelSize,
        },
      });

      const rawData = response.data;
      const pkg = Array.isArray(rawData?.packages) ? rawData.packages[0] : null;

      candidateUrls.push(
        pkg?.pdf_download_link,
        pkg?.pdf_url,
        rawData?.pdf_download_link,
        rawData?.pdf_url,
        rawData?.url,
        pkg?.label_url,
        rawData?.label_url,
        typeof rawData === 'string' && rawData.startsWith('http') ? rawData : undefined
      );
    } catch (err: any) {
      logger.warn('generateLabel: /api/p/packing_slip failed', {
        waybillNumber,
        error: err.message,
        status: err.response?.status,
      });
      // Fall through to the tracking-API fallback below.
    }

    // If we didn't get a usable URL from /api/p/packing_slip, fall back to the
    // tracking API which returns the raw ShipmentData[0].Shipment. PDFs are
    // occasionally keyed off the shipping label URL that some Delhivery
    // accounts include inline. This recovers shipments where the packing-slip
    // endpoint returned empty.
    if (!candidateUrls.some((u) => u && u.startsWith('http'))) {
      try {
        const trackingResponse = await this.client.get('/api/v1/packages/json/', {
          params: { waybill: waybillNumber },
        });
        const shipment: any = trackingResponse.data?.ShipmentData?.[0]?.Shipment;
        if (shipment) {
          candidateUrls.push(
            shipment.PDF_URL,
            shipment.PDFUrl,
            shipment.label_url,
            shipment.LabelURL,
            shipment.label,
            shipment.shipping_label_url
          );
        }
      } catch (err: any) {
        logger.warn('generateLabel: tracking-API fallback failed', {
          waybillNumber,
          error: err.message,
        });
      }
    }

    const labelUrl = candidateUrls.find((u): u is string => isUsableHttpUrl(u));

    if (!labelUrl) {
      logger.error('generateLabel: no usable PDF URL found for waybill', {
        waybillNumber,
        attemptedCandidates: candidateUrls.filter(Boolean).length,
        labelSize: config.delhivery.labelSize,
      });
      return '';
    }

    logger.info('generateLabel: shipping label URL resolved', {
      waybillNumber,
      url: labelUrl.slice(0, 80) + (labelUrl.length > 80 ? '...' : ''),
    });
    return labelUrl;
  }

  // ═══════════════════════════════════════════════════════════
  // 10. PICKUP REQUEST CREATION
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a pickup request for the warehouse location.
   * POST /fm/request/new/
   *
   * Note: Pickup is against the warehouse location, not waybill numbers.
   * If shipments are at one location, one pickup request covers all.
   * Optional — auto-pickup can be enabled with Delhivery POC.
   */
  async requestPickup(
    pickupDate?: string,
    pickupTime?: string,
    packageCount: number = 1,
    pickupLocation?: string
  ): Promise<{ success: boolean; message: string; data?: any; pickupId?: string | null; alreadyOpen?: boolean; uncertain?: boolean }> {
    const location = pickupLocation || config.delhivery.pickupLocation;
    const date = pickupDate || new Date().toISOString().split('T')[0];
    const time = pickupTime || config.delhivery.pickupTime;

    const payload = {
      pickup_time: time,
      pickup_date: date,
      pickup_location: location,
      expected_package_count: packageCount,
    };

    try {
      const response = await this.client.post('/fm/request/new/', payload);
      const pickupId = readPickupId(response.data);
      const rejected = response.data?.success === false || response.data?.status === false || Boolean(response.data?.error);
      if (rejected || !pickupId) {
        const message = String(response.data?.error || response.data?.rmk || response.data?.message || 'Pickup response did not contain a confirmed pickup ID. Review Delhivery ONE before retrying.');
        return { success: false, uncertain: !rejected, alreadyOpen: rejected && isExistingPickupError(message), pickupId: null, message, data: response.data };
      }
      logger.info('Pickup request created on Delhivery', {
        date,
        time,
        location,
        packageCount,
        pickupId,
        data: response.data,
      });
      return {
        success: true,
        pickupId,
        alreadyOpen: false,
        message: `Pickup scheduled for ${location} on ${date} at ${time} (${packageCount} packages)${pickupId ? `. Pickup id ${pickupId}` : ''}.`,
        data: response.data,
      };
    } catch (error: any) {
      const errData = error.response?.data;
      let errMsg = 'Failed to schedule Delhivery pickup.';
      if (typeof errData === 'object' && errData !== null) {
        if (errData.prepaid) {
          errMsg = `Delhivery wallet balance alert: ${errData.prepaid}. Please recharge your Delhivery ONE wallet to enable scheduled carrier pickups.`;
        } else if (errData.rmk) {
          errMsg = errData.rmk;
        } else {
          errMsg = JSON.stringify(errData);
        }
      } else if (error.message) {
        errMsg = error.message;
      }

      const alreadyOpen = isExistingPickupError(errMsg);
      logger.warn('Failed to create pickup request on Delhivery', { error: errMsg, alreadyOpen, payload });
      return {
        success: false,
        alreadyOpen,
        uncertain: !error.response || error.response.status >= 500,
        pickupId: readPickupId(errData),
        message: alreadyOpen
          ? `Another pickup is open for ${location}. The requested date ${date} is not confirmed; retry after that pickup completes.`
          : errMsg,
        data: errData,
      };
    }
  }

  /**
   * Compatibility entry point for the durable next-day pickup batch worker.
   */
  async ensureDailyWarehousePickup() {
    const { processPickupBatches } = await import('./pickup-batch.service');
    return processPickupBatches();
  }

  // ═══════════════════════════════════════════════════════════
  // 10b. CLIENT WAREHOUSE CREATION / UPDATION (portal tabs 3-4)
  // ═══════════════════════════════════════════════════════════

  /**
   * Register a pickup warehouse in Delhivery's system.
   * POST /api/backend/clientwarehouse/create/
   *
   * Optional one-time activity (FMS team can do it manually), but required
   * before manifesting with a new pickup_location name — otherwise manifestation
   * fails with "ClientWarehouse matching query doesn't exist".
   * Only the documented keys are sent; random extra keys are rejected by Delhivery.
   */
  async createWarehouse(input: {
    name: string;
    phone: string;
    city: string;
    pin: string;
    address: string;
    email: string;
    registeredName?: string;
    returnAddress?: string;
    returnPin?: string;
    returnCity?: string;
    returnState?: string;
    returnCountry?: string;
    country?: string;
  }): Promise<any> {
    const payload: Record<string, unknown> = {
      name: input.name,
      phone: input.phone,
      city: input.city,
      pin: input.pin,
      address: input.address,
      country: input.country || 'India',
      email: input.email,
      registered_name: input.registeredName || input.name,
      return_address: input.returnAddress || input.address,
      return_pin: input.returnPin || input.pin,
      return_city: input.returnCity || input.city,
      return_state: input.returnState || '',
      return_country: input.returnCountry || 'India',
    };
    try {
      const response = await withRetry(
        () => this.client.post('/api/backend/clientwarehouse/create/', payload),
        { attempts: 2, baseDelayMs: 500 }
      );
      logger.info('Delhivery warehouse created', { name: input.name });
      return response.data;
    } catch (error: any) {
      logger.error('Failed to create Delhivery warehouse', {
        name: input.name,
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  /**
   * Update an existing warehouse (e.g. phone/address changed).
   * POST /api/backend/clientwarehouse/edit/
   */
  async updateWarehouse(
    name: string,
    updates: Partial<{
      phone: string;
      city: string;
      pin: string;
      address: string;
      email: string;
      returnAddress: string;
      returnPin: string;
      returnCity: string;
      returnState: string;
    }>
  ): Promise<any> {
    const keyMap: Record<string, string> = {
      phone: 'phone',
      city: 'city',
      pin: 'pin',
      address: 'address',
      email: 'email',
      returnAddress: 'return_address',
      returnPin: 'return_pin',
      returnCity: 'return_city',
      returnState: 'return_state',
    };
    const payload: Record<string, unknown> = { name };
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && keyMap[k]) payload[keyMap[k]] = v;
    }
    try {
      const response = await withRetry(
        () => this.client.post('/api/backend/clientwarehouse/edit/', payload),
        { attempts: 2, baseDelayMs: 500 }
      );
      logger.info('Delhivery warehouse updated', { name });
      return response.data;
    } catch (error: any) {
      logger.error('Failed to update Delhivery warehouse', {
        name,
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 11. SHIPMENT CANCELLATION
  // ═══════════════════════════════════════════════════════════

  /**
   * Cancel a shipment on Delhivery.
   * POST /api/p/edit
   * Body: { "waybill": "xxx", "cancellation": "true" }
   *
   * Allowed statuses for cancellation:
   *   Forward (COD/Prepaid): Manifested, In Transit, Pending
   *   RVP (Pickup): Scheduled
   *   REPL: Manifested, In Transit, Pending
   */
  async cancelShipment(waybillNumber: string): Promise<boolean> {
    try {
      await this.client.post('/api/p/edit', {
        waybill: waybillNumber,
        cancellation: 'true',
      });
      logger.info('Shipment cancelled on Delhivery', { waybillNumber });
      return true;
    } catch (error: any) {
      logger.error('Failed to cancel Delhivery shipment', {
        waybillNumber,
        error: error.response?.data || error.message,
      });
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 12. NDR (Non-Delivery Report) ACTION
  // ═══════════════════════════════════════════════════════════

  /**
   * Take action on an NDR (failed delivery) shipment.
   * POST /api/p/update (asynchronous — returns UPL id, check via getNDRStatus).
   *
   * Actions (portal tab 11):
   *   RE-ATTEMPT: re-attempt as per NDR instructions (pending + NSL EOD-74/15/104/43/86/11/16/69/6, ST-108)
   *   PICKUP_RESCHEDULE: reschedule pickup (NSL EOD-777, EOD-21)
   *   DEFER_DLV: defer delivery to deferred_date (YYYY-MM-DD, max +6 days from first
   *     pending date; NSL EOD-74/15/11/3/16/6, ST-108 — read StatusCode from tracking)
   *   EDIT_DETAILS: correct name/phone/address while package is pending
   */
  async ndrAction(
    waybillNumber: string,
    action: 'RE-ATTEMPT' | 'PICKUP_RESCHEDULE' | 'DEFER_DLV' | 'EDIT_DETAILS',
    options?: {
      deferredDate?: string;
      name?: string;
      phone?: string;
      address?: string;
    }
  ): Promise<{ uplId?: string; success: boolean; message?: string }> {
    const entry: Record<string, unknown> = { waybill: waybillNumber, act: action };

    if (action === 'DEFER_DLV') {
      const date = (options?.deferredDate || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { success: false, message: 'deferredDate must be YYYY-MM-DD.' };
      }
      const target = new Date(`${date}T00:00:00`);
      const maxAllowed = new Date();
      maxAllowed.setDate(maxAllowed.getDate() + 6);
      maxAllowed.setHours(23, 59, 59, 999);
      if (Number.isNaN(target.getTime()) || target > maxAllowed) {
        return {
          success: false,
          message: 'deferredDate must be a valid date no more than 6 days out (Delhivery rule).',
        };
      }
      entry.deferred_date = date;
    }

    if (action === 'EDIT_DETAILS') {
      if (options?.name) entry.name = options.name;
      if (options?.phone) entry.phone = options.phone;
      if (options?.address) entry.add = options.address;
      if (!entry.name && !entry.phone && !entry.add) {
        return {
          success: false,
          message: 'EDIT_DETAILS needs at least one of name, phone, address.',
        };
      }
    }

    try {
      const response = await withRetry(
        () =>
          this.client.post('/api/p/update', {
            data: [entry],
          }),
        { attempts: 2, baseDelayMs: 500 }
      );

      const uplId =
        response.data?.upl_id ||
        response.data?.data?.upl_id ||
        response.data?.uplId ||
        response.data?.data?.uplId;
      logger.info('NDR action submitted', { waybillNumber, action, uplId });
      return { uplId, success: true };
    } catch (error: any) {
      logger.error('NDR action failed', {
        waybillNumber,
        action,
        error: error.response?.data || error.message,
      });
      return { success: false };
    }
  }

  /**
   * Check the status of an NDR action request.
   * GET /api/cmu/get_bulk_upl/{uplId}?verbose=true
   */
  async getNDRStatus(uplId: string): Promise<any> {
    try {
      const response = await this.client.get(`/api/cmu/get_bulk_upl/${uplId}`, {
        params: { verbose: true },
      });
      return response.data;
    } catch (error: any) {
      logger.error('Failed to get NDR status', { uplId, error: error.message });
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 13. DOCUMENT DOWNLOAD
  // ═══════════════════════════════════════════════════════════

  /**
   * Download documents associated with a shipment.
   * GET /api/rest/fetch/pkg/document/?doc_type={type}&waybill={waybill}
   *
   * Document types:
   *   SIGNATURE_URL:      Customer signature proof
   *   RVP_QC_IMAGE:       QC images from reverse pickup
   *   EPOD:               Electronic Proof of Delivery
   *   SELLER_RETURN_IMAGE: Return item images
   */
  async downloadDocument(
    waybillNumber: string,
    docType: 'SIGNATURE_URL' | 'RVP_QC_IMAGE' | 'EPOD' | 'SELLER_RETURN_IMAGE'
  ): Promise<any> {
    try {
      const response = await this.client.get('/api/rest/fetch/pkg/document/', {
        params: {
          doc_type: docType,
          waybill: waybillNumber,
        },
      });
      logger.info('Document downloaded', { waybillNumber, docType });
      return response.data;
    } catch (error: any) {
      logger.error('Failed to download document', {
        waybillNumber,
        docType,
        error: error.message,
      });
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // STATUS MAPPING
  // ═══════════════════════════════════════════════════════════

  /**
   * Map Delhivery status_type + status to our internal ShipmentStatus enum.
   *
   * Delhivery status types:
   *   UD = Undelivered (Manifested, Not Picked, In Transit, Pending, Dispatched)
   *   DL = Delivered (Delivered, RTO, DTO)
   *   RT = Return (In Transit, Pending, Dispatched)
   *   PP = Pickup Planned (Open, Scheduled, Dispatched) — for reverse pickups
   *   PU = Picked Up (In Transit, Pending, Dispatched) — for reverse pickups
   *   CN = Canceled (Canceled, Closed)
   */
  mapTrackingToShipmentStatus(
    statusType: string,
    status: string,
    pickupDone?: boolean,
    remarks?: string
  ): 'PICKED_UP' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'FAILED' | 'RTO' | 'RTO_DELIVERED' | 'CANCELLED' | 'CREATED' {
    const st = (statusType || '').toUpperCase();
    const s = (status || '').toUpperCase();
    const hint = `${s} ${(remarks || '').toUpperCase()}`;

    // Delivered — match the status token, not the remarks, so "Delivered to consignee"
    // instructions cannot hide a real DL/Delivered scan.
    if (st === 'DL' && (s === 'DELIVERED' || s.startsWith('DELIVERED'))) return 'DELIVERED';
    if (st === 'DL' && (s === 'RTO' || s.startsWith('RTO'))) return 'RTO_DELIVERED';
    if (st === 'DL' && (s === 'DTO' || s.startsWith('DTO'))) return 'DELIVERED';

    // Return to origin
    if (st === 'RT') return 'RTO';

    // Canceled
    if (st === 'CN') return 'CANCELLED';

    // NDR / failed attempt. Delhivery often leaves Status="Pending" and puts the
    // reason in Instructions ("Consignee unavailable"). Those must not stay In Transit.
    if (
      st !== 'DL' &&
      /CONSIGNEE|UNDELIVER|DELIVERY FAILED|NOT DELIVERED|CUSTOMER NOT AVAILABLE|ADDRESS INCOMPLETE|DELIVERY ATTEMPT FAILED|REFUSED/.test(
        hint
      )
    ) {
      return 'FAILED';
    }

    // Out for delivery and linehaul must win over pickup signals. Live tracking
    // sets pickupDone=true as soon as any scan mentions "in transit", which used
    // to collapse every later scan back to PICKED_UP and fight the scan webhook.
    if (s === 'DISPATCHED' || s.includes('OUT FOR DELIVERY')) return 'OUT_FOR_DELIVERY';
    if (s === 'IN TRANSIT' || s.includes('IN TRANSIT')) return 'IN_TRANSIT';

    if (
      s.includes('PICKED UP') ||
      s.includes('PICKUP DONE') ||
      s.includes('PICKEDUP') ||
      s.includes('RECEIVED AT')
    ) {
      return 'PICKED_UP';
    }

    // Hub arrival after pickup is linehaul, not "still at the warehouse".
    if (s.includes('REACHED')) return 'IN_TRANSIT';

    // pickupDone only promotes a still-manifested parcel once Delhivery confirms
    // the courier actually collected it (PickedupDate / DispatchCount).
    const awaitingPickup =
      !s ||
      s === 'MANIFESTED' ||
      s.includes('MANIFEST') ||
      s.includes('NOT PICK') ||
      s === 'OPEN' ||
      s === 'SCHEDULED';
    if (pickupDone === true && awaitingPickup) return 'PICKED_UP';

    // Picked up (PU = reverse pickup in transit)
    if (st === 'PU') return 'IN_TRANSIT';

    // Pickup planned (PP = reverse pickup scheduled)
    if (st === 'PP') return 'CREATED';

    // Manifested / manifest uploaded = label generated, awaiting courier pickup
    if (s === 'MANIFESTED' || s.includes('MANIFEST')) return 'CREATED';

    // Not Picked = courier hasn't reached warehouse yet — still awaiting pickup,
    // NOT a failed delivery. (Previously mapped to FAILED, which wrongly moved
    // Ready-to-ship orders into exception state.)
    if (s.includes('NOT PICK')) return 'CREATED';

    // Pending = at destination hub, waiting for dispatch (NDR reasons already returned FAILED)
    if (s === 'PENDING') return 'IN_TRANSIT';

    // Default
    return 'IN_TRANSIT';
  }
}

export default new DelhiveryService();
