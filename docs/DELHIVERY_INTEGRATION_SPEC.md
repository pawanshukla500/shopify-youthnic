# Delhivery Integration Specification & Webhook Requirements

> **Account Identifier**: `fa5d92-VBEXPORT-do` (Domestic Express Profile)  
> **Company Legal Name**: `V B EXPORT` (GSTIN: `24AERPB8666E1ZB`)  
> **Brand / Storefront**: `Youthnic` (`youthnic2024.myshopify.com`)  
> **Registered Warehouse**: `Surat Warehouse` (Active, Surat, Gujarat — 395002)  
> **Technical SPOC**: Pawan Shukla (`returnorders@vbexports.co.in`, `+91 7984984563`)  
> **Official Docs Location**: `C:\Users\Pawan Shukla\Desktop\Delhivery Docs\`  
> **Last Verified**: 2026-09-29  

---

## 1. Executive Summary

This document specifies the technical integration between **Shopify Youthnic OMS** and **Delhivery Logistics**. It captures:
1. **Four Official Delhivery Webhook Integrations** (Scan Push, EPOD, QC Image, and Sorter Image) matching the completed requirement documents in `C:\Users\Pawan Shukla\Desktop\Delhivery Docs\`.
2. **External Fulfillment Synchronization & Live Tracking** (when orders are fulfilled externally via Shopify Admin or 3PL, capturing tracking AWBs and pulling live Delhivery telemetry).
3. **Direct File Downloads & Alternating Label + Invoice Sequencing** (direct downloads without opening new tabs, and strict alternating document formatting: Order 1 Label $\rightarrow$ Order 1 Invoice $\rightarrow$ Order 2 Label $\rightarrow$ Order 2 Invoice...).

---

## 2. Delhivery Account Credentials & Profile

| Parameter | Configured Value | Operational Notes |
|---|---|---|
| **Client Profile** | `fa5d92-VBEXPORT-do` | Domestic Express profile used for all B2C ecommerce surface shipments. |
| **Account Name (Dev/Prod)** | `fa5d92-VBEXPORT-do (Domestic Express / V B EXPORT)` | Exact client profile name across Delhivery systems. |
| **Company Details** | V B EXPORT (GST: `24AERPB8666E1ZB`) | Nidhivan Appartment 602/6B Parle Point, Athwa, Near Taj Gateway, Surat. |
| **Pickup Facility Name** | `Surat Warehouse` | Active pickup facility matching `DELHIVERY_PICKUP_LOCATION` character-for-character. |
| **Pickup Address** | 7004, Hi-tech Textile Centre (HTC Market - 1), Anjana Farm, Near Raghukul Market, Surat, Gujarat — 395002 | Physical fulfillment & dispatch center. |
| **Primary Contact** | Pawan Shukla (Operations Head / Admin) | Phone: `+91 7984984563` \| Email: `returnorders@vbexports.co.in` |
| **Shipment Volume** | Daily: ~100–300 pkgs \| Monthly: ~3,000–9,000 pkgs | B2C apparel and lifestyle orders. |
| **P99 API Latency** | `120 ms` | Complies with Delhivery's SLA of $\le 500\text{ ms}$. |

---

## 3. Webhook Endpoints & Specifications

The OMS exposes dedicated, high-performance webhook endpoints to ingest real-time events from Delhivery. All webhooks process incoming events asynchronously and respond immediately with HTTP 200 `{"received": true}`.

### Summary Table

| Webhook Name | Production & Staging Endpoint URL | Method | Header | Expected P99 | Requirement Document Filename |
|---|---|---|---|---|---|
| **Scan Push Webhook** | `https://shopify.youthnic.shop/webhooks/delhivery` | `POST` | `Content-Type: application/json` | `120 ms` | `Scan Push webhook requirementdocument.docx` (and `(1).docx`) |
| **EPOD Webhook** | `https://shopify.youthnic.shop/webhooks/delhivery/epod` | `POST` | `Content-Type: application/json` | `120 ms` | `EPOD REQUIREMENT DOCUMENT.docx` |
| **QC Image Webhook** | `https://shopify.youthnic.shop/webhooks/delhivery/qc-image` | `POST` | `Content-Type: application/json` | `120 ms` | `QCIMAGEPUSHREQUIREMENT DOC.docx` |
| **Sorter Image Webhook** | `https://shopify.youthnic.shop/webhooks/delhivery/sorter-image` | `POST` | `Content-Type: application/json` | `120 ms` | `Sorter image_Webhook Requirement document.docx` (and `.doc`) |

---

### A. Scan Push Webhook (`/webhooks/delhivery`)
Captures real-time lifecycle status scans (forward dispatch, transit hubs, out for delivery, delivery confirmation, NDR attempts, and RTO return flows).

