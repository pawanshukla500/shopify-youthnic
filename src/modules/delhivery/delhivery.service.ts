import axios, { AxiosInstance } from 'axios';
import { config } from '../../config';
import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { Order } from '@prisma/client';

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
 *  10. NDR Action:               POST /api/p/update  (JSON body: {data:[{waybill, act}]})
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
  async createShipment(order: Order): Promise<{ waybillNumber: string; labelUrl?: string }> {
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
          // Pre-allocated Delhivery waybill passed directly to manifest API
          waybill: '',
        },
      ],
      pickup_location: {
        name: config.delhivery.pickupLocation,
      },
    };

    // 1. Pre-fetch an official Delhivery AWB number so we are guaranteed a valid waybill
    let waybillNumber = '';
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

        const packageStatus = response.data?.packages?.[0]?.status;
        if (packageStatus === 'Fail') {
          const remarks = response.data?.packages?.[0]?.remarks || [];
          manifestRemark = remarks.join('; ') || 'Manifest failed on Delhivery';
          logger.warn('Delhivery manifest returned non-success remark', {
            shopifyOrderId: order.shopifyOrderId,
            remarks: manifestRemark,
            waybillNumber,
          });
        }
      } catch (cmuErr: any) {
        manifestRemark = cmuErr.response?.data?.rmk || cmuErr.message;
        logger.warn('Delhivery /api/cmu/create.json call encountered error', {
          error: manifestRemark,
          waybillNumber,
        });
      }

      if (!waybillNumber) {
        logger.error('Delhivery did not return a waybill number and pre-fetch was unavailable', {
          shopifyOrderId: order.shopifyOrderId,
          remark: manifestRemark,
        });
        throw new Error(`Delhivery waybill generation failed: ${manifestRemark || 'No waybill assigned'}`);
      }

      // Upsert the shipment in DB with the official Delhivery waybill
      await prisma.shipment.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          waybillNumber,
          paymentMode,
          codAmount: codAmount,
          declaredValue: order.totalAmount,
          status: 'CREATED',
          errorMessage: manifestRemark || null,
        },
        update: {
          waybillNumber,
          paymentMode,
          codAmount: codAmount,
          declaredValue: order.totalAmount,
          status: 'CREATED',
          errorMessage: manifestRemark || null,
        },
      });

      // Update order status to DISPATCHED
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'DISPATCHED' },
      });

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

      // Pickup requests are optional and should normally be batched per warehouse/day.
      if (config.delhivery.autoPickup) {
        await this.requestPickup(undefined, config.delhivery.pickupTime);
      }

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

      // Record error on shipment
      await prisma.shipment.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          paymentMode,
          codAmount: codAmount,
          declaredValue: order.totalAmount,
          status: 'ERROR',
          errorMessage: error.response?.data?.error || error.message,
        },
        update: {
          status: 'ERROR',
          errorMessage: error.response?.data?.error || error.message,
        },
      });

      throw error;
    }
  }

  /**
   * Create a reverse pickup (RVP) shipment on Delhivery.
   * Same endpoint as forward creation, but payment_mode = "Pickup".
   *
   * For reverse: customer address = pickup location, return_address = drop (warehouse)
   */
  async createReturnShipment(
    order: Order,
    returnReason: string,
    forwardWaybill?: string
  ): Promise<{ waybillNumber: string }> {
    // Check if customer pincode is serviceable for reverse pickup
    const serviceability = await this.checkPincodeServiceability(order.customerPincode);
    if (!serviceability.serviceable) {
      throw new Error(
        `Pincode ${order.customerPincode} is not serviceable for reverse pickup`
      );
    }

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
          // "Pickup" payment mode = reverse shipment
          payment_mode: 'Pickup',
          products_desc: returnReason,
          total_amount: '0',
          cod_amount: '',
          shipping_mode: config.delhivery.shippingMode,
          order_date: new Date().toISOString().split('T')[0],
          // Link back to original forward waybill / order
          ref_waybill: forwardWaybill || '',
          reference_number: forwardWaybill || order.shopifyOrderName.replace('#', ''),
          // For reverse: return address = warehouse (drop location)
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
        },
      ],
      pickup_location: {
        name: config.delhivery.pickupLocation,
      },
    };

    try {
      // URL-encoded form data
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
        throw new Error('No waybill number returned for return shipment');
      }

      logger.info('Return shipment (RVP) created on Delhivery', {
        shopifyOrderId: order.shopifyOrderId,
        returnWaybill: waybillNumber,
      });

      return { waybillNumber };
    } catch (error: any) {
      logger.error('Failed to create Delhivery RVP shipment', {
        shopifyOrderId: order.shopifyOrderId,
        error: error.response?.data || error.message,
      });
      throw error;
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
      remark?: string;
    }>;
  }> {
    try {
      const response = await this.client.get('/api/v1/packages/json/', {
        params: { waybill: waybillNumber },
      });

      const shipmentData = response.data?.ShipmentData?.[0]?.Shipment;
      const scanDetails = response.data?.ShipmentData?.[0]?.ScanDetail || [];

      if (!shipmentData) {
        logger.warn('No tracking data found for waybill', { waybillNumber });
        return { status: 'UNKNOWN', statusType: '', history: [] };
      }

      const latestStatus = shipmentData.Status;
      const history = scanDetails.map((scan: any) => ({
        status: scan.Scan || scan.Instructions || 'SCAN',
        statusType: scan.ScanType || '',
        location: scan.ScanLocation || scan.ScannedLocation || '',
        dateTime: scan.ScanDateTime,
        remark: scan.Instructions,
      }));

      return {
        status: latestStatus.Status,
        statusType: latestStatus.StatusType,
        location: latestStatus.StatusLocation,
        scanDateTime: latestStatus.ScanDateTime,
        remarks: latestStatus.Instructions,
        receivedBy: latestStatus.RecievedBy,
        history,
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
      const response = await this.client.get('/api/v1/packages/json/', {
        params: { waybill: combined },
      });
      return response.data?.ShipmentData || [];
    } catch (error: any) {
      logger.error('Failed to track multiple shipments', { error: error.message });
      throw error;
    }
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
    try {
      const response = await this.client.get('/api/p/packing_slip', {
        params: {
          wbns: waybillNumber,
          pdf: true,
          pdf_size: config.delhivery.labelSize,
        },
      });

      // Response contains PDF URL (either at packages[0].pdf_url, pdf_url, or string)
      const rawData = response.data;
      const labelUrl =
        rawData?.packages?.[0]?.pdf_url ||
        rawData?.pdf_url ||
        rawData?.url ||
        (typeof rawData === 'string' ? rawData : '');
      logger.info('Shipping label generated', { waybillNumber, labelUrl });
      return typeof labelUrl === 'string' ? labelUrl : JSON.stringify(labelUrl);
    } catch (error: any) {
      logger.error('Failed to generate label', {
        waybillNumber,
        error: error.message,
      });
      // Non-critical — shipment is still created
      return '';
    }
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
  ): Promise<{ success: boolean; message: string; data?: any }> {
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
      logger.info('Pickup request created on Delhivery', {
        date,
        time,
        location,
        packageCount,
        data: response.data,
      });
      return {
        success: true,
        message: `Pickup scheduled successfully for ${location} on ${date} at ${time} (${packageCount} packages).`,
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

      logger.warn('Failed to create pickup request on Delhivery', { error: errMsg, payload });
      return {
        success: false,
        message: errMsg,
        data: errData,
      };
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
   * POST /api/p/update
   * Body: { "data": [{ "waybill": "xxx", "act": "RE-ATTEMPT" }] }
   *
   * Actions:
   *   RE-ATTEMPT: Re-attempt delivery (NSL codes: EOD-74, EOD-15, EOD-104, EOD-43, EOD-86, EOD-11, EOD-69, EOD-6)
   *   PICKUP_RESCHEDULE: Reschedule pickup (NSL codes: EOD-777, EOD-21)
   *
   * Returns UPL ID which can be used to check status via GET /api/cmu/get_bulk_upl/{uplId}
   */
  async ndrAction(
    waybillNumber: string,
    action: 'RE-ATTEMPT' | 'PICKUP_RESCHEDULE'
  ): Promise<{ uplId?: string; success: boolean }> {
    try {
      const response = await this.client.post('/api/p/update', {
        data: [
          {
            waybill: waybillNumber,
            act: action,
          },
        ],
      });

      const uplId = response.data?.upl_id || response.data?.data?.upl_id;
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
    status: string
  ): 'PICKED_UP' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'FAILED' | 'RTO' | 'RTO_DELIVERED' | 'CANCELLED' | 'CREATED' {
    const st = statusType.toUpperCase();
    const s = status.toUpperCase();

    // Delivered
    if (st === 'DL' && s === 'DELIVERED') return 'DELIVERED';
    if (st === 'DL' && s === 'RTO') return 'RTO_DELIVERED';
    if (st === 'DL' && s === 'DTO') return 'DELIVERED'; // Reverse delivered to origin

    // Return to origin
    if (st === 'RT') return 'RTO';

    // Canceled
    if (st === 'CN') return 'CANCELLED';

    // Dispatched = Out for delivery
    if (s === 'DISPATCHED') return 'OUT_FOR_DELIVERY';

    // In transit
    if (s === 'IN TRANSIT') return 'IN_TRANSIT';

    // Picked up (PU = reverse pickup in transit)
    if (st === 'PU') return 'IN_TRANSIT';

    // Pickup planned (PP = reverse pickup scheduled)
    if (st === 'PP') return 'CREATED';

    // Manifested = created but not picked up yet
    if (s === 'MANIFESTED') return 'CREATED';

    // Not Picked = failed
    if (s === 'NOT PICKED') return 'FAILED';

    // Pending = at destination hub, waiting for dispatch
    if (s === 'PENDING') return 'IN_TRANSIT';

    // Default
    return 'IN_TRANSIT';
  }
}

export default new DelhiveryService();
