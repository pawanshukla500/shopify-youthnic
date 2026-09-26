// Shared type definitions and interfaces

export interface ShopifyOrderWebhook {
  id: number;
  name: string;
  number: number;
  email?: string;
  phone?: string;
  financial_status?: string;
  fulfillment_status?: string;
  total_price: string;
  currency: string;
  tags?: string;
  note?: string;
  created_at: string;
  updated_at?: string;
  customer?: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    email?: string;
    default_address?: {
      address1?: string;
      city?: string;
      province?: string;
      zip?: string;
      country?: string;
      phone?: string;
    };
  };
  shipping_address?: {
    address1?: string;
    city?: string;
    province?: string;
    zip?: string;
    country?: string;
    phone?: string;
  };
  line_items: Array<{
    id: number;
    variant_id?: number;
    sku?: string;
    title: string;
    variant_title?: string;
    name?: string;
    quantity: number;
    price: string;
  }>;
}

export interface DelhiveryTrackingResponse {
  ShipmentData: Array<{
    Shipment: {
      AWB: string;
      Status: {
        Status: string;
        StatusLocation?: string;
        RecievedBy?: string;
        ScanDateTime?: string;
        Instructions?: string;
        StatusType?: string;
      };
      PickUpDate?: string;
      ExpectedDeliveryDate?: string;
      DeliveryDate?: string;
    };
    ScanDetail?: Array<{
      ScanDateTime: string;
      ScanType: string;
      ScanLocation: string;
      Instructions: string;
      ScannedLocation: string;
    }>;
  }>;
}

export interface KwiKenageSendResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface NotificationPayload {
  customerName: string;
  orderNumber: string;
  trackingNumber?: string;
  trackingUrl?: string;
  courierName?: string;
  returnReason?: string;
  refundAmount?: string;
  customMessage?: string;
}

export interface ShopifyProductImage {
  id?: number;
  product_id?: number;
  position?: number;
  created_at?: string;
  updated_at?: string;
  alt?: string | null;
  width?: number;
  height?: number;
  src: string;
  variant_ids?: number[];
  admin_graphql_api_id?: string;
}

export interface ShopifyProductOption {
  id?: number;
  product_id?: number;
  name: string;
  position?: number;
  values: string[];
}

export interface ShopifyProductVariant {
  id?: number;
  product_id?: number;
  title: string;
  price: string;
  sku?: string | null;
  position?: number;
  inventory_policy?: string;
  compare_at_price?: string | null;
  fulfillment_service?: string;
  inventory_management?: string | null;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  created_at?: string;
  updated_at?: string;
  taxable?: boolean;
  barcode?: string | null;
  grams?: number;
  weight?: number;
  weight_unit?: string;
  inventory_item_id?: number;
  inventory_quantity?: number;
  old_inventory_quantity?: number;
  requires_shipping?: boolean;
  admin_graphql_api_id?: string;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  body_html?: string | null;
  vendor: string;
  product_type?: string;
  created_at?: string;
  handle?: string;
  updated_at?: string;
  published_at?: string | null;
  template_suffix?: string | null;
  status: 'active' | 'draft' | 'archived';
  published_scope?: string;
  tags?: string;
  admin_graphql_api_id?: string;
  variants: ShopifyProductVariant[];
  options: ShopifyProductOption[];
  images: ShopifyProductImage[];
  image?: ShopifyProductImage | null;
  total_inventory?: number;
}

export interface ProductSummary {
  total: number;
  active: number;
  draft: number;
  archived: number;
  outOfStock: number;
  lowStock: number;
  totalInventory: number;
}
