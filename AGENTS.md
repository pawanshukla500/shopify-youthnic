# Shopify Youthnic OMS — Agent Engineering Guide & Knowledge Base

> **TaskFlow Pro Project**: `Shopify Youthnic OMS`  
> **TaskFlow Project ID**: `a7f820cb-4885-486d-92d2-c8e4a63054f4`  
> **Repository**: `pawanshukla500/shopify-youthnic` (Branch: `main`)  
> **Last Verified**: 2026-09-27  

---

## 1. Operating Rules for AI Agents

1. **TaskFlow Pro Synchronization**:
   - At the beginning of any coding or architectural work, call `sync_coding_work` with project name `"Shopify Youthnic OMS"` and a descriptive task title.
   - Keep calling `sync_coding_work` with `task_id` and `progress_note` as milestones are reached (`in_progress` → `in_review` → `done`).
   - Active tracking URL: `https://task.youthnic.shop/my-tasks?task=164ba233-9b5f-4c14-bc34-066cef4300fc`

2. **Command Execution in Windows PowerShell**:
   - Running `.ps1` scripts directly may be restricted by system execution policy. Always invoke node commands via `cmd.exe /c "npm test"`, `cmd.exe /c "npm run build"`, etc.
   - Avoid PowerShell pipeline redirection typos like `> $null` which creates a literal file named `$null`.

3. **Verification Before Committing**:
   - All unit and integration tests must pass: `cmd.exe /c "npm test"` (Vitest suite, 221 passing tests across 28 test files).
   - Backend TypeScript build must compile cleanly: `cmd.exe /c "npm run build"`.
   - Frontend Vite bundle must build cleanly: `cmd.exe /c "cd frontend && npm run build"`.

---

## 2. System Architecture & Tech Stack

```
                              ┌──────────────────────────────────────────────┐
                              │           Shopify Store (Youthnic)           │
                              │         youthnic2024.myshopify.com           │
                              └──────────────────────┬───────────────────────┘
                                                     │ Webhooks & Admin API (2026-09-25+ cutoff)
                                                     ▼
┌────────────────────────┐    ┌──────────────────────────────────────────────┐    ┌────────────────────────┐
│     Admin Frontend     │◄──►│             Express.js / Node.js             │◄──►│     Delhivery B2C      │
│  React + Vite + TW v4  │    │            TypeScript Backend                │    │ Express Logistics API  │
│  Port 5173 (Prod CDN)  │    │                Port 3000                     │    │ (Labels, AWB, NDR, QC) │
└────────────────────────┘    └──────────────┬────────────────┬──────────────┘    └────────────────────────┘
                                             │                │
                                             ▼                ▼
                              ┌─────────────────────┐  ┌─────────────────────┐
                              │   PostgreSQL 17     │  │   Firebase Storage  │
                              │ (Hostinger VPS /    │  │  & Resend Email     │
                              │  Prisma 5.22 ORM)   │  │  (POD/Labels/Logo)  │
                              └─────────────────────┘  └─────────────────────┘
```

- **Backend**: Node.js 20+, Express, TypeScript, Prisma ORM (`prisma/schema.prisma`), PostgreSQL 17.
- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4, Lucide icons (`frontend/`).
- **Logistics**: Delhivery Express B2C API (`src/modules/delhivery/`), custom shipping label renderer, document fetcher.
- **E-Commerce**: Shopify Dev Dashboard App (OAuth client credentials grant, automated token caching & renewal).
- **Communication & Storage**: Resend transactional emails (`src/modules/email/`), Firebase Admin SDK & Cloud Storage bucket (`src/modules/firebase/`).

---

## 3. Strict Invariants & Non-Negotiable Rules

### A. Strict Date Cutoff (25-09-2026)
- **Rule**: Only orders created on or after **`2026-09-25`** are synchronized, processed, or dispatched.
- **Rationale**: Historical orders before this date belong to prior operational workflows and must never be auto-dispatched or altered.
- **Guarded in**: `order.service.ts`, `shopify.service.ts`, and API sync endpoints.

### B. Side-Effect Import in `src/index.ts`
- **Rule**: `src/index.ts` must use side-effect import `import './app';`.
- **Warning**: Do NOT change to `import app from './app'` or TypeScript compiler tree-shaking will eliminate the import and the Node process will terminate immediately with code 0.

