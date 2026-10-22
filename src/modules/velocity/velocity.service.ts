import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { config } from '../../config';
import logger from '../../utils/logger';
import prisma from '../../database/prisma';
import { Order, OrderItem, ShipmentStatus } from '@prisma/client';
import { isPrepaidOrder } from '../orders/order-tabs';

export interface VelocityServiceabilityParams {
  fromPincode: string;
  toPincode: string;
  paymentMode: 'cod' | 'prepaid';
  shipmentType?: 'forward' | 'return';
}

export interface VelocityCourierOption {
  carrier_id: string;
  carrier_name: string;
  min_weight?: number;
  max_weight?: number;
  price?: number;
  expected_delivery_days?: number;
  zone?: string;
  cod_available?: boolean;
}

export interface VelocityServiceabilityResult {
  serviceable: boolean;
  zone?: string;
  couriers: VelocityCourierOption[];
  remark?: string;
  raw?: any;
}

export interface VelocityForwardOrderOptions {
  warehouseId?: string;
  pickupLocation?: string;
  carrierId?: string;
  length?: number;
  breadth?: number;
  height?: number;
  weight?: number;
}

export interface VelocityForwardShipmentResult {
  orderId: string;
  shipmentId: string;
  awbCode: string;
  courierName: string;
  courierCompanyId?: string;
  labelUrl: string;
  assignedDateTime?: string;
  charges?: any;
  raw?: any;
}

export interface VelocityTrackingActivity {
  date: string;
  activity: string;
  location?: string;
}

export interface VelocityTrackingResult {
  awb: string;
  shipmentStatus: string;
  currentStatus: string;
  trackStatus?: string | null;
  trackUrl?: string;
  destination?: string;
  origin?: string;
  consigneeName?: string;
  pickupDate?: string;
  deliveredDate?: string;
  activities: VelocityTrackingActivity[];
  raw?: any;
}

export interface VelocityRatesParams {
  originPincode: string;
  destinationPincode: string;
  deadWeightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  paymentMethod: 'cod' | 'prepaid';
  shipmentValue?: number;
  journeyType?: 'forward' | 'return';
  qcApplicable?: boolean;
}

export interface VelocityReverseShipmentParams {
  orderId: string;
  orderDate?: string;
  carrierId?: string;
  pickupCustomerName: string;
  pickupLastName?: string;
  pickupAddress: string;
  pickupAddress2?: string;
  pickupCity: string;
  pickupState: string;
  pickupCountry?: string;
  pickupPincode: string;
  pickupPhone: string;
  pickupEmail?: string;
  shippingCustomerName?: string;
  shippingAddress?: string;
  shippingCity?: string;
  shippingState?: string;
  shippingPincode?: string;
  shippingPhone?: string;
  warehouseId?: string;
  items: Array<{
    name: string;
    sku: string;
    units: number;
    selling_price: number;
    discount?: number;
    qc_enable?: boolean;
    qc_product_name?: string;
    qc_product_image?: string;
  }>;
  totalAmount: number;
  length?: number;
  breadth?: number;
  height?: number;
  weight?: number;
}

export interface VelocityShippingChargeItem {
  eventType: string;
  transactionType: string;
  amountWithoutGst: number;
  amountWithGst: number;
}

export interface VelocityShippingChargeEntry {
  trackingNumber: string;
  charges?: VelocityShippingChargeItem[];
  error?: string;
}

export interface VelocityCodRemittanceEntry {
  trackingNumber: string;
  deliveryDate?: string | null;
  codAmount?: number;
  remittanceDate?: string | null;
  utrNo?: string | null;
  error?: string;
}

/**
 * Velocity Shipping API Client & Integration Service
 * Base URL: https://shazam.velocity.in
 *
 * Provides full integration with Velocity Shipping:
 * - Serviceability checking
 * - Forward order orchestration (creates order, assigns best courier, manifests, generates AWB & label)
 * - Order tracking (single & bulk)
 * - Shipment cancellation
 * - Reverse pickup order orchestration
 * - Shipping rate calculation
 * - Webhook HMAC verification
 */
export class VelocityService {
  private client: AxiosInstance;