* **Endpoint**: `POST https://shopify.youthnic.shop/webhooks/delhivery`
* **Default Payload**: `Yes`
* **Custom Payload**: `No`
* **Required Scans**: `All scans/Status needed - Yes` (Forward milestones: Manifested, Picked Up, In Transit, Out for Delivery, Delivered; Exception & Return milestones: Attempted Delivery / NDR, RTO Initiated, RTO Delivered).
* **Payload Format Accepted**:
  ```json
  {
    "Shipment": {
      "Status": {
        "Status": "In Transit",
        "StatusDateTime": "2026-09-29T10:15:30.000Z",
        "StatusType": "UD",
        "StatusLocation": "Surat_Hub_C (Gujarat)",
        "Instructions": "Departed hub"
      },
      "PickUpDate": "2026-09-29 09:30:00",
      "NSLCode": "X-UCI",
      "Sortcode": "STV/HUB",
      "ReferenceNo": "1042",
      "AWB": "30100810010054"
    }
  }
  ```
  *(Also accepts legacy flat payload: `{"waybill": "...", "status": "...", "status_type": "...", "location": "...", "scan_datetime": "..."}`)*
* **Expected Response**:
  ```json
  HTTP/1.1 200 OK
  Content-Type: application/json

  {
    "received": true
  }
  ```

---

### B. Electronic Proof of Delivery Webhook (`/webhooks/delhivery/epod`)
Ingests customer signature and delivery proof images upon successful package handover.

* **Endpoint**: `POST https://shopify.youthnic.shop/webhooks/delhivery/epod`
* **Default Payload**: `Yes`
* **Payload Structure**:
  ```json
  {
    "waybill": "30100810010054",
    "EPOD": "data:image/jpeg;base64,...",
    "orderID": "1042"
  }
  ```
* **Storage & Archiving**:
  - Automatically decoded and mirrored to Firebase Storage at `shipments/<waybill>/epod.jpg`.
  - Stored on `Shipment.epodUrl` in PostgreSQL database.
* **Expected Response**: `200 OK {"received": true}`

---

### C. Quality Check Image Push Webhook (`/webhooks/delhivery/qc-image`)
Ingests return package inspection images taken during return pickup or warehouse inbound verification.

* **Endpoint**: `POST https://shopify.youthnic.shop/webhooks/delhivery/qc-image`
* **Default Payload**: `Yes`
* **Payload Structure**:
  ```json
  {
    "waybillId": "30100810010054",
    "returnId": "RET-1042",
    "Image": "data:image/jpeg;base64,..."
  }
  ```
* **Storage & Archiving**:
  - Stored in Firebase Storage at `shipments/<waybill>/qc/<timestamp>.jpg`.
  - Accessible via return inspection audit view in the admin portal.
* **Expected Response**: `200 OK {"received": true}`

---

### D. Sorter / Profiler Image Webhook (`/webhooks/delhivery/sorter-image`)
Ingests automatic conveyor belt dimension and weight scanner images from Delhivery sorting facilities.

* **Endpoint**: `POST https://shopify.youthnic.shop/webhooks/delhivery/sorter-image`
* **Default Payload**: `Yes`
* **Payload Structure**:
  ```json
  {
    "Waybill": "30100810010054",
    "Weight_images": "https://delhivery-sorter-images.s3.amazonaws.com/...",
    "doc": ""
  }
  ```
* **Storage & Archiving**:
  - Downloaded and archived to Firebase Storage at `shipments/<waybill>/sorter.jpg`.
  - Used for weight discrepancy audit verification against declared dimensions (`22x20x3 cm` / `500 g`).
* **Expected Response**: `200 OK {"received": true}`

---

## 4. Delhivery Outbound IP Whitelist

If Delhivery requires their IP addresses to be whitelisted for webhook delivery:

### Production IPs
```
52.76.70.1
13.229.195.68
18.139.238.62
13.127.20.101
13.126.12.240
35.154.161.83
3.108.106.65
3.6.106.39
18.61.175.16
```

### Development / Staging IPs
```
18.136.12.154
13.250.167.49
52.220.126.238/32
3.108.106.65
3.109.19.228
3.7.116.186
3.6.106.39
```

> **Note**: Our OMS server accepts webhook traffic openly and validates the payload or shared secret (`x-delhivery-secret` header or `?secret=` query parameter). Delhivery does not need to whitelist any client IP.

---

## 5. Technical Escalation Matrix

As filled in Table 3 of all official requirement documents:

| Level | Contact Role / Name | Email Address | Phone Number | Responsibility |
|---|---|---|---|---|
| **L1** | **Pawan Shukla (Operations Head)** | `returnorders@vbexports.co.in` | `+91 7984984563` | Real-time webhook delivery issues, initial scan reception, operational alerts. |
| **L2** | **Technical Operations / V B EXPORT** | `returnorders@vbexports.co.in` | `+91 7984984563` | Server availability, network routing, SSL certificates, payload schema parsing. |
| **L3** | **Pawan Shukla (Director Escalations)** | `returnorders@vbexports.co.in` | `+91 7984984563` | Business integration, contract SLAs, API token renewal, high-priority escalation. |

---

## 6. External Fulfillment Sync & Live Tracking Architecture (PR #13)

When an order is not dispatched directly from this OMS but instead fulfilled externally (e.g., via the Shopify Admin interface, Delhivery One portal, or warehouse 3PL):