### C. Dispatch State Transition (PR #11)
- When a Delhivery AWB is generated:
  - The order status must be promoted from `DISPATCH_PENDING` / `NEW` to **`DISPATCHED`**.
  - The shipment status must be promoted to **`CREATED`** with `trackingStatus: 'Label generated'` (awaiting pickup). Pickup counting and Shopify cancels depend on `CREATED`; the enum has no `AWB_ASSIGNED`.
  - An audit timestamp **`dispatchedAt`** is written to the order.
  - The tracking cron polls `PENDING`, `CREATED`, and `IN_TRANSIT` shipments so tracking updates flow continuously.
- `dispatchOrder` is the only path to Delhivery (single, bulk, and the `/orders/sync` auto-dispatch) and enforces, on the server:
  - **Approval**: prepaid, or COD with `COD_CONFIRMED` / Low RTO (`isApprovedForDispatch`). Unconfirmed COD is rejected.
  - **Cutoff**: orders created before `ORDER_SYNC_START_DATE` are rejected.
  - **No second AWB**: an order whose shipment has a live waybill (not `ERROR`/`CANCELLED`) is rejected.
  - **Atomic claim**: `Order.dispatchLockedAt` is claimed with a conditional `updateMany` before the manifest call and released afterwards (stale after 5 min), so double clicks and concurrent callers cannot book two AWBs.