  constructor() {
    const createFn = typeof (axios as any).create === 'function'
      ? (axios as any).create.bind(axios)
      : () => ({
          get: (url: string, c: any) => (axios as any).get?.(url, c),
          post: (url: string, d: any, c: any) => (axios as any).post?.(url, d, c),
          interceptors: { request: { use: () => {} }, response: { use: () => {} } },
          defaults: { headers: {} },
        });

    this.client = createFn({
      baseURL: config.velocity.baseUrl || 'https://shazam.velocity.in',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    if (this.client.interceptors?.request?.use) {
      this.client.interceptors.request.use((reqConfig) => {
        const token = config.velocity.apiToken;
        if (!token) {
          throw new Error(
            'VELOCITY_API_TOKEN is not configured. Add your Velocity API token in Settings or environment variables.'
          );
        }
        // Ensure Bearer prefix is handled cleanly (Velocity supports Bearer <token>)
        const authValue = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
        reqConfig.headers['Authorization'] = authValue;
        return reqConfig;
      });
    }
  }

  /**
   * Diagnostic probe for connection testing
   */
  async ping(): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const start = Date.now();
    try {
      // Probe serviceability for a default pincode pair (Surat to Mumbai)
      const res = await this.checkServiceability({
        fromPincode: config.delhivery.seller.pincode || '395002',
        toPincode: '400001',
        paymentMode: 'prepaid',
      });
      return {
        ok: res.serviceable || (res.couriers && res.couriers.length > 0) || Boolean(res.zone),
        message: res.serviceable
          ? `Connected · Serviceable (${res.couriers.length} couriers)`
          : `Connected · Zone ${res.zone || 'OK'}`,
        latencyMs: Date.now() - start,
      };
    } catch (err: any) {
      return { ok: false, message: err.message || 'Connection failed', latencyMs: Date.now() - start };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 1. PINCODE SERVICEABILITY
  // ═══════════════════════════════════════════════════════════

  /**
   * Check serviceability between origin and destination pincodes
   * POST /custom/api/v1/serviceability
   */
  async checkServiceability(params: VelocityServiceabilityParams): Promise<VelocityServiceabilityResult> {
    try {
      const response = await this.client.post('/custom/api/v1/serviceability', {
        from: params.fromPincode.trim(),
        to: params.toPincode.trim(),
        payment_mode: params.paymentMode.toLowerCase(),
        shipment_type: params.shipmentType || 'forward',
      });

      const data = response.data;
      const resObj = data?.result || data?.data || data;
      const rawCouriers = resObj?.serviceability_results || resObj?.couriers || [];
      const zone = resObj?.zone || data?.zone;
      const isExplicitlyServiceable = resObj?.serviceable === true || data?.status === 'SUCCESS' || data?.success === true;

      const couriers: VelocityCourierOption[] = (Array.isArray(rawCouriers) ? rawCouriers : []).map((c: any) => ({
        carrier_id: String(c.carrier_id ?? c.id ?? c.courier_id ?? c.code ?? '').trim(),
        carrier_name: String(c.carrier_name ?? c.name ?? c.courier_name ?? 'Velocity Partner').trim(),
        min_weight: c.min_weight != null ? Number(c.min_weight) : undefined,
        max_weight: c.max_weight != null ? Number(c.max_weight) : undefined,
        price: c.price != null ? Number(c.price) : c.freight_charge != null ? Number(c.freight_charge) : undefined,
        expected_delivery_days: c.expected_delivery_days != null ? Number(c.expected_delivery_days) : c.tat != null ? Number(c.tat) : undefined,
        zone: c.zone || zone,
        cod_available: c.cod_available !== undefined ? Boolean(c.cod_available) : params.paymentMode === 'cod',
      }));

      if (couriers.length > 0 || isExplicitlyServiceable) {
        return {
          serviceable: true,
          zone,
          couriers,
          remark: couriers.length > 0 ? 'Serviceable' : 'Pincode serviceable',
          raw: data,
        };
      }

      return {
        serviceable: false,
        couriers: [],
        remark: data?.meta?.message || data?.meta?.details || data?.message || resObj?.remark || 'Serviceability check failed',
        raw: data,
      };
    } catch (error: any) {
      logger.warn('Velocity serviceability check failed', {
        from: params.fromPincode,
        to: params.toPincode,
        error: error.response?.data || error.message,
      });
      return {
        serviceable: false,
        couriers: [],
        remark: error.response?.data?.meta?.message || error.response?.data?.meta?.details || error.response?.data?.message || error.message,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 2. FORWARD SHIPMENT CREATION (ORCHESTRATION)
  // ═══════════════════════════════════════════════════════════

  /**
   * Create and manifest forward shipment using single-step orchestration
   * POST /custom/api/v1/forward-order-orchestration
   */
  async createForwardShipment(
    order: Order & { items: OrderItem[] },
    options?: VelocityForwardOrderOptions
  ): Promise<VelocityForwardShipmentResult> {
    const isCod =
      !isPrepaidOrder(order as any) ||
      (order.paymentMethod || '').toUpperCase().includes('COD') ||
      (order.paymentMethod || '').toLowerCase().includes('cash');

    const warehouseId = options?.warehouseId || config.velocity.warehouseId || 'WHGSYR';
    const pickupLocation =
      options?.pickupLocation ||
      (config.velocity as any).pickupLocation ||
      config.delhivery.pickupLocation ||
      'Surat Warehouse';
    const storeName = config.shopify.shopDomain?.replace('.myshopify.com', '') || 'youthnic2024';

    // Split customer name into first & last name
    const rawName = (order.customerName || 'Customer').trim();
    const nameParts = rawName.split(/\s+/);
    const firstName = nameParts[0] || 'Customer';
    const lastName = nameParts.slice(1).join(' ') || '.';

    // Normalize phone (Velocity requires 10 digit Indian number)
    let phone = (order.customerPhone || '').replace(/\D/g, '');
    if (phone.length === 12 && phone.startsWith('91')) {
      phone = phone.substring(2);
    }
    if (phone.length > 10) {
      phone = phone.slice(-10);
    }
    if (phone.length < 10) {
      phone = '9999999999';
    }

    // Dimensions: default to single-piece or multi-piece settings
    const itemCount = order.items?.length || 1;
    const length = options?.length ?? (itemCount > 1 ? config.delhivery.multiItemLengthCm : config.delhivery.singleItemLengthCm);
    const breadth = options?.breadth ?? (itemCount > 1 ? config.delhivery.multiItemBreadthCm : config.delhivery.singleItemBreadthCm);
    const height = options?.height ?? (itemCount > 1 ? config.delhivery.multiItemHeightCm : config.delhivery.singleItemHeightCm);
    // Velocity weight is in KG (e.g. 0.35 or 0.4)
    const weightKg = options?.weight ?? ((itemCount > 1 ? 500 : 350) / 1000);

    // Order date in YYYY-MM-DD HH:mm format
    const now = new Date();
    const orderDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Map line items
    const orderItems = (order.items && order.items.length > 0)
      ? order.items.map((item) => ({
          name: (item.title || 'Product').substring(0, 100),
          sku: item.sku || `SKU-${item.id}`,
          units: Math.max(1, item.quantity || 1),
          selling_price: Math.max(1, Math.round(item.price || 0)),
          discount: 0,
        }))
      : [
          {
            name: order.shopifyOrderName,
            sku: `ORD-${order.id}`,
            units: 1,
            selling_price: Math.max(1, Math.round(order.totalAmount || 0)),
            discount: 0,
          },
        ];

    const customerAddress = (order.customerAddress || 'Address').substring(0, 200);
    const customerCity = order.customerCity || 'City';
    const customerState = order.customerState || 'State';
    const customerCountry = order.customerCountry || 'India';
    const customerPincode = order.customerPincode?.trim() || '000000';
    const totalAmount = Math.max(1, Math.round(order.totalAmount || 0));

    // Order ID for Velocity: Shopify orders synced into Velocity use the exact display_id (e.g. #26YOU6001).
    // Using order.shopifyOrderName directly targets and fulfills the synced Shopify order.
    const orderId = order.shopifyOrderName.startsWith('#')
      ? order.shopifyOrderName
      : `#${order.shopifyOrderName}`;

    // Payload strictly matching Velocity Forward Order Orchestration API specification.
    // NOTE: Forward orders must NOT send `pickup_customer_name` or `pickup_address`
    // (which Velocity interprets as reverse logistics / customer return pickups).
    // The pickup origin is designated by `pickup_location` and `warehouse_id`.
    const payload: any = {
      order_id: orderId,
      external_id: order.shopifyOrderId ? String(order.shopifyOrderId) : orderId,
      store_name: storeName,
      order_date: orderDateStr,
      carrier_id: options?.carrierId || '', // Empty for Velocity rule-based auto-assignment
      billing_customer_name: firstName,
      billing_last_name: lastName,
      billing_address: customerAddress,
      billing_city: customerCity,
      billing_state: customerState,
      billing_country: customerCountry,
      billing_pincode: customerPincode,
      billing_phone: phone,
      billing_email: order.customerEmail || undefined,
      shipping_is_billing: true,
      shipping_customer_name: firstName,
      shipping_last_name: lastName,
      shipping_address: customerAddress,
      shipping_city: customerCity,
      shipping_state: customerState,
      shipping_country: customerCountry,
      shipping_pincode: customerPincode,
      shipping_phone: phone,
      shipping_email: order.customerEmail || undefined,
      pickup_location: pickupLocation,
      warehouse_id: warehouseId,
      order_items: orderItems,
      payment_method: isCod ? 'COD' : 'PREPAID',
      payment_mode: isCod ? 'cod' : 'prepaid',
      cod_amount: isCod ? totalAmount : 0,
      cod_collectible: isCod ? totalAmount : 0,
      sub_total: totalAmount,
      total_discount: Math.round(order.totalDiscounts || 0),
      length,
      breadth,
      height,
      weight: weightKg,
      request_pickup: true,
      print_label: true,
    };

    logger.info('Creating Velocity forward shipment', {
      orderId: order.id,
      shopifyOrderName: order.shopifyOrderName,
      warehouseId,
      paymentMethod: payload.payment_method,
      paymentMode: payload.payment_mode,
      codAmount: payload.cod_amount,
    });

    try {
      const response = await this.client.post('/custom/api/v1/forward-order-orchestration', payload);
      const data = response.data;

      const isSuccess = data?.status === 1 || data?.status === 'SUCCESS' || data?.success === true || Boolean(data?.payload) || Boolean(data?.data);
      const p = data?.payload || data?.data || data?.result;

      if (isSuccess && p && (p.awb_code || p.awb)) {
        const awbCode = p.awb_code || p.awb;
        return {
          orderId: p.order_id || payload.order_id,
          shipmentId: String(p.shipment_id || p.order_id || ''),
          awbCode,
          courierName: p.courier_name || p.carrier_name || 'Velocity Standard',
          courierCompanyId: p.courier_company_id || p.carrier_id,
          labelUrl: p.label_url || '',
          assignedDateTime: p.assigned_date_time?.date || p.assigned_date_time,
          charges: p.charges,
          raw: data,
        };
      }

      const errMsg =
        data?.meta?.message ||
        data?.meta?.details ||
        data?.message ||
        data?.error ||
        JSON.stringify(data);
      throw new Error(`Velocity shipment creation failed: ${errMsg}`);
    } catch (error: any) {
      const respData = error.response?.data;
      const msg =
        respData?.meta?.message ||
        respData?.meta?.details ||
        respData?.message ||
        respData?.error ||
        respData?.detail ||
        (Array.isArray(respData?.errors) ? respData.errors.join(', ') : undefined) ||
        error.message;
      logger.error('Velocity forward shipment creation error', {
        orderId: order.id,
        status: error.response?.status,
        data: respData,
        error: msg,
      });
      throw new Error(`Velocity error (${error.response?.status || 500}): ${typeof msg === 'object' ? JSON.stringify(msg) : msg}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 3. TRACKING
  // ═══════════════════════════════════════════════════════════

  /**
   * Track one or more shipments by AWB
   * POST /custom/api/v1/order-tracking
   */
  async trackShipment(awb: string): Promise<VelocityTrackingResult> {
    const bulk = await this.trackShipmentsBulk([awb]);
    const res = bulk[awb];
    if (!res) {
      throw new Error(`No tracking data returned for AWB: ${awb}`);
    }
    return res;
  }

  /**
   * Bulk tracking for up to 50 AWBs
   */
  async trackShipmentsBulk(awbs: string[]): Promise<Record<string, VelocityTrackingResult>> {
    if (!awbs || awbs.length === 0) return {};

    const cleanAwbs = awbs.map((a) => a.trim()).filter(Boolean);
    const results: Record<string, VelocityTrackingResult> = {};

    try {
      const response = await this.client.post('/custom/api/v1/order-tracking', {
        awbs: cleanAwbs,
      });

      const data = response.data;
      const resultMap = data?.result || data?.data || data || {};

      for (const awb of cleanAwbs) {
        let item = resultMap[awb]?.tracking_data || resultMap[awb];
        if (!item && Array.isArray(resultMap)) {
          item = resultMap.find((entry: any) => entry.awb === awb || entry.tracking_number === awb);
        }
        if (!item) continue;

        const mainTrack = item.shipment_track?.[0] || item;
        const activities: VelocityTrackingActivity[] = (
          item.shipment_track_activities ||
          item.activities ||
          []
        ).map((act: any) => ({
          date: act.date,
          activity: act.activity,
          location: act.location,
        }));

        results[awb] = {
          awb,
          shipmentStatus: item.shipment_status || mainTrack.current_status || item.status || 'in_transit',
          currentStatus: mainTrack.current_status || item.current_status || item.shipment_status || 'in_transit',
          trackStatus: item.track_status,
          trackUrl: item.track_url,
          destination: mainTrack.destination,
          origin: mainTrack.origin,
          consigneeName: mainTrack.consignee_name,
          pickupDate: mainTrack.pickup_date,
          deliveredDate: mainTrack.delivered_date,
          activities,
          raw: item,
        };
      }

      return results;
    } catch (error: any) {
      logger.warn('Velocity tracking lookup failed', {
        awbs: cleanAwbs,
        error: error.response?.data || error.message,
      });
      throw new Error(`Velocity tracking failed: ${error.response?.data?.message || error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 4. CANCELLATION
  // ═══════════════════════════════════════════════════════════

  /**
   * Cancel shipment before pickup
   * POST /custom/api/v1/cancel-order
   */
  async cancelShipment(awb: string, _reason?: string): Promise<{ success: boolean; cancelled: boolean; message: string }> {
    try {
      const cleanAwb = awb.trim();
      const response = await this.client.post('/custom/api/v1/cancel-order', {
        awb: cleanAwb,
        awbs: [cleanAwb],
      });

      const data = response.data;
      const isSuccess =
        data?.status === 'SUCCESS' ||
        data?.status === 1 ||
        data?.success === true ||
        (response.status >= 200 && response.status < 300 && !data?.error);

      return {
        success: Boolean(isSuccess),
        cancelled: Boolean(isSuccess),
        message: data?.message || (isSuccess ? 'Cancellation request accepted' : 'Cancellation could not be completed'),
      };
    } catch (error: any) {
      const respData = error.response?.data;
      const msg = respData?.meta?.message || respData?.meta?.details || respData?.message || error.message;
      logger.warn('Velocity cancellation failed', { awb, error: msg });
      return { success: false, cancelled: false, message: typeof msg === 'object' ? JSON.stringify(msg) : msg };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 5. REVERSE PICKUP SHIPMENT
  // ═══════════════════════════════════════════════════════════

  /**
   * Creates and manifests reverse pickup shipment
   * POST /custom/api/v1/reverse-order-orchestration
   */
  async createReverseShipment(params: VelocityReverseShipmentParams): Promise<any> {
    const warehouseId = params.warehouseId || config.velocity.warehouseId;
    if (!warehouseId) {
      throw new Error('VELOCITY_WAREHOUSE_ID is required for reverse pickup creation');
    }

    const payload = {
      order_id: params.orderId,
      order_date: params.orderDate || new Date().toISOString().slice(0, 10),
      carrier_id: params.carrierId || '',
      pickup_customer_name: params.pickupCustomerName,
      pickup_last_name: params.pickupLastName || '.',
      pickup_address: params.pickupAddress,
      pickup_address_2: params.pickupAddress2 || '',
      pickup_city: params.pickupCity,
      pickup_state: params.pickupState,
      pickup_country: params.pickupCountry || 'India',
      pickup_pincode: params.pickupPincode,
      pickup_phone: params.pickupPhone.replace(/\D/g, '').slice(-10),
      pickup_email: params.pickupEmail,
      pickup_isd_code: '91',
      shipping_customer_name: params.shippingCustomerName || config.delhivery.seller.name || 'Youthnic',
      shipping_address: params.shippingAddress || config.delhivery.seller.address || 'Surat Hub',
      shipping_city: params.shippingCity || config.delhivery.seller.city || 'Surat',
      shipping_state: params.shippingState || config.delhivery.seller.state || 'Gujarat',
      shipping_country: 'India',
      shipping_pincode: params.shippingPincode || config.delhivery.seller.pincode || '395002',
      shipping_phone: (params.shippingPhone || config.delhivery.seller.phone || '9999999999').replace(/\D/g, '').slice(-10),
      warehouse_id: warehouseId,
      order_items: params.items,
      payment_method: 'PREPAID',
      sub_total: Math.round(params.totalAmount),
      total_discount: 0,
      length: params.length || 3,
      breadth: params.breadth || 1,
      height: params.height || 1,
      weight: params.weight || 0.4,
      request_pickup: true,
    };

    try {
      const response = await this.client.post('/custom/api/v1/reverse-order-orchestration', payload);
      const data = response.data;
      const p = data?.payload || data?.data || data?.result || data;
      const awbCode = p?.awb_code || p?.awb || p?.tracking_number;
      return {
        awbCode: awbCode ? String(awbCode).trim() : '',
        shipmentId: String(p?.shipment_id || p?.order_id || ''),
        courierName: p?.courier_name || p?.carrier_name || 'Velocity Reverse',
        labelUrl: p?.label_url || '',
        raw: data,
      };
    } catch (error: any) {
      const respData = error.response?.data;
      const msg = respData?.meta?.message || respData?.meta?.details || respData?.message || error.message;
      logger.error('Velocity reverse shipment failed', { error: msg });
      throw new Error(`Velocity reverse shipment error: ${typeof msg === 'object' ? JSON.stringify(msg) : msg}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 6. RATES & PRICING
  // ═══════════════════════════════════════════════════════════

  /**
   * Get calculated shipping rates
   * POST /custom/api/v1/rates
   */
  async getRates(params: VelocityRatesParams): Promise<any> {
    const payload = {
      journey_type: params.journeyType || 'forward',
      origin_pincode: params.originPincode.trim(),
      destination_pincode: params.destinationPincode.trim(),
      dead_weight: params.deadWeightGrams,
      length: params.lengthCm,
      width: params.widthCm,
      height: params.heightCm,
      payment_method: params.paymentMethod.toLowerCase(),
      shipment_value: params.paymentMethod === 'cod' ? (params.shipmentValue || 1000) : undefined,
      qc_applicable: params.qcApplicable,
    };

    try {
      const response = await this.client.post('/custom/api/v1/rates', payload);
      return response.data;
    } catch (error: any) {
      throw new Error(`Velocity rate calculation failed: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Helper to normalize shipping rate options from Velocity Rates API
   */
  async calculateCourierRates(params: VelocityRatesParams): Promise<Array<{
    carrierId: string;
    carrierName: string;
    freightCharge: number;
    codCharge: number;
    totalCharge: number;
    expectedDeliveryDays?: number;
    zone?: string;
    raw?: any;
  }>> {
    const raw = await this.getRates(params);
    const list = Array.isArray(raw?.payload)
      ? raw.payload
      : Array.isArray(raw?.data)
      ? raw.data
      : Array.isArray(raw?.result)
      ? raw.result
      : Array.isArray(raw)
      ? raw
      : [];

    return list.map((item: any) => ({
      carrierId: String(item.carrier_id ?? item.id ?? item.courier_id ?? '').trim(),
      carrierName: String(item.carrier_name ?? item.courier_name ?? item.name ?? 'Velocity Partner').trim(),
      freightCharge: Number(item.freight_charge ?? item.freight ?? item.rate ?? item.price ?? 0),
      codCharge: Number(item.cod_charge ?? item.cod_fee ?? 0),
      totalCharge: Number(item.total_charge ?? item.total_price ?? item.total ?? item.rate ?? 0),
      expectedDeliveryDays: item.expected_delivery_days != null ? Number(item.expected_delivery_days) : undefined,
      zone: item.zone,
      raw: item,
    }));
  }

  // ═══════════════════════════════════════════════════════════
  // 7. WAREHOUSE REGISTRATION
  // ═══════════════════════════════════════════════════════════

  /**
   * Register a new pickup warehouse in Velocity
   * POST /custom/api/v1/warehouse
   */
  async createWarehouse(warehouse: {
    name: string;
    phoneNumber: string;
    email: string;
    contactPerson: string;
    streetAddress: string;
    city: string;
    state: string;
    zip: string;
    country?: string;
    gstNo?: string;
  }): Promise<{ warehouseId: string; raw: any }> {
    const payload = {
      name: warehouse.name,
      phone_number: warehouse.phoneNumber.replace(/\D/g, '').slice(-10),
      gst_no: warehouse.gstNo,
      email: warehouse.email,
      contact_person: warehouse.contactPerson,
      address_attributes: {
        street_address: warehouse.streetAddress,
        zip: warehouse.zip,
        city: warehouse.city,
        state: warehouse.state,
        country: warehouse.country || 'India',
      },
    };

    try {
      const response = await this.client.post('/custom/api/v1/warehouse', payload);
      const data = response.data;
      if (data?.status === 'SUCCESS' && data?.payload?.warehouse_id) {
        return { warehouseId: data.payload.warehouse_id, raw: data };
      }
      throw new Error(data?.message || 'Failed to create warehouse');
    } catch (error: any) {
      throw new Error(`Velocity warehouse creation failed: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * List registered warehouses
   * GET /custom/api/v1/warehouse
   */
  async listWarehouses(): Promise<any[]> {
    try {
      const response = await this.client.get('/custom/api/v1/warehouse');
      const data = response.data;
      return data?.payload?.warehouses || data?.data || (Array.isArray(data) ? data : []);
    } catch (error: any) {
      logger.warn('Failed to list Velocity warehouses', { error: error.message });
      return [];
    }
  }

  /**
   * List connected stores
   * GET /custom/api/v1/store
   */
  async listStores(): Promise<any[]> {
    try {
      const response = await this.client.get('/custom/api/v1/store');
      const data = response.data;
      return data?.payload?.stores || data?.data || (Array.isArray(data) ? data : []);
    } catch (error: any) {
      logger.warn('Failed to list Velocity stores', { error: error.message });
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 9. NDR ACTIONS (Non-Delivery Report Management)
  // ═══════════════════════════════════════════════════════════

  /**
   * Submit NDR action: Re-attempt delivery or initiate RTO
   * POST /custom/api/v1/ndr-action
   */
  async submitNdrAction(params: {
    awb: string;
    action: 'reattempt' | 'rto';
    deferredDate?: string;
    remarks?: string;
    phone?: string;
    address?: string;
  }): Promise<{ success: boolean; message: string; raw?: any }> {
    const payload = {
      awb: params.awb.trim(),
      action: params.action === 'rto' ? 'RTO' : 'REATTEMPT',
      deferred_date: params.deferredDate,
      remarks: params.remarks || (params.action === 'rto' ? 'Customer rejected delivery' : 'Customer requested reattempt'),
      shipping_phone: params.phone ? params.phone.replace(/\D/g, '').slice(-10) : undefined,
      shipping_address: params.address,
    };

    try {
      const response = await this.client.post('/custom/api/v1/ndr-action', payload);
      const data = response.data;
      return {
        success: data?.status === 'SUCCESS' || data?.success === true,
        message: data?.message || 'NDR action submitted successfully',
        raw: data,
      };
    } catch (error: any) {
      const msg = error.response?.data?.message || error.message;
      logger.error('Failed to submit Velocity NDR action', { awb: params.awb, error: msg });
      throw new Error(`Velocity NDR action failed: ${msg}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 10. UPDATE ORDER DETAILS
  // ═══════════════════════════════════════════════════════════

  /**
   * Update address, phone, or details on an active order
   * POST /custom/api/v1/update-order
   */
  async updateOrder(params: {
    orderId?: string;
    awb?: string;
    phone?: string;
    address?: string;
    city?: string;
    state?: string;
    pincode?: string;
  }): Promise<{ success: boolean; message: string; raw?: any }> {
    const payload: any = {
      order_id: params.orderId,
      awb: params.awb,
    };
    if (params.phone) payload.shipping_phone = params.phone.replace(/\D/g, '').slice(-10);
    if (params.address) payload.shipping_address = params.address;
    if (params.city) payload.shipping_city = params.city;
    if (params.state) payload.shipping_state = params.state;
    if (params.pincode) payload.shipping_pincode = params.pincode.trim();

    try {
      const response = await this.client.post('/custom/api/v1/update-order', payload);
      const data = response.data;
      return {
        success: data?.status === 'SUCCESS' || data?.success === true,
        message: data?.message || 'Order updated successfully',
        raw: data,
      };
    } catch (error: any) {
      const msg = error.response?.data?.message || error.message;
      logger.error('Failed to update Velocity order', { error: msg });
      throw new Error(`Velocity update order failed: ${msg}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 11. ORDER DETAILS (Forward & Returns)
  // ═══════════════════════════════════════════════════════════

  /**
   * Fetch full details for a forward shipment
   * GET /custom/api/v1/order-details
   */
  async getForwardOrderDetails(identifier: { orderId?: string; awb?: string }): Promise<any> {
    try {
      const response = await this.client.get('/custom/api/v1/order-details', {
        params: {
          order_id: identifier.orderId,
          awb: identifier.awb,
        },
      });
      return response.data?.payload || response.data?.data || response.data;
    } catch (error: any) {
      throw new Error(`Failed to fetch forward order details: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Fetch full details for a return / reverse shipment
   * GET /custom/api/v1/return-order-details
   */
  async getReturnOrderDetails(identifier: { orderId?: string; awb?: string }): Promise<any> {
    try {
      const response = await this.client.get('/custom/api/v1/return-order-details', {
        params: {
          order_id: identifier.orderId,
          awb: identifier.awb,
        },
      });
      return response.data?.payload || response.data?.data || response.data;
    } catch (error: any) {
      throw new Error(`Failed to fetch return order details: ${error.response?.data?.message || error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 12. EXCHANGE ORDERS
  // ═══════════════════════════════════════════════════════════

  /**
   * Create an exchange order (reverse pickup + forward delivery)
   * POST /custom/api/v1/exchange-order
   */
  async createExchangeOrder(params: {
    orderId: string;
    reverseWarehouseId?: string;
    pickupAddress: any;
    forwardItems: any[];
    returnItems: any[];
  }): Promise<any> {
    try {
      const response = await this.client.post('/custom/api/v1/exchange-order', params);
      return response.data?.payload || response.data;
    } catch (error: any) {
      throw new Error(`Failed to create exchange order: ${error.response?.data?.message || error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 13. FINANCE & REMITTANCE
  // ═══════════════════════════════════════════════════════════

  /**
   * Fetch remittance and COD payout statements
   * GET /custom/api/v1/finance/remittance
   */
  async getRemittanceDetails(params?: { startDate?: string; endDate?: string }): Promise<any> {
    try {
      const response = await this.client.get('/custom/api/v1/finance/remittance', {
        params: {
          start_date: params?.startDate,
          end_date: params?.endDate,
        },
      });
      return response.data?.payload || response.data?.data || response.data;
    } catch (error: any) {
      throw new Error(`Failed to fetch finance remittance: ${error.response?.data?.message || error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 14. REPORTS EXPORT
  // ═══════════════════════════════════════════════════════════

  /**
   * Trigger export of operational reports (orders, tracking, ndr, remittances)
   * POST /custom/api/v1/reports/export
   */
  async requestReport(reportType: 'orders' | 'tracking' | 'ndr' | 'remittance', filterParams?: any): Promise<any> {
    try {
      const response = await this.client.post('/custom/api/v1/reports/export', {
        report_type: reportType,
        ...filterParams,
      });
      return response.data?.payload || response.data;
    } catch (error: any) {
      throw new Error(`Failed to request report export: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Fetch status-based summary report for forward and return/reverse shipments
   * POST /custom/api/v1/reports
   */
  async getSummaryReport(params: {
    startDateTime: string;
    endDateTime: string;
    shipmentType?: 'forward' | 'return';
  }): Promise<{
    dateRange: { startDateTime: string; endDateTime: string };
    shipmentType: string;
    summary: Record<string, { count: number; sum_of_prepaid_orders: number; sum_of_cod_orders: number }>;
    totalShipments: number;
    raw: any;
  }> {
    try {
      const response = await this.client.post('/custom/api/v1/reports', {
        start_date_time: params.startDateTime,
        end_date_time: params.endDateTime,
        shipment_type: params.shipmentType || 'forward',
      });
      const payload = response.data?.payload || response.data;
      return {
        dateRange: {
          startDateTime: payload?.date_range?.start_date_time || params.startDateTime,
          endDateTime: payload?.date_range?.end_date_time || params.endDateTime,
        },
        shipmentType: payload?.shipment_type || params.shipmentType || 'forward',
        summary: payload?.summary || {},
        totalShipments: payload?.summary?.total_shipments || 0,
        raw: response.data,
      };
    } catch (error: any) {
      throw new Error(`Failed to fetch Velocity summary report: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Fetch shipment-level financial charges breakdown per AWB
   * POST /custom/api/v1/shipping-charges
   */
  async getShippingCharges(awbs: string[]): Promise<VelocityShippingChargeEntry[]> {
    if (!awbs || awbs.length === 0) return [];
    try {
      const response = await this.client.post('/custom/api/v1/shipping-charges', {
        awbs: awbs.slice(0, 100),
      });
      const list = response.data?.data || [];
      return list.map((item: any) => ({
        trackingNumber: item.tracking_number,
        charges: item.charges?.map((c: any) => ({
          eventType: c.event_type,
          transactionType: c.transaction_type,
          amountWithoutGst: Number(c.amount_without_gst || 0),
          amountWithGst: Number(c.amount_with_gst || 0),
        })),
        error: item.error,
      }));
    } catch (error: any) {
      throw new Error(`Failed to fetch Velocity shipping charges: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Fetch shipment-level COD remittance details per AWB
   * POST /custom/api/v1/cod-remittance
   */
  async getCodRemittance(awbs: string[]): Promise<VelocityCodRemittanceEntry[]> {
    if (!awbs || awbs.length === 0) return [];
    try {
      const response = await this.client.post('/custom/api/v1/cod-remittance', {
        awbs: awbs.slice(0, 100),
      });
      const list = response.data?.data || [];
      return list.map((item: any) => ({
        trackingNumber: item.tracking_number,
        deliveryDate: item.delivery_date,
        codAmount: item.cod_amount ? Number(item.cod_amount) : undefined,
        remittanceDate: item.remittance_date,
        utrNo: item.utr_no,
        error: item.error,
      }));
    } catch (error: any) {
      throw new Error(`Failed to fetch Velocity COD remittance: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Fetch paginated list of forward shipments with filters
   * POST /custom/api/v1/shipments
   */
  async getShipmentsList(params?: any): Promise<{
    data: any[];
    meta?: any;
    raw: any;
  }> {
    try {
      const response = await this.client.post('/custom/api/v1/shipments', params || { page: 1, per_page: 20 });
      return {
        data: response.data?.data || [],
        meta: response.data?.meta,
        raw: response.data,
      };
    } catch (error: any) {
      throw new Error(`Failed to fetch Velocity shipments list: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Fetch paginated list of return orders with filters
   * POST /custom/api/v1/returns
   */
  async getReturnsList(params?: any): Promise<{
    data: any[];
    meta?: any;
    raw: any;
  }> {
    try {
      const response = await this.client.post('/custom/api/v1/returns', params || { page: 1, per_page: 20 });
      return {
        data: response.data?.data || [],
        meta: response.data?.meta,
        raw: response.data,
      };
    } catch (error: any) {
      throw new Error(`Failed to fetch Velocity returns list: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Fetch and normalize remittance records from Velocity finance API
   */
  async fetchRemittanceRecords(params?: { startDate?: string; endDate?: string }): Promise<Array<{
    awb: string;
    orderId?: string;
    remittedAmount: number;
    codAmount: number;
    utr: string;
    remittanceRef: string;
    remittanceDate: string;
    status: string;
  }>> {
    const raw = await this.getRemittanceDetails(params);
    const list = Array.isArray(raw)
      ? raw
      : raw?.remittances || raw?.records || raw?.data || raw?.orders || [];

    return list.map((item: any) => ({
      awb: String(item.awb || item.waybill || item.tracking_number || '').trim(),
      orderId: item.order_id || item.orderId || item.client_order_id,
      remittedAmount: Number(item.remitted_amount || item.remittedAmount || item.net_amount || item.amount || 0),
      codAmount: Number(item.cod_amount || item.codAmount || item.collected_amount || 0),
      utr: String(item.bank_transaction_id || item.utr || item.bank_ref || item.reference_number || '').trim(),
      remittanceRef: String(item.crn || item.remittance_number || item.remittance_id || item.batch_id || 'VEL-REMIT').trim(),
      remittanceDate: item.remittance_date || item.processed_date || item.date || new Date().toISOString(),
      status: item.status || 'PROCESSED',
    })).filter((r: any) => Boolean(r.awb || r.orderId));
  }

  /**
   * Fetch official Velocity shipping label PDF buffer directly from Velocity API or S3 URL
   */
  async fetchOfficialLabelPdf(waybill: string, directUrl?: string | null): Promise<Buffer | null> {
    const cleanWaybill = (waybill || '').trim();
    if (!cleanWaybill) return null;

    const candidates: string[] = [];
    if (directUrl && directUrl.startsWith('http')) candidates.push(directUrl);

    // 1. Probe live order tracking which returns fresh presigned S3 label_url
    try {
      const track = await this.trackShipment(cleanWaybill);
      const trackRaw = track?.raw;
      const urlsFromTrack = [
        trackRaw?.label_url,
        trackRaw?.data?.label_url,
        trackRaw?.payload?.label_url,
        trackRaw?.shipment_track?.[0]?.label_url,
        (track as any)?.labelUrl,
      ].filter((u): u is string => Boolean(u && typeof u === 'string' && u.startsWith('http')));

      for (const u of urlsFromTrack) {
        if (!candidates.includes(u)) candidates.push(u);
      }
    } catch {
      // ignore
    }

    // 2. Probe order details
    try {
      const details = await this.getForwardOrderDetails({ awb: cleanWaybill });
      const urlsFromDetails = [
        details?.label_url,
        details?.payload?.label_url,
        details?.data?.label_url,
        details?.shipment?.label_url,
        details?.order?.label_url,
      ].filter((u): u is string => Boolean(u && typeof u === 'string' && u.startsWith('http')));

      for (const u of urlsFromDetails) {
        if (!candidates.includes(u)) candidates.push(u);
      }
    } catch {
      // ignore
    }

    // 3. Probe shipments list if candidates still empty
    if (candidates.length === 0) {
      try {
        const shipmentsRes = await this.getShipmentsList({ tracking_number: cleanWaybill, per_page: 5 });
        const items = shipmentsRes?.data || [];
        for (const item of items) {
          const u = item?.attributes?.label_url || item?.label_url;
          if (u && typeof u === 'string' && u.startsWith('http') && !candidates.includes(u)) {
            candidates.push(u);
          }
        }
      } catch {
        // ignore
      }
    }

    for (const url of candidates) {
      try {
        const res = await axios.get<ArrayBuffer>(url, {
          responseType: 'arraybuffer',
          timeout: 20000,
          headers: url.includes('shazam.velocity.in') && config.velocity.apiToken ? {
            Authorization: config.velocity.apiToken.startsWith('Bearer ')
              ? config.velocity.apiToken
              : `Bearer ${config.velocity.apiToken}`,
          } : undefined,
        });
        const buffer = Buffer.from(res.data);
        if (buffer.length > 20) {
          const head = buffer.subarray(0, 10).toString('utf8');
          if (head.includes('%PDF')) {
            // Asynchronously update shipment labelUrl in database if different
            Promise.resolve(
              prisma.shipment.updateMany({
                where: { waybillNumber: cleanWaybill },
                data: { labelUrl: url },
              })
            ).catch(() => undefined);

            return buffer;
          }
          if (head.startsWith('{')) {
            try {
              const json = JSON.parse(buffer.toString('utf8'));
              const nextUrl = json?.label_url || json?.payload?.label_url || json?.url;
              if (nextUrl && nextUrl !== url) {
                return await this.fetchOfficialLabelPdf(cleanWaybill, nextUrl);
              }
            } catch {
              // ignore
            }
          }
        }
      } catch (err: any) {
        logger.warn('Failed to stream official Velocity label candidate', { waybill: cleanWaybill, url, error: err.message });
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // 8. WEBHOOK VERIFICATION & STATUS MAPPING
  // ═══════════════════════════════════════════════════════════

  /**
   * Verify Velocity HMAC Webhook signature
   */
  verifyWebhookSignature(
    payload: string | object,
    receivedSignature: string,
    secretOverride?: string
  ): boolean {
    const secret = secretOverride || config.velocity.webhookSecret;
    if (!secret) return true; // If no secret configured, allow (open mode)
    if (!receivedSignature) return false;

    try {
      const bodyStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const computed = crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
      const sigBuf = Buffer.from(receivedSignature, 'utf8');
      const compBuf = Buffer.from(computed, 'utf8');
      if (sigBuf.length !== compBuf.length) {
        return false;
      }
      return crypto.timingSafeEqual(compBuf, sigBuf);
    } catch {
      return false;
    }
  }

  /**
   * Map Velocity shipment status to internal OMS ShipmentStatus and OrderStatus
   */
  mapTrackingToShipmentStatus(velocityStatus: string): {
    shipmentStatus: ShipmentStatus;
    orderStatus: string;
    description: string;
  } {
    const s = (velocityStatus || '').toLowerCase().trim().replace(/[\s-]+/g, '_');

    switch (s) {
      case 'pending':
        return { shipmentStatus: 'PENDING', orderStatus: 'DISPATCH_PENDING', description: 'Pending Courier Assignment' };
      case 'ready_for_pickup':
      case 'pickup_scheduled':
        return { shipmentStatus: 'CREATED', orderStatus: 'DISPATCHED', description: 'Ready for Pickup / Manifested' };
      case 'not_picked':
        return { shipmentStatus: 'CREATED', orderStatus: 'DISPATCHED', description: 'Pickup Delayed' };
      case 'in_transit':
        return { shipmentStatus: 'IN_TRANSIT', orderStatus: 'IN_TRANSIT', description: 'In Transit' };
      case 'out_for_delivery':
        return { shipmentStatus: 'OUT_FOR_DELIVERY', orderStatus: 'OUT_FOR_DELIVERY', description: 'Out for Delivery' };
      case 'delivered':
        return { shipmentStatus: 'DELIVERED', orderStatus: 'DELIVERED', description: 'Delivered' };
      case 'ndr_raised':
      case 'need_attention':
      case 'reattempt_delivery':
        return { shipmentStatus: 'FAILED', orderStatus: 'FAILED_DELIVERY', description: 'Delivery Attempt Failed (NDR)' };
      case 'rto_initiated':
      case 'rto_in_transit':
      case 'rto':
        return { shipmentStatus: 'RTO', orderStatus: 'RTO_INITIATED', description: 'Return to Origin Initiated' };
      case 'rto_delivered':
        return { shipmentStatus: 'RTO_DELIVERED', orderStatus: 'RTO_DELIVERED', description: 'RTO Delivered to Origin' };
      case 'cancelled':
      case 'rejected':
        return { shipmentStatus: 'CANCELLED', orderStatus: 'CANCELLED', description: 'Shipment Cancelled' };
      case 'return_pickup_scheduled':
        return { shipmentStatus: 'CREATED', orderStatus: 'RETURN_DISPATCHED', description: 'Return Pickup Scheduled' };
      case 'return_in_transit':
        return { shipmentStatus: 'IN_TRANSIT', orderStatus: 'RETURN_DISPATCHED', description: 'Return In Transit' };
      case 'return_delivered':
        return { shipmentStatus: 'DELIVERED', orderStatus: 'RETURN_RECEIVED', description: 'Return Delivered at Warehouse' };
      default:
        return { shipmentStatus: 'IN_TRANSIT', orderStatus: 'IN_TRANSIT', description: velocityStatus };
    }
  }
}

export const velocityService = new VelocityService();
export default velocityService;
