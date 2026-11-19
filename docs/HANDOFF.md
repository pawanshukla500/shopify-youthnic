# Shopify OMS — System Handoff & Operational State

> **Last Verified**: 2026-11-19  
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

8. **External Fulfillment Sync, Live Delhivery Tracking & Direct Label/Invoice Downloads (PR #13)**:
   - Ingests fulfillments executed externally (on Shopify admin, 3PL, etc.) and immediately triggers live tracking sync with Delhivery API in the background.
   - Added rich "Live Delhivery Tracking & Parcel Journey" UI panel with 5-stage transit stepper (`Manifested` → `Picked Up` → `In Transit` → `Out for Delivery` → `Delivered`), live telemetry refresh button, NDR alerts, and scan events timeline.
   - Added direct file download for shipping labels without opening in a new tab (`GET /api/orders/:id/label/download` & `POST /api/orders/bulk-labels/download`).
   - Combined single & bulk download/print sequenced strictly as: **Order 1 Label → Order 1 Invoice → Order 2 Label → Order 2 Invoice...** formatted with thermal 4R and A4 page breaks.
   - Completed all official Delhivery requirement documents (`Scan Push`, `EPOD`, `QC Image`, `Sorter Image`) for profile `fa5d92-VBEXPORT-do` (V B EXPORT) in `C:\Users\Pawan Shukla\Desktop\Delhivery Docs\`.
   - Documented full integration specification in [`docs/DELHIVERY_INTEGRATION_SPEC.md`](DELHIVERY_INTEGRATION_SPEC.md).

9. **Velocity Label Fetch (2026-11-18)**:
   - Velocity `label_url` values are signed S3 links that expire (a 4-week-old one returned 403). `velocityService.fetchOfficialLabelPdf` skips an expired stored link and downloads the freshly signed `tracking_data.label_url` from `POST /custom/api/v1/order-tracking`, then saves it back to `Shipment.labelUrl`.
   - Removed the `order-details` and `shipments` label probes: live, `order-details?awb=` returned 404 and the shipments list has no `label_url`.
   - The label routes no longer redirect to a stale stored link when the fetch fails; they show the "label pending" page (or 404 JSON for downloads).
   - `updateShipmentCourier` clears `labelUrl` instead of storing the tracking-page URL in it (tracking links come from `getTrackingUrl`).
   - Velocity's API has no per-order customer tax invoice (none in its API docs or live responses), so invoices stay generated by `invoice.service.ts`.

10. **Velocity-Style 4x6" Tax Invoice (2026-11-19)**:
   - The invoice now follows the Velocity panel's invoice layout (logo + "Tax Invoice", Invoice/Order meta grid, Shipping Address and From cards, navy item table with Amount / Discount / GST / Amount, Total / Payment Received / Total Payment Due, amount in words), kept at 4x6" (100mm x 150mm) so Label -> Invoice still prints on the thermal printer.
   - `invoiceService.buildInvoiceData` is the single source of invoice numbers for both the HTML invoice and the PDF (`create4x6InvoicePdf`). Order-level discounts are spread across lines by value so the lines add up to the order total; shipping is its own row. Payment status comes from Shopify `financialStatus` (paid / refunded / partially refunded count as received; pending and other unpaid statuses, and COD until Shopify marks it paid, show Rs.0 received and the full amount due).
   - GST stays 5% inclusive with HSN 6204; up to 4 item rows fit, the rest are summarised in one line. The PDF prints "Rs." because the built-in PDF font has no rupee glyph.

11. **Workflow Designer replaces Workflow Trees (2026-11-19)**:
   - `/workflows` is now a node-based designer built on `sequential-workflow-designer` (+ `-react`): drag stages and decisions from the toolbox, edit names, order states, branch names and branch conditions in the side editor, undo/redo, light/dark.
   - The design is saved whole in the `Setting` table under `workflow_designer_definition` via `GET`/`PUT /api/workflows/design` (validated in `src/modules/workflows/workflow-design.ts`; no schema change). Until someone saves, the page shows the seeded default.
   - Order lookup: paste an order name (`#26YOU6590`) or AWB (forward, return or replacement). `GET /api/orders/lookup?q=` returns the exact name/AWB match first, then up to 10 partial hits; `/api/orders?search=` now also matches return and exchange AWBs, case-insensitively. The current stage turns green, the route taken blue, the rest fades, and the order facts and its state tokens show beside the canvas.
   - Mapping lives in `frontend/src/workflow-map.ts`: `orderFacts` turns an order into tokens (`order:`, `tab:`, `payment:`, `shipment:`, `courier:`, `ndr:`, `flow:`, `return:`, `qc:`, `refund:`, `exchange:`); stages list the tokens they stand for, decisions pick a branch by condition, and the furthest matching stage on the route is "current". The seeded design covers every Prisma `OrderStatus` and `ReturnStatus` (checked in `tests/workflow-map.spec.ts`).

---

## 4. Key Configuration & Guardrails

| Setting | Value / Policy | Purpose |
|---|---|---|
| `ORDER_SYNC_START_DATE` | `2026-09-25` | Orders prior to 2026-09-25 are strictly excluded from automated sync and dispatch. |
| `DELHIVERY_LABEL_SIZE` | `4R` (4" x 6") | Standard thermal label size for warehouse label printers. |
| `DELHIVERY_CLIENT_PROFILE` | `fa5d92-VBEXPORT-do` | Domestic Express profile (V B EXPORT) for all B2C surface shipments. |
| `src/index.ts` import | `import './app';` | Must remain a side-effect import to prevent TypeScript compiler from eliding the server boot. |
| `PRISMA_DB_PUSH` | Automated in CI/CD | Additive schema migrations execute automatically prior to building. |

---

## 4a. Agent Tooling (Graphify + Ponytail)

Every agent session uses two core tools. They are wired in so new agents get them without manual setup.

| Tool | What it does | Where it is wired |
|---|---|---|
| **Ponytail** (`DietrichGebert/ponytail`) | Lazy-senior-dev rules: smallest complete change, reuse first, no speculative code, checks for new logic | `AGENTS.md` (rules kept verbatim from upstream); Claude Code plugin `ponytail@ponytail` enabled in `.claude/settings.json` |
| **Graphify** (`graphifyy==0.9.112`) | Code knowledge graph in `graphify-out/` (`graphify query / path / explain`), rebuilt after commit, checkout and merge | Skill in `.claude/skills/graphify/` and `.agents/skills/graphify/`; rules in `AGENTS.md` and `.agents/rules/graphify.md`; Claude PreToolUse hooks in `.claude/settings.json`; git hooks via `graphify hook install` |

- **Bootstrap:** `python scripts/agent_bootstrap.py` runs automatically at Claude Code session start (SessionStart hook). Other agents are told to run it in `AGENTS.md` and `.agents/rules/project-upkeep.md`. It is a fast check that sets up whatever is missing in the background: the pinned Graphify CLI, the git hooks (in the directory git actually uses), and the graph. The log is `.git/agent-bootstrap.log`; `--setup` runs the setup in the foreground. The Claude hooks call Graphify through `--guard`. `--self-test` runs its checks.
- **Upkeep:** after every change, run `graphify update .` and update this file and any doc the change touches (`AGENTS.md` > Project upkeep).
- **Hooks off:** if `"disableAllHooks": true` is set in `~/.claude/settings.json`, the project hooks don't run. Run `python scripts/agent_bootstrap.py --setup` by hand.
- **PR review bot:** CodeAnt AI reviews every pull request automatically (it replaced CodeRabbit on 2026-11-18). To ask for another review after pushing fixes, comment `@codeant-ai review` on the PR. Fix valid findings, reply in each thread, and merge only when CI is green.

---

## 5. Verification Commands

```bash
# Run full Vitest suite (88 tests across 15 test files)
cmd.exe /c "npm test"

# Build backend (TypeScript)
cmd.exe /c "npm run build"

# Build frontend (Vite)
cmd.exe /c "cd frontend && npm run build"
```