### D. Delhivery Package Dimensions & Freight Slab (PR #8)
- Every shipment creation request sends explicit package dimensions to prevent courier overcharging:
  - **Single item**: `22 × 20 × 3 cm`
  - **Multi item (2+ unique lines)**: `22 × 20 × 5 cm`
  - **Declared weight**: `500 g` (capped under Delhivery's 500g threshold to maintain base tier).
  - Configurable via environment variables in `src/config/index.ts`.

### E. Shipping Label Standards (PR #4, #6, #12)
- **Dimensions**: Thermal 4R (`4 in × 6 in` / `100 mm × 150 mm`).
- **Official PDF & Multi-shape Extraction**: The system queries Delhivery's packaging label API and handles multiple response shapes (`packages_found` array, `packages` object, or root URL).
- **HTML Fallback**: If Delhivery's external PDF URL returns 404 or fails, the backend renders a pixel-perfect, thermal-ready HTML printable label containing the authentic layout, barcodes, routing code, and the horizontal Youthnic logo.

### F. Brand Identity & Email Notifications (PR #8, #9, #10)
- Sender badges must be clean, lowercase email identities (`delivery@youthnic.com`, `returns@youthnic.com`, `refunds@youthnic.com`, `support@youthnic.com`).
- The Youthnic logo is hosted on Firebase Storage (`https://storage.googleapis.com/.../public/youthnic-logo.png`) rather than inline base64 to ensure universal rendering across Outlook desktop, Apple Mail, and Gmail.
- AWB tracking numbers use a clean monospace font stack (`JetBrains Mono`, `SF Mono`, `Menlo`, `Consolas`).

### G. Database Schema & Deployment (Commit `3829719`, revised)
- `deploy.yml` runs `npx prisma db push` **after** tests and both builds pass, and before the container is replaced, so a red build never changes the production schema under the running release.
- Additive changes (new nullable or defaulted columns, indexes, tables) apply on every push to `main`.
- A change Prisma flags as data loss (dropping a column/table, adding a unique constraint) stops the deploy. Re-run the workflow manually (`workflow_dispatch`) with **allow_data_loss** checked once that change is intended. Prefer additive schema changes.

### H. Alternating Label + Invoice Sequence (PR #13)
- When generating combined shipping and invoice documents (single or bulk), pages must strictly follow the alternating sequence:
  $$\text{Order 1 Label} \longrightarrow \text{Order 1 Invoice} \longrightarrow \text{Order 2 Label} \longrightarrow \text{Order 2 Invoice} \dots$$
- Never output all labels followed by all invoices.
- Each label must be styled for thermal 4R (`100mm × 150mm`) and each invoice for A4 portrait, separated by explicit CSS page breaks (`page-break-after: always; break-after: page;`).

### I. Direct Shipping Label Download (PR #13)
- Direct label download endpoints (`GET /api/orders/:id/label/download` and `POST /api/orders/bulk-labels/download`) must return headers with `Content-Disposition: attachment; filename="delhivery-label-<waybill>.pdf"` (or `.html`) to trigger immediate browser file download without opening a new tab.

### J. External Fulfillment Telemetry Sync (PR #13)
- External fulfillments (from Shopify Admin, Delhivery One, or 3PL) ingested via `fulfillments/create` or `fulfillments/update` webhooks must immediately trigger live tracking from the Delhivery tracking API in the background (`trackingService.syncShipmentTracking`).
- Live tracking telemetry is exposed in real-time via `POST /api/orders/:id/track` and `POST /api/tracking/:waybill/sync`.

### K. Refunds Move Money Exactly Once
- Return refunds (`returnService.processRefund`) refund **only the returned items**, at the amount Shopify's `refunds/calculate` returns (discounts and taxes applied). Shipping is refunded only when QC fully approved a return of every unit. `PARTIAL` QC refunds without shipping and with `no_restock`.
- A refund is claimed atomically (`refundStatus` NONE/FAILED → PENDING via `updateMany`) before Shopify is called, and carries an idempotency key in the Shopify refund note (`[oms-return-<id>]`, `[oms-rto-<orderId>]`). `createRefund` adopts an existing refund with the same key instead of refunding again.
- Once Shopify accepted a refund, OMS bookkeeping errors are logged and never mark it `FAILED`. The hourly retry only retries QC-passed returns, keeps their QC result, and stops at `Return.refundAttempts` = 5.
- A rescan of a scanned-in refunded return, or of one whose refund is pending, throws; it never refunds again. A return refunded before it arrived (direct full refund) is still scanned in: receipt and QC are recorded, no refund is issued. A refund claim left `PENDING` for 30+ minutes (dead process) is reset to `FAILED` and retried; the idempotency key adopts any refund Shopify already made.
- A direct refund from the order page: a partial (goodwill) amount is money only, leaves the order status and any open return alone, and sets `financialStatus: partially_refunded`. A full refund closes the open return and restocks only when that return is bringing the items back.
- `createRefund` reports `moneyMoved: false` when the order has no captured online payment (COD). Then no "refund processed" message or email is sent, and the return records that the customer must be paid by hand.
- RTO auto-refunds (`orderService.processRtoRefund`) run only for an order that was never delivered, only after Delhivery's authenticated tracking API confirms `RTO_DELIVERED`, and never on a partially refunded or voided order. A prepaid order cancelled after pickup still gets its RTO refund (Shopify's cancel does not refund it); the carrier lock routes that one case to `processRtoRefund` (`needsRtoRefundAfterCancel`). Failures set `supportFlag` `RTO_REFUND_FAILED` (retried hourly, 5 attempts) or `RTO_REFUND_REVIEW` (needs a person).

### L. Carrier Updates (Delhivery webhooks + tracking cron)
- Shared rules live in `src/modules/orders/order-lifecycle.ts`; the webhook and the cron must use them, not their own copies.
- The scan/EPOD webhooks may be called without a secret. Terminal statuses they push (`DELIVERED`, `RTO_DELIVERED`, `CANCELLED`) are applied only after `confirmTerminalStatus` re-reads the AWB from Delhivery's tracking API; unconfirmed claims are dropped entirely. EPOD lookups never use the internal numeric order id.
- A pushed scan older than the newest one in `trackingHistory` is history only and never moves status. `DELIVERED` and `RTO_DELIVERED` are final for pushes.
- Status changes use a conditional `updateMany` on the previously read status; the order transition and customer message run only for the writer that changed it.
- An empty / `UNKNOWN` Delhivery answer for a live shipment changes nothing.
- Cancelled, refunded and returned orders (`CARRIER_LOCKED_ORDER_STATUSES`) are not moved or messaged by carrier updates; a moving parcel on a cancelled/refunded order sets `supportFlag` `PARCEL_MOVING_ON_CLOSED_ORDER`.
- Delivery stamps `Order.deliveredAt` and marks COD collected in the same write on both paths.
- A Delhivery cancel is recorded only when Delhivery accepted it (`orderService.cancelLiveShipment`); a refusal keeps the shipment tracked and flags `DELHIVERY_CANCEL_FAILED`.