```
┌──────────────────────────────────────────────────────────────┐
│  External Dispatch (Shopify Admin / Delhivery One Portal)    │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               │ fulfillments/create or fulfillments/update
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Shopify Webhook Ingestion (`src/routes/webhooks.ts`)        │
│  - Fetches parent order details via `fetchOrder(order_id)`   │
│  - Executes `shopifyService.syncOrderToDb(parentOrder)`      │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               │ Extracts AWB & detects carrier (/delhivery/i)
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Shipment Record Upserted & Immediate Tracking Triggered     │
│  - `trackingService.syncShipmentTracking(waybillNumber)`     │
│  - Queries Delhivery Live Tracking API immediately           │
│  - Updates current status, hub location, and scan logs       │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Live Delhivery Tracking & Parcel Journey UI Updated         │
│  - 5-stage visual transit stepper (Manifested → Delivered)   │
│  - NDR / Delivery exception alerts                           │
│  - Real-time "⚡ Refresh Live Tracking" action                │
│  - Chronological scan timeline table                         │
└──────────────────────────────────────────────────────────────┘
```

### Dedicated Live Tracking APIs
- `POST /api/orders/:id/track`: Syncs live carrier tracking data from Delhivery API for an order's shipment on-demand.
- `POST /api/tracking/:waybill/sync`: Syncs live carrier tracking data directly by AWB waybill number.

---

## 7. Direct Downloads & Alternating Label + Invoice Sequence

### A. Direct Label Download (No New Browser Tab)
- Standard browser behaviour for printable pages opens a new blank tab. Operators requested a direct file download option so batches can be downloaded with a single click.
- **Endpoints**:
  - `GET /api/orders/:id/label/download`: Downloads 4R thermal label file (`delhivery-label-<waybill>.pdf` or `.html`) with `Content-Disposition: attachment`.
  - `POST /api/orders/bulk-labels/download`: Downloads bulk thermal labels file directly.
- **UI Elements**:
  - `OrderDetail.tsx`: `📥 Download Label` button.
  - `Orders.tsx`: Row action `DL Label` and floating bulk bar `DL Labels (File)`.

### B. Combined Label + Invoice ("Label then Invoice, Label then Invoice")
- In physical order fulfillment, warehouse packers paste the shipping label on the flyer and insert the tax invoice inside. Having separate documents forces manual collation.
- The OMS generates combined documents strictly ordered as:
  $$\text{Order 1 Label} \longrightarrow \text{Order 1 Invoice} \longrightarrow \text{Order 2 Label} \longrightarrow \text{Order 2 Invoice} \dots$$
- **Document Sizing & Print Rules**:
  - **Label Page**: Thermal 4R (`100mm × 150mm`), `@page { size: 100mm 150mm; margin: 0; }`.
  - **Invoice Page**: GST Tax Invoice A4 Portrait, `@page { size: A4 portrait; margin: 8mm; }`.
  - Each page separated by `<div class="page-break"></div>` with `page-break-after: always; break-after: page;`.
- **Endpoints**:
  - `GET /api/orders/:id/label-and-invoice`: Printable preview tab for single order.
  - `GET /api/orders/:id/label-and-invoice/download`: Direct file download for single order.
  - `POST /api/orders/bulk-labels-and-invoices`: Printable preview tab for bulk orders.
  - `POST /api/orders/bulk-labels-and-invoices/download`: Direct file download for bulk orders.

---

## 8. Physical Document Repository & Verification

All official completed `.docx` and `.doc` files are stored at:
```
C:\Users\Pawan Shukla\Desktop\Delhivery Docs\
```

| File Name | Size | Content Verified | Ready to Send |
|---|---|---|---|
| `EPOD REQUIREMENT DOCUMENT.docx` | 20.9 KB | Account ID, Webhook URL `/epod`, P99 120ms, L1-L3 Matrix, Daily/Monthly volume, 1hr release verification confirmed. | ✅ Yes |
| `QCIMAGEPUSHREQUIREMENT DOC.docx` | 497.6 KB | Account ID, Webhook URL `/qc-image`, P99 120ms, L1-L3 Matrix, Daily/Monthly volume, 1hr release verification confirmed. | ✅ Yes |
| `Scan Push webhook requirementdocument.docx` | 19.6 KB | Account ID, Webhook URL `/delhivery`, All scans Yes, P99 120ms, L1-L3 Matrix, Daily/Monthly volume, 1hr release verification confirmed. | ✅ Yes |
| `Scan Push webhook requirementdocument (1).docx` | 19.6 KB | Duplicate copy identical to above for vendor records. | ✅ Yes |
| `Sorter image_Webhook Requirement document.docx` | 27.1 KB | Account ID, Webhook URL `/sorter-image`, P99 120ms, L1-L3 Matrix, Daily/Monthly volume, 1hr release verification confirmed. | ✅ Yes |
| `Sorter image_Webhook Requirement document.doc` | 49.6 KB | Legacy Word 97-2003 format synced via Word COM automation. | ✅ Yes |
