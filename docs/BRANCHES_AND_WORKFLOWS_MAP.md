# Shopify Youthnic OMS — Git Branches & Workflows Architecture Map

This document maps all branches, PRs, subsystems, and working implementations across the Shopify Youthnic Order Management System (OMS). It serves as the primary system registry and graphify knowledge source for agents and developers.

---

## 1. Subsystem Architecture Overview

The system is organized into five major integrated domains:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Shopify Youthnic OMS                            │
├─────────────────────┬────────────────────┬─────────────────────────────┤
│ 1. Accounts & Tally │ 2. Returns & QC    │ 3. Multi-Carrier Logistics  │
│    - Double-Entry   │    - Barcode Scan  │    - Velocity Shipping      │
│    - Dynamic GST    │    - Auto-Refund   │    - Delhivery B2C          │
│    - Bank 3-Way Rec │    - COD Manual    │    - 4x6 Thermal Invoices   │
│    - Tally XML      │    - WhatsApp Ekta │    - GSTIN 24AERPB8666E1ZB  │
├─────────────────────┴────────────────────┴─────────────────────────────┤
│ 4. Analytics & Workflows                 │ 5. Core Order Lifecycle     │
│    - RFM Customer Segments               │    - Sidebar Workflow Trees │
│    - Report Distribution Agent           │    - Order Money Cards      │
│    - Executive Digests                   │    - KwikEngage WhatsApp    │
└──────────────────────────────────────────┴─────────────────────────────┘
```

---

## 2. Detailed Branch Registry & Implementation History

### Domain A: Accounts, Financial Ledger & Tally Integration

#### `feature/accounting-financial-ledger-tally-and-graphify` (PR #88)
- **Status:** Active / Pushed (Latest commit: `3239b36`)
- **Key Modules:**
  - `src/modules/accounts/ledger.service.ts`: Full double-entry financial ledger enforcing `Debits == Credits`. Tracks Sales Invoices, Credit Notes, Gateway Settlement debits/credits, COD Remittances, Freight Invoices, and Bank Receipts.
  - `src/modules/accounts/gst-engine.service.ts`: Dynamic multi-rate GST engine (5%, 12%, 18%) calculating IGST, CGST, SGST from order line items. Removes legacy hardcoded 18% assumption.
  - `src/modules/accounts/bank-reconciliation.service.ts`: 3-way automated matching engine reconciling Orders, Gateway Settlements (GoKwik, Easebuzz, PhonePe), and Bank Statement UTRs (supports ICICI, HDFC, SBI, Kotak statement formats).
  - `src/modules/accounts/tally-xml.service.ts`: Native Tally ERP 9 / TallyPrime XML export for Sales, Credit Notes, Gateway Expenses, Freight Expenses, and Bank Receipts.
  - `src/modules/accounts/monthly-closing.service.ts`: Monthly accounting period finalization with `CLOSED` period locks preventing retro-modifications.
  - `src/modules/accounts/freight-engine.service.ts`: Freight expense deduplication engine tracking forward, RTO, reverse pickup, COD charges, and weight adjustments across Delhivery and Velocity.
  - `.agents/rules/graphify.md` & `.agents/skills/graphify/`: Installed and verified Graphify knowledge graph engine.

#### `feature/tally-carry-forward-and-voucher-engine` (PR #85)
- **Status:** Merged
- **Key Features:** 8-sheet Excel accounting voucher workbook, Indian state POS code mappings, and carry-forward ledger balances.

#### `feature/tally-state-monthly-accounts-report` (PR #84)
- **Status:** Merged
- **Key Features:** State-wise sales, returns, and net revenue matrix with contribution analysis and Excel export formulas.

#### `fix/gokwik-settlement-refund-reconciliation` (PR #82)
- **Status:** Merged
- **Key Features:** GoKwik & Easebuzz payment gateway fee deduplication, MDR separation, refund debit tracking, and 3-way settlement UTR reconciliation.

#### `fix/order-money-card-net-bank-breakdown` (PR #81)
- **Status:** Merged
- **Key Features:** `OrderMoneyCard` in order detail displaying gross sales, discount, customer collected amount, gateway fees + GST, and final net bank credit.

---

### Domain B: Returns, QC & Refund Automation

#### `feature/return-scan-auto-refund-ekta-whatsapp` (PR #86) & `fix/whatsapp-ekta-dedup-and-test-guard` (PR #87)
- **Status:** Merged to `main`
- **Key Modules:**
  - `src/modules/returns/return-scanner.service.ts`: Physical warehouse barcode scanning endpoint (`POST /api/returns/scan`). Automatically validates return waybills and updates status to `RECEIVED`.
  - `src/modules/returns/refund-processor.service.ts`: Automated refund engine for prepaid orders. Calculates exact pro-rated item prices, line item taxes, and issues Shopify refund via GraphQL Admin API.
  - `src/modules/whatsapp/ekta-notifier.service.ts`: Instant WhatsApp notification dispatched to Ekta (`Ekta Bhayani 918866077404@s.whatsapp.net`) on successful refund.
  - Duplicate notification guard & test environment mock guard preventing live WhatsApp sends during automated CI/tests.

#### Exchange Order Invariant (`exchange_order` & `main` commit `5dad0e1`)
- **Critical Business Invariant:**
  - Exchange orders (identified by `isExchange` flag, order note tags `EXCHANGE`, `replacement_order`, or exchange line item metadata) **MUST NEVER** be refunded automatically or queued for refund.
  - Orders like `26YOU5987`, `26YOU5991`, `26YOU6063`, `26YOU6104`, `26YOU6128` are exchange orders and are strictly guarded from refund queues.

#### `feat/cod-manual-refund-and-single-refund-guard` & `docs/COD_MANUAL_REFUND_AND_REVERSE_LOGISTICS_SPEC.md`
- **Status:** Active in core returns flow
- **Key Features:**
  - Manual COD refund queue: When a COD return is scanned, it moves to `NEEDS_MANUAL_REFUND`.
  - Finance operator must provide Bank UTR / Transaction Reference and upload a screenshot proof.
  - Concurrency lock and single-refund guard preventing double payout.

---

### Domain C: Multi-Carrier Shipping & Logistics

#### `feat/velocity-tracking-thermal-labels-ponytail` (PR #54), `velocityshipping`, & `velocity_return_support`
- **Status:** Primary courier in production
- **Key Modules:**
  - `src/modules/shipping/velocity.service.ts`: Multi-carrier aggregator integrating Bluedart, Ekart, Amazon Shipping, and Shadowfax.
  - Automated COD remittance polling, bank UTR mapping, and carrier fee ledger sync.
  - `4x6 Thermal GST Tax Invoice`: Formatted for thermal label printers (4x6 inch) with registered GSTIN `24AERPB8666E1ZB`.
  - Standardized customer tracking URLs (`https://youthnic.com/track?awb=...`).