### M. Shopify Sync Must Not Corrupt Stored Orders
- A payload whose `updated_at` is older than the stored `shopifyUpdatedAt` is skipped.
- `RETURN_REQUESTED`, `RETURN_DISPATCHED`, `RETURN_RECEIVED` and `REFUNDED` are owned by the OMS; Shopify sync never overwrites them.
- Line items match on Shopify variant id (title only for rows without one, never the same row twice), so different sizes of one product stay separate rows. Refunds match lines with `matchShopifyLineItem` (variant → SKU → title + variant title).
- `customerAddress` joins `address1` and `address2`; `customerName` is the shipping-address (consignee) name.
- A Shopify webhook id is released when processing fails, so Shopify's retry is processed instead of deduplicated.

---

## 4. Summary of Recent Agent Developments (PR #1 to PR #13)

| PR / Commit | Component | Summary of Implementation |
|---|---|---|
| **PR #1** (`a65d8e5`) | Orders & API | Channel order ingestion, authenticated label and invoice download endpoints, UI status badges. |
| **PR #2** (`62cdc64`) | Delhivery & Shopify | Linked Delhivery One `youthnic2024` channel, canceled premature fulfillments, hardened 25-Sep cutoff. |
| **PR #3** (`9fead8c`) | Security | Enforced end-to-end HTTPS, 301 redirects on client/server, CSP `upgrade-insecure-requests`, strict Firebase token auth. |
| **PR #4** (`c147bf8`) | Labels & Manifest | Integrated horizontal Youthnic logo on shipping label, authentic Delhivery 4R layout, official PDF fetch, and manifest validation. |
| **PR #5** (`a252037`) | Cloud Storage & CI | Mirrored POD, QC sorter images, and labels to Firebase Storage; implemented Delhivery Document Fetcher service; added Vitest test suite and GitHub Actions PR workflow. |
| **PR #6** (`a077343`) | Label Testing | Pinned shipping label size to thermal 4R (4" x 6") with dedicated unit tests and Vitest mock setup. |
| **Deploy** (`3829719`) | CI/CD Deploy | Added `prisma db push` step in `.github/workflows/deploy.yml` before build to eliminate database drift. |
| **PR #7** (`684adca`) | Frontend UX | Overhauled the floating bulk-action toolbar in Orders page with clear visual hierarchy, active counters, and modern buttons. |
| **PR #8** (`2278035`) | Brand & Logistics | Rebranded email templates with Youthnic design; optimized package dimensions (22x20x3cm / 22x20x5cm @ 500g). |
| **PR #9** (`e51ec4e`) | Email Assets | Hosted Youthnic logo on Firebase Storage at `public/youthnic-logo.png` to fix Outlook base64 image dropping. |
| **PR #10** (`832bc2d`) | Email Migration | Completed email brand migration; standardized all template sender badges to lowercase; unified dynamic `fromEmail` config. |
| **PR #11** (`048d2ec`) | Dispatch State Machine | Promoted orders and shipments out of `DISPATCH_PENDING` upon AWB generation; added `dispatchedAt` audit timestamp; updated tracking cron to poll pending shipments. |
| **PR #12** (`4d74b4b`) | Label Resiliency | Added multi-shape PDF extraction for Delhivery label API responses and an HTML printable fallback for 404 resilience. |
| **PR #13** (`cc00eb2`) | External Sync, Live Tracking & Alternating Labels | External fulfillment sync via Shopify webhooks, live Delhivery tracking transit stepper UI layout, direct label downloads without new tabs, alternating "Label then Invoice" bulk generator, and official Delhivery webhook specs. |

---

## 5. Development & Testing Commands

```bash
# 1. Run all Vitest unit tests (221 tests across 28 test files)
cmd.exe /c "npm test"

# 2. Typecheck and build backend
cmd.exe /c "npm run build"

# 3. Typecheck and build frontend
cmd.exe /c "cd frontend && npm run build"

# 4. Sync Prisma schema to database (dev/staging)
npx prisma db push

# 5. Run backend development server (Port 3000)
cmd.exe /c "npm run dev"

# 6. Run frontend development server (Port 5173)
cmd.exe /c "cd frontend && npm run dev"
```
