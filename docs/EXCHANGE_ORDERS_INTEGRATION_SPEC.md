# Exchange Orders Integration Specification

## 1. Overview
In fashion e-commerce, customers frequently request a **size exchange** (e.g., Size M &rarr; Size L) rather than returning for a monetary refund. 

This document defines how **Shopify Youthnic OMS** orchestrates size exchanges between:
1. **Shopify Admin GraphQL API**: Registers the return and links the replacement variant (`exchangeLineItems`), automatically generating a new `FulfillmentOrder`.
2. **Velocity Shipping Aggregator**: Orchestrates the dual-movement logistics:
   - **Reverse Leg**: Pick up old size from customer's residence to Surat Warehouse (`WHGSYR`).
   - **Forward Leg**: Dispatch replacement size from Surat Warehouse to customer with prepaid shipping label.
3. **Youthnic OMS Frontend & Backend**: Centralized order actions, dual-AWB tracking, and automated state transitions.

---

## 2. Shopify Integration Details

### 2.1 GraphQL `returnCreate` Mutation with `exchangeLineItems`
Shopify's modern Returns API natively handles exchanges via `exchangeLineItems` in the `ReturnInput` payload:

```graphql
mutation ReturnCreate($returnInput: ReturnInput!) {
  returnCreate(returnInput: $returnInput) {
    userErrors {
      field
      message
    }
    return {
      id
      status
      exchangeLineItems(first: 10) {
        nodes {
          id
          quantity
          variant {
            id
            title
            sku
          }
        }
      }
    }
  }
}
```

### 2.2 Payload Structure
```json
{
  "returnInput": {
    "orderId": "gid://shopify/Order/99101",
    "returnLineItems": [
      {
        "fulfillmentLineItemId": "gid://shopify/FulfillmentLineItem/101",
        "quantity": 1,
        "returnReason": "SIZE_TOO_SMALL",
        "returnReasonNote": "Customer requested size exchange to Size L"
      }
    ],
    "exchangeLineItems": [
      {
        "variantId": "gid://shopify/ProductVariant/5002",
        "quantity": 1
      }
    ]
  }
}
```

### 2.3 Automatic Shopify Behaviors
1. **Spawns New `FulfillmentOrder`**: Shopify creates an open fulfillment order specifically for the replacement item on the original order.
2. **Payment Preservation**: Because the exchange is 1:1 at equal price, no money is refunded and no new payment is collected.
3. **Fulfillment Update**: When the replacement package is manifested, calling `fulfillOrderOnShopify` marks the exchange `FulfillmentOrder` fulfilled with carrier `'Velocity'` and the replacement AWB.

---

## 3. Velocity Logistics Integration Details

### 3.1 Reverse Pickup Shipment API
- **Endpoint:** `POST https://shazam.velocity.in/custom/api/v1/reverse-order-orchestration`
- **Identifier:** `${order.shopifyOrderName}-EX-RET`
- **Destination:** Surat Warehouse (`WHGSYR`)
- **Action:** Assigns downstream courier (e.g. Ekart, Delhivery) for doorstep pickup. Returns reverse `awb_code`.

### 3.2 Forward Replacement Shipment API
- **Endpoint:** `POST https://shazam.velocity.in/custom/api/v1/forward-order-orchestration`
- **Identifier:** `${order.shopifyOrderName}-EX-FWD`
- **Origin:** Surat Warehouse (`WHGSYR`)
- **Payment Method:** `PREPAID` (`cod_collectible: 0`)
- **Action:** Velocity manifests forward replacement parcel, assigns best courier, and provides an official shipping label URL.

### 3.3 Dispatch Strategies
1. **IMMEDIATE (Default / Customer Delight)**:
   - Manifests the forward replacement parcel immediately when the exchange is requested.
   - Warehouse packs and ships Size L right away.
2. **ON_PICKUP (Safe)**:
   - Leaves forward shipment in `PENDING` state.
   - When Velocity sends a webhook scan indicating the reverse parcel is `PICKED_UP` or `IN_TRANSIT`, the system automatically calls `velocityService.createExchangeForwardShipment(...)` and fulfills on Shopify.

---

## 4. OMS Database Schema Additions

In `prisma/schema.prisma`:

### Model `Return`
- `isExchange`: Boolean (true for exchange orders)
- `exchangeVariantId`: String? (Shopify Variant ID)
- `exchangeSku`: String? (Replacement SKU)
- `exchangeTitle`: String? (Replacement Size, e.g. "Size L")
- `exchangeForwardAwb`: String? (Forward replacement tracking AWB)
- `exchangeForwardShipmentId`: String? (Velocity shipment ID)
- `exchangeForwardStatus`: String? (`PENDING` | `DISPATCHED` | `IN_TRANSIT` | `DELIVERED`)
- `exchangeDispatchMode`: String? (`IMMEDIATE` | `ON_PICKUP`)
- `exchangeLabelUrl`: String? (PDF label download URL for forward replacement)

### Enum `OrderStatus`
- Added `EXCHANGE_REQUESTED`.
- Added to `OMS_OWNED_ORDER_STATUSES` to prevent Shopify sync race conditions.

---

## 5. API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/orders/:id/exchange-options` | Returns line items with sibling product variant sizes from Shopify GraphQL. |
| `POST` | `/api/orders/:id/exchange` | Orchestrates size exchange (reverse pickup + forward replacement + Shopify registration). |
| `POST` | `/webhooks/velocity` | Receives carrier tracking events; triggers automatic forward dispatch when `ON_PICKUP` reverse parcel is scanned. |

---

## 6. Frontend UI
1. **Shipment Actions Bar & More Actions Menu**:
   - "Exchange Size" button appears on delivered orders.
   - "Exchange order" option added inside the **More actions** dropdown on Order Detail (/orders/:id), with status guard informing operators if the forward parcel is awaiting delivery.
2. **ExchangeModal**: Interactive modal allowing selection of item, size selector chips, reason, carrier, and dispatch strategy.
3. **ActiveExchangeCard**: Dedicated status card displaying dual tracking pills:
   - Reverse Pickup AWB (Track Reverse)
   - Replacement Forward AWB (Track Forward + Print Label)

---

## 7. Streamlined Bulk Action Toolbar (Orders List)

The bulk action toolbar on `/orders` has been streamlined to prevent clutter, reduce redundant popups, and focus on essential high-volume warehouse operations:
- **Dispatch**: Real-time sequential dispatch with carrier priority and automatic routing.
- **DL Labels**: Consolidated 4R thermal shipping labels file download.
- **DL Labels+ Invoice**: Alternating labels + GST invoices file download.
- **DL Invoices**: Single consolidated GST invoice download (merged redundant individual invoice generator).
- **Schedule Pickup**: Next-day warehouse forward pickup request with Delhivery.
- **Confirm COD**: Bulk verification and confirmation for unconfirmed COD orders.
- **Export**: Selected orders CSV export.
- **Verify Payments**: Payment gateway verification for selected orders.
- *Removed redundant actions*: `Print Labels 4R` (redundant preview), `Print Label+Inv SEQ` (redundant preview), `Invoices GST` (merged into `DL Invoices`), `Picklist SKUs`, `Pack (ZIP)`, and `Get AWBs` (retained in header).
