# Shopify OMS — Automated Order Management System

[![Vitest Tests](https://img.shields.io/badge/Vitest-553%20Passed-brightgreen)](tests/)
[![TaskFlow Project](https://img.shields.io/badge/TaskFlow-Shopify%20Youthnic%20OMS-6366F1)](https://task.youthnic.shop/my-tasks?task=0bbb9b56-962c-4e9a-ae9a-95c41649ee0f)
[![Branch](https://img.shields.io/badge/Git-exchange__order-blue)](https://github.com/pawanshukla500/shopify-youthnic)

Automated order dispatch, tracking, returns, refunds, thermal shipping labels, transactional emails, and WhatsApp customer notifications for **youthnic2024.myshopify.com** (Brand: Youthnic).

---

## Architecture

```
Shopify Store (youthnic2024.myshopify.com)
     │
     ├── Webhooks (orders/create, orders/paid, orders/updated, orders/cancelled, refunds/create)
     │         │
     ▼         ▼
  ┌─────────────────────────────────────────────────────────┐
  │                 Shopify OMS (Node.js/Express)           │
  │                                                         │
  │  ┌──────────┐  ┌───────────┐  ┌────────────┐ ┌────────┐ │
  │  │ Shopify  │  │ Delhivery │  │  Resend    │ │Firebase│ │
  │  │ Service  │  │  Service  │  │  Email     │ │Storage │ │
  │  │          │  │           │  │  Service   │ │& Auth  │ │
  │  │ - Fetch  │  │ - Create  │  │ - Branded  │ │ - POD/ │ │
  │  │   Orders │  │   Shipment│  │   Templates│ │   QC   │ │
  │  │ - Refund │  │ - Track   │  │ - Dynamic  │ │   Docs │ │
  │  │ - Channel│  │ - 4R Label│  │   fromEmail│ │ - Auth │ │
  │  │   Guard  │  │ - Returns │  │ - Monospace│ │   Token│ │
  │  └──────────┘  └───────────┘  └────────────┘ └────────┘ │
  │        │              │              │            │     │
  │        ▼              ▼              ▼            ▼     │
  │  ┌───────────────────────────────────────────────────┐  │
  │  │             PostgreSQL 17 (Prisma ORM)            │  │
  │  │    Orders | Shipments | Returns | Notifications   │  │
  │  └───────────────────────────────────────────────────┘  │
  │                                                         │
  │  ┌───────────────────────────────────────────────────┐  │
  │  │                 Cron Scheduler                    │  │
  │  │  - Order sync (every 15 min)                      │  │
  │  │  - Tracking sync for pending & active (every 30m) │  │
  │  │  - Retry failed operations (hourly)               │  │
  │  └───────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────┘
```

---

## Recent Engineering Enhancements (PR #1 – PR #12)

1. **Thermal 4R (4" × 6") Shipping Labels & Resilient Fallback (PR #4, #6, #12)**:
   - Official Delhivery label layout matching authentic packaging slips, complete with barcode, routing codes, and horizontal Youthnic logo.
   - Pinned thermal 4R (`4 in × 6 in`) format covered with Vitest tests.
   - Multi-shape response parser handling all Delhivery API structures (`packages_found` arrays, `packages` object, or root URL).
   - High-fidelity HTML thermal-printable fallback to guarantee operators can print labels even if Delhivery's external PDF link returns 404.

2. **Dispatch State Machine & Order Promotion (PR #11)**:
   - Orders with generated Delhivery AWBs are immediately promoted out of `DISPATCH_PENDING` / `NEW` into **`DISPATCHED`**.
   - Shipment status transitions to **`IN_TRANSIT`** (or `AWB_ASSIGNED`), and `dispatchedAt` is stamped for audit logging.
   - Tracking cron updated to poll `PENDING` and `CREATED` shipments so tracking begins automatically.

3. **Youthnic Brand Migration & Email Engine (PR #8, #9, #10)**:
   - Full migration of transactional emails to modern Youthnic branding powered by Resend.
   - Sender badges standardized to lowercase identities (`delivery@youthnic.com`, `returns@youthnic.com`, `refunds@youthnic.com`, `support@youthnic.com`).
   - Youthnic logo hosted on Firebase Storage (`https://storage.googleapis.com/.../public/youthnic-logo.png`) preventing base64 inline image blocking in desktop email clients.
   - Monospace font stack (`JetBrains Mono`, `SF Mono`, `Menlo`, `Consolas`) applied to tracking numbers.

4. **Delhivery Package Dimensions & Freight Minimization (PR #8)**:
   - Package dimensions transmitted on every shipment creation to prevent courier volumetric overcharging:
     - **Single-item shipment**: `22 × 20 × 3 cm`
     - **Multi-item shipment**: `22 × 20 × 5 cm`
     - **Declared weight**: `500 g` (capped at base freight slab).

5. **Cloud Document & Proof of Delivery Mirroring (PR #5)**:
   - Added `delhivery-document-fetcher.service.ts` to automatically fetch and archive Delhivery POD images, QC sorter images, and shipping labels directly to Firebase Storage (`shipments/<waybill>/...`).

6. **Floating Bulk-Action Bar Redesign (PR #7)**:
   - Re-engineered the floating bulk-action toolbar on `/orders` with modern visual hierarchy, selected item badges, and quick dispatch/label actions.

7. **Security & Protocol Hardening (PR #3)**:
   - Server-side and client-side 301 HTTPS redirects, CSP `upgrade-insecure-requests` headers, and strict Firebase token authentication for administrative API routes.

8. **Deployment & Database Migration Safeguard (3829719)**:
   - CI/CD workflow pushes Prisma schema changes (`npx prisma db push --accept-data-loss`) prior to application build, eliminating database drift on Hostinger VPS and Railway deployments.

9. **External Fulfillment Sync, Live Delhivery Tracking Layout & Alternating Label+Invoice (PR #13)**:
   - Ingests external fulfillments (Shopify Admin / 3PL) via `fulfillments/create` and `fulfillments/update` webhooks, stores AWBs, and immediately triggers background live tracking sync with Delhivery API.
   - Added rich "Live Delhivery Tracking & Parcel Journey" UI panel in `OrderDetail.tsx` featuring a 5-stage transit progress stepper (`Manifested` → `Picked Up` → `In Transit` → `Out for Delivery` → `Delivered`), exception alert styling for NDR/RTO, live telemetry cards, "⚡ Refresh Live Tracking" action, and chronological scan event timeline.
   - Direct file download for shipping labels without opening a new tab (`GET /api/orders/:id/label/download` and `POST /api/orders/bulk-labels/download`).
   - Combined single & bulk documents strictly sequenced as: **Order 1 Label → Order 1 Invoice → Order 2 Label → Order 2 Invoice...** formatted with thermal 4R and A4 page breaks.
   - Filled and validated all official Delhivery integration documents (`Scan Push`, `EPOD`, `QC Image`, `Sorter Image`) for profile `fa5d92-VBEXPORT-do` (V B EXPORT) in `C:\Users\Pawan Shukla\Desktop\Delhivery Docs\`.
   - Complete technical specifications documented in [`docs/DELHIVERY_INTEGRATION_SPEC.md`](docs/DELHIVERY_INTEGRATION_SPEC.md).

10. **Velocity Shipping Partner Integration, Multi-Carrier Routing & Automated Remittance (PR #14)**:
    - **Dual-Carrier Smart Routing**: Dispatches shipments across Delhivery Express and Velocity Shipping with configurable carrier priority (DELHIVERY_FIRST vs VELOCITY_FIRST), automatic failover protection upon destination unserviceability, and payment-mode routing rules (dedicated COD vs Prepaid courier preferences).
    - **Direct Live Remittance & Finance Reconciliation**: Direct API integration with Velocity's Finance API (/custom/api/v1/finance/remittance), automatically matching orders, recording UTR bank settlement evidence, updating accounts trails, and eliminating manual CSV download/upload routines.
    - **Authentic Official Velocity PDF Labels**: Streaming authentic PDF bytes directly from Velocity API / S3 without customized HTML mockups.
    - **De-cluttered Executive Attention Center**: Re-engineered dashboard action center from vertically stacked alert banners into a responsive attention grid with category filter chips (Critical, Fulfillment, Finance) and multi-carrier logistics telemetry pulse.

11. **COD Manual Refund Workflow & Single-Refund Enforcement (PR #73)**:
    - **Mandatory Manual COD Refund**: Zero-money automated Shopify refunds are blocked on COD returns. Passed QC marks returns as REFUND_PENDING and tags orders on Shopify with COD_MANUAL_REFUND_DUE.
    - **Payment Proof Verification**: Manual payouts strictly require non-empty Bank UTR or payout screenshot/receipt (PNG, JPEG, WebP, PDF up to 5 MB) written to the permanent account trail.
    - **Strict Single-Refund Invariant**: Enforces that each order can only be refunded once across prepaid and COD workflows. In-flight mutex (manualRefundsInFlight: Set<number>) prevents concurrent duplicate payouts.
    - **Size Exchange Protection**: Returns with isExchange: true are barred from cash refunds and route exclusively to size replacement order fulfillment.
    - Complete specifications in [docs/COD_MANUAL_REFUND_AND_REVERSE_LOGISTICS_SPEC.md](docs/COD_MANUAL_REFUND_AND_REVERSE_LOGISTICS_SPEC.md).

12. **Modernized Reverse Logistics Workspace & Barcode Scanner Intake (PR #74)**:
    - **Interactive 5-Metric Ribbon**: Displays Total Returns, Pending QC, COD Refund Due (with amber highlight), Size Exchanges, and Settled / Refunded with interactive quick-filtering.
    - **Hands-Free Warehouse Intake**: Barcode scanner Enter key listener automatically triggers return package arrival and QC intake.
    - **Visual Hierarchy & Badges**: High-contrast pill badges (.badge-cod, .badge-prepaid, .badge-exchange, .badge-refund-due, .badge-settled) and forward AWB tracking chips.
    - **Full Browser Test Suite**: Covered with Playwright automation in 	ests/browser/returns_workspace.py.

---

## Automated Flow

### Order → Dispatch → Delivery
1. New order arrives on Shopify → webhook triggers (or cron polls every 15 min).
2. Order is stored in PostgreSQL with customer details, address, and line items (enforcing strict **2026-09-25** cutoff).
3. **Payment verification**: system inspects Shopify transactions to detect gateway (GoKwik / PhonePe) and ensures payment capture for prepaid orders (COD passes automatically).
4. System auto-creates shipment on Delhivery or Velocity with exact dimensions (22x20x3 or 22x20x5 cm, 500g slab) → AWB generated.
5. Order status promoted to **DISPATCHED**; shipment promoted to **IN_TRANSIT**; dispatchedAt timestamp recorded.
6. WhatsApp & Youthnic branded confirmation emails sent to the customer with live tracking link.
7. Cron job polls carrier tracking every 30 min.
8. Status transitions: Picked Up → In Transit → Out for Delivery → Delivered.
9. If delivery fails → automated NDR alert and customer re-attempt workflow.

### Return → Scan → Refund & Settlement
1. Return request created (via API, admin portal, or exchange action).
2. Reverse pickup scheduled with carrier (Delhivery or Velocity).
3. Returned package arrives at warehouse → **scanned** via barcode gun on /returns (Enter key triggers intake).
4. QC inspection check (APPROVED / REJECTED / PARTIAL).
5. **Settlement Decision Matrix**:
   - **Size Exchanges (isExchange: true)**: Replacement order dispatched; zero cash refund issued.
   - **Prepaid Orders**: Automated refund calculated and processed via Shopify API to original payment method. Order marked REFUNDED.
   - **COD Orders**: Marked REFUND_PENDING / PENDING with tag COD_MANUAL_REFUND_DUE. Operator reviews and executes payout with required payment proof (Bank UTR or payout screenshot).
6. Single-refund invariant verified and permanent audit event recorded in PostgreSQL account trail.

---

## Setup & Local Development

### Prerequisites
- Node.js 20+
- PostgreSQL 17 database
- Shopify store with Dev Dashboard App client credentials
- Delhivery Express B2C account with API token
- Firebase service account (`firebase-service-account.json`)
- Resend API key for transactional emails

### Installation

```bash
# 1. Install dependencies
npm install

# 2. Generate Prisma client
npx prisma generate

# 3. Synchronize database schema
npx prisma db push

# 4. Configure environment variables
cp .env.example .env
#    Fill the secret keys from the deployed server (GitHub secrets are
#    write-only). Copies only empty secret keys over your own SSH key and
#    never prints a value. Keep CRON_ENABLED=false locally: the .env then
#    holds production credentials and production already runs the crons.
npm run env:pull

# 5. Run tests (Vitest suite — 279 tests)
cmd.exe /c "npm test"

# 6. Run development server (Port 3000)
cmd.exe /c "npm run dev"
# or double-click run.bat
```

### Admin Panel (React frontend)

A React admin interface lives in [`frontend/`](frontend/). It communicates with the backend via Vite dev proxy:

```bash
cd frontend
npm install
cmd.exe /c "npm run dev"
# or double-click run-frontend.bat from project root
```

Access the panel at <http://localhost:5173>.

---

## Quality Gates & Testing

The project maintains comprehensive test coverage across critical business logic and integrations:

```bash
# Run unit and integration tests (279 tests across 33 test files)
cmd.exe /c "npm test"

# Run backend TypeScript compilation
cmd.exe /c "npm run build"

# Run frontend production build
cmd.exe /c "cd frontend && npm run build"
```

Test suites include:
- `tests/external-tracking-and-label-invoice.spec.ts` — External fulfillment sync & alternating label/invoice sequence
- `tests/courier-matching-and-tracking.spec.ts` — Courier detection & Delhivery live tracking routing
- `tests/shopify-fulfillment-webhooks.spec.ts` — Ingestion of `fulfillments/create` and `fulfillments/update`
- `tests/delhivery-label-size.spec.ts` — Thermal 4R label format pinning
- `tests/delhivery-label-fetch.spec.ts` — Multi-shape API extraction & HTML fallback
- `tests/delhivery-shipment-dimensions.spec.ts` — Dimension optimization logic
- `tests/dispatch-order-status.spec.ts` — Pre-dispatch to DISPATCHED state promotion
- `tests/email-brand-logo.spec.ts` — Lowercase sender badges & Firebase Storage logo
- `tests/delhivery-document-fetcher.spec.ts` — POD/QC document mirroring
- `tests/delhivery-webhook-payload.spec.ts` — Delhivery webhook ingestion & verification
- `tests/api-resilience.spec.ts` — Public webhook exemptions and auth guardrails
- `tests/order-tabs.spec.ts` — Status filters and tab partitions

---

## Key API Endpoints

### Orders & Dispatch
- `GET /api/orders` — List orders with filtering (`?status=NEW`, `?salesChannel=...`)
- `GET /api/orders/:id` — Order details, items, and shipment status
- `POST /api/orders/:id/dispatch` — Manually dispatch an order to Delhivery (with payment gate)
- `POST /api/orders/sync` — Trigger Shopify order sync (respecting `2026-09-25` floor)

### Shipping Labels & Combined Documents
- `GET /api/orders/:id/label` — View/print single 4R thermal shipping label (HTML preview)
- `GET /api/orders/:id/label/download` — Directly download 4R thermal label file (no new tab)
- `POST /api/orders/bulk-labels` — Printable consolidated multi-order 4R shipping labels
- `POST /api/orders/bulk-labels/download` — Directly download consolidated multi-order labels file
- `GET /api/orders/:id/label-and-invoice` — Printable preview of Label then Invoice (Order 1)
- `GET /api/orders/:id/label-and-invoice/download` — Directly download Label then Invoice as a file
- `POST /api/orders/bulk-labels-and-invoices` — Printable preview of alternating labels and invoices
- `POST /api/orders/bulk-labels-and-invoices/download` — Directly download bulk alternating labels and invoices file

### Live Delhivery Tracking & Telemetry
- `POST /api/orders/:id/track` — Trigger live carrier tracking sync from Delhivery API for an order
- `POST /api/tracking/:waybill/sync` — Sync live carrier telemetry directly by waybill AWB
- `GET /api/delhivery/label/:waybill` — Fetch official Delhivery PDF or HTML printable fallback
- `GET /api/delhivery/serviceability/:pincode` — Check pincode delivery serviceability
- `POST /api/delhivery/ndr` — Submit NDR actions (`RE-ATTEMPT` or `PICKUP_RESCHEDULE`)
- `GET /api/delhivery/document/:waybill?type=EPOD` — Download EPOD, QC images, or signatures

### Delhivery Webhooks (Real-Time Ingestion)
- `POST /webhooks/delhivery` — Scan Push webhook (all lifecycle transit scans)
- `POST /webhooks/delhivery/epod` — Electronic Proof of Delivery (EPOD) image ingestion
- `POST /webhooks/delhivery/qc-image` — Quality Check (QC) inspection image push
- `POST /webhooks/delhivery/sorter-image` — Sorter / Profiler conveyor belt image push

### Returns & QC
- `GET /api/returns` — List returns and inspections
- `POST /api/returns/scan` — Warehouse QC barcode scan (triggers auto-refund on approval)
- `POST /api/returns/:id/refund` — Process refund on Shopify

---

## Operational Guide for Agents

- Refer to [`AGENTS.md`](AGENTS.md) for full architecture standards, invariants, and guidelines.
- Always synchronize task progress with **TaskFlow Pro** (`a7f820cb-4885-486d-92d2-c8e4a63054f4`).
- Refer to [`docs/HANDOFF.md`](docs/HANDOFF.md) for current deployment and infrastructure details.
