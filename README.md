# Shopify OMS — Automated Order Management System

[![Vitest Tests](https://img.shields.io/badge/Vitest-38%20Passed-brightgreen)](tests/)
[![TaskFlow Project](https://img.shields.io/badge/TaskFlow-Shopify%20Youthnic%20OMS-6366F1)](https://task.youthnic.shop/my-tasks?task=164ba233-9b5f-4c14-bc34-066cef4300fc)
[![Branch](https://img.shields.io/badge/Git-origin%2Fmain-blue)](https://github.com/pawanshukla500/shopify-youthnic)

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

---

## Automated Flow

### Order → Dispatch → Delivery
1. New order arrives on Shopify → webhook triggers (or cron polls every 15 min).
2. Order is stored in PostgreSQL with customer details, address, and line items (enforcing strict **`2026-09-25`** cutoff).
3. **Payment verification**: system inspects Shopify transactions to detect gateway (GoKwik / PhonePe) and ensures payment capture for prepaid orders (COD passes automatically).
4. System auto-creates shipment on Delhivery with exact dimensions (`22x20x3` or `22x20x5 cm`, 500g slab) → AWB generated.
5. Order status promoted to **`DISPATCHED`**; shipment promoted to **`IN_TRANSIT`**; `dispatchedAt` timestamp recorded.
6. WhatsApp & Youthnic branded confirmation emails sent to the customer with live Delhivery tracking link.
7. Cron job polls Delhivery tracking every 30 min.
8. Status transitions: Picked Up → In Transit → Out for Delivery → Delivered.
9. If delivery fails → automated NDR alert and customer re-attempt workflow.

### Return → Scan → Refund
1. Return request created (via API or admin portal).
2. Reverse pickup scheduled with Delhivery.
3. Returned package arrives at warehouse → **scanned** (via `/api/returns/scan`).
4. QC check (`APPROVED` / `REJECTED` / `PARTIAL`).
5. If QC approved → **refund automatically calculated and processed on Shopify**.
6. Transactional notification sent to customer; money returned via original payment method.

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

# 5. Run tests (Vitest suite — 38 tests)
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
# Run unit and integration tests (38 tests across 7 test suites)
cmd.exe /c "npm test"

# Run backend TypeScript compilation
cmd.exe /c "npm run build"

# Run frontend production build
cmd.exe /c "cd frontend && npm run build"
```

Test suites include:
- `tests/delhivery-label-size.spec.ts` — Thermal 4R label format pinning
- `tests/delhivery-label-fetch.spec.ts` — Multi-shape API extraction & HTML fallback
- `tests/delhivery-shipment-dimensions.spec.ts` — Dimension optimization logic
- `tests/dispatch-order-status.spec.ts` — Pre-dispatch to DISPATCHED state promotion
- `tests/email-brand-logo.spec.ts` — Lowercase sender badges & Firebase Storage logo
- `tests/delhivery-document-fetcher.spec.ts` — POD/QC document mirroring
- `tests/delhivery-webhook-payload.spec.ts` — Delhivery webhook ingestion & verification

---

## Key API Endpoints

### Orders & Dispatch
- `GET /api/orders` — List orders with filtering (`?status=NEW`, `?salesChannel=...`)
- `GET /api/orders/:id` — Order details, items, and shipment status
- `POST /api/orders/:id/dispatch` — Manually dispatch an order to Delhivery (with payment gate)
- `POST /api/orders/sync` — Trigger Shopify order sync (respecting `2026-09-25` floor)

### Shipping Labels & Logistics
- `GET /api/delhivery/label/:waybill` — Fetch official Delhivery PDF or HTML printable fallback
- `GET /api/delhivery/serviceability/:pincode` — Check pincode delivery serviceability
- `POST /api/delhivery/ndr` — Submit NDR actions (`RE-ATTEMPT` or `PICKUP_RESCHEDULE`)
- `GET /api/delhivery/document/:waybill?type=EPOD` — Download EPOD, QC images, or signatures

### Returns & QC
- `GET /api/returns` — List returns and inspections
- `POST /api/returns/scan` — Warehouse QC barcode scan (triggers auto-refund on approval)
- `POST /api/returns/:id/refund` — Process refund on Shopify

---

## Operational Guide for Agents

- Refer to [`AGENTS.md`](AGENTS.md) for full architecture standards, invariants, and guidelines.
- Always synchronize task progress with **TaskFlow Pro** (`a7f820cb-4885-486d-92d2-c8e4a63054f4`).
- Refer to [`docs/HANDOFF.md`](docs/HANDOFF.md) for current deployment and infrastructure details.