#### `feat/delhivery-delay-watchlist` & `delhivery`
- **Status:** Secondary courier / Watchlist monitoring
- **Key Modules:**
  - `src/modules/shipping/delhivery.service.ts`: Delhivery B2C Surface/Express logistics.
  - Reverse pickup booking and electronic proof of delivery (`ePOD`) download.
  - SLA monitoring and delay watchlist tracking for in-transit shipments.
  - Delhivery B2C Miles wallet ledger balance tracking.

---

### Domain D: Analytics, Workflows & Customer Engagement

#### `feature/analytics-reporter-account-strategist-distribution` (PR #83)
- **Status:** Merged
- **Key Modules:**
  - Executive KPI digests (Gross Sales, Return Rates, RTO %, Gateway Fees, Net Profit).
  - RFM customer segmentation (Recency, Frequency, Monetary value).
  - Territorial sales report distribution automation.

#### `feat_workflow_trees_and_sidebar_mapping` (PR #80)
- **Status:** Merged
- **Key Features:**
  - Interactive SVG workflow trees in the application sidebar.
  - Real-time queue counters (Pending Dispatch, In Transit, Out for Delivery, Return In Progress, QC Pending, Refund Needed).
  - Deep-link navigation into filtered views.

#### `kwikengage`
- **Status:** Production
- **Key Features:**
  - Automated WhatsApp delivery coordination, OTP verification for COD orders, and delivery status updates.

---

## 3. Key Invariants & Policies for Future Agents

1. **GSTIN Number:**
   - Always use `24AERPB8666E1ZB` (VB Exports / Youthnic). Never use placeholder `24AAFFV1234P1Z8`.
2. **Double-Entry Ledger:**
   - Every financial voucher must have balanced debits and credits (`sum(debits) == sum(credits)`).
3. **Exchange Orders Guard:**
   - Any order marked with `isExchange: true` or tagged `EXCHANGE` must never have automated refunds initiated.
4. **Gateway Deduplication:**
   - GoKwik and Easebuzz share transactions: GoKwik handles checkout aggregation; Easebuzz handles pg processing. Never double-book MDR charges.
5. **Carrier Distinction:**
   - Keep Delhivery direct shipments separate from Velocity aggregator shipments (which may use underlying Bluedart/Ekart/Delhivery legs).
6. **Graphify Rule:**
   - Always keep the knowledge graph updated after modifying code using `graphify update .`.
