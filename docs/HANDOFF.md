# Shopify OMS — System Handoff & Operational State

> **Last Verified**: 2026-09-27  
> **Repository**: [pawanshukla500/shopify-youthnic](https://github.com/pawanshukla500/shopify-youthnic) (Branch: `main`)  
> **TaskFlow Pro Project**: `Shopify Youthnic OMS` (`a7f820cb-4885-486d-92d2-c8e4a63054f4`)  

---

## 1. System Overview

Automated Order Management System for **youthnic2024.myshopify.com** (Brand: Youthnic).

- **Backend**: Node.js 20 + Express + TypeScript + Prisma 5.22 + PostgreSQL 17 (in `src/`, port 3000)
- **Admin Panel**: React 19 + Vite + TypeScript + Tailwind CSS v4 (in `frontend/`, port 5173, production build in `frontend/dist`)
- **Integrations**:
  - **Shopify Admin API**: Automated order synchronization, fulfillments, refunds, and webhooks via Dev Dashboard App client credentials.
  - **Delhivery Express B2C**: Channel dispatch (`youthnic2024`), shipment generation, thermal 4R labels, tracking status, NDR workflow, and return pickups.
  - **Firebase Storage & Auth**: Strict token verification on protected endpoints, mirroring of shipping labels, proof-of-delivery (POD) images, QC sorter images, and CDN-hosted email assets.
  - **Resend**: Transactional emails with modern Youthnic branding and lowercase sender badges.
  - **Payment Gateways**: Detection of PhonePe and GoKwik transactions via Shopify payment data.

---

## 2. Infrastructure & Deployment

- **Database**: Hostinger VPS `1845788` (`200.141.1.119`), PostgreSQL 17 in Docker (`postgresql-6k6a`), port `5433`, database `shopify`, user `pawanshukla`.
- **Delhivery Warehouse**: `Surat Warehouse` (facility `INGJBABS`), 7004 Hi-tech Textile Centre (HTC Market - 1), Surat, Gujarat 395002.
- **Production CI/CD**:
  - `.github/workflows/pull-request.yml`: Runs `npm test` (38 Vitest tests) and `npm run build` on every PR.
  - `.github/workflows/deploy.yml`: Automatically pushes Prisma schema (`prisma db push --accept-data-loss`) before building and deploying to production.
- **Version Control**: Git repository initialized, tracked on `origin/main` at `pawanshukla500/shopify-youthnic`.

---

## 3. Verified Development Milestones (PR #1 through PR #12)

1. **Shipping Label Resiliency (PR #4, #6, #12)**:
   - Thermal 4R (`4 in × 6 in` / `100 mm × 150 mm`) format pinned and verified via unit tests.
   - Dynamic extraction supporting Delhivery's varied API response shapes (`packages_found` array, `packages` object, or root URL).
   - Instant HTML thermal-ready printable fallback if Delhivery's external PDF link returns 404.
   - Branded with the horizontal Youthnic logo, routing codes, and barcode.

2. **Dispatch State Machine & Order Promotion (PR #11)**:
   - When a Delhivery AWB is generated, order status moves immediately from `DISPATCH_PENDING` to `DISPATCHED`.
   - Shipment status transitions to `IN_TRANSIT` (or `AWB_ASSIGNED`), and `dispatchedAt` is stamped for audit logging.
   - Scheduled tracking cron polls `PENDING`, `CREATED`, and `IN_TRANSIT` shipments to maintain real-time status.

3. **Youthnic Brand Migration & Email Engine (PR #8, #9, #10)**:
   - Replaced generic notifications with Youthnic branded transactional emails.
   - Sender badges standardized to lowercase addresses (`delivery@youthnic.com`, `returns@youthnic.com`, `refunds@youthnic.com`, `support@youthnic.com`).
   - Youthnic logo hosted on Firebase Storage (`public/youthnic-logo.png`) preventing base64 inline image blocking in desktop email clients (Outlook/Mac Mail).
   - Monospace font stack (`JetBrains Mono`, `SF Mono`, `Menlo`, `Consolas`) applied to tracking numbers.

4. **Package Dimension Optimization (PR #8)**:
   - Package dimensions sent on every Delhivery shipment to minimize logistics freight charges:
     - Single item: `22 × 20 × 3 cm`
     - Multi item (2+ unique lines): `22 × 20 × 5 cm`
     - Declared weight: `500 g` (caps freight at base slab).

5. **Cloud Document Mirroring (PR #5)**:
   - Added `delhivery-document-fetcher.service.ts` to automatically fetch and archive Delhivery POD images, QC sorter images, and shipping labels directly to Firebase Storage (`shipments/<waybill>/...`).

6. **Floating Bulk-Action Toolbar (PR #7)**:
   - Redesigned the floating bulk action bar on `/orders` with clean visual hierarchy, clear selection counts, and streamlined dispatch/label actions.

7. **End-to-End HTTPS & Security (PR #3)**:
   - Server-side and client-side 301 HTTPS redirects, `upgrade-insecure-requests` CSP header, and strict Firebase auth token verification.

8. **External Fulfillment Sync, Live Delhivery Tracking & Direct Label/Invoice Downloads**:
   - Ingests fulfillments executed externally (on Shopify admin, 3PL, etc.) and immediately triggers live tracking sync with Delhivery API.
   - Added rich "Live Delhivery Tracking & Parcel Journey" UI panel with 5-stage transit stepper, live telemetry refresh, and scan events.
   - Direct download shipping labels as files without opening a new tab.
   - Combined single & bulk download/print sequenced strictly as: Order 1 Label -> Order 1 Invoice -> Order 2 Label -> Order 2 Invoice...
   - Filled official Delhivery requirement documents (`Scan Push`, `EPOD`, `QC Image`, `Sorter Image`) for `fa5d92-VBEXPORT-do` (V B EXPORT).

---

## 4. Key Configuration & Guardrails

| Setting | Value / Policy | Purpose |
|---|---|---|
| `ORDER_SYNC_START_DATE` | `2026-09-25` | Orders prior to 2026-09-25 are strictly excluded from automated sync and dispatch. |
| `DELHIVERY_LABEL_SIZE` | `4R` (4" x 6") | Standard thermal label size for warehouse label printers. |
| `src/index.ts` import | `import './app';` | Must remain a side-effect import to prevent TypeScript compiler from eliding the server boot. |
| `PRISMA_DB_PUSH` | Automated in CI/CD | Additive schema migrations execute automatically prior to building. |

---

## 5. Verification Commands

```bash
# Run full Vitest suite (38 tests)
cmd.exe /c "npm test"

# Build backend (TypeScript)
cmd.exe /c "npm run build"

# Build frontend (Vite)
cmd.exe /c "cd frontend && npm run build"
```
