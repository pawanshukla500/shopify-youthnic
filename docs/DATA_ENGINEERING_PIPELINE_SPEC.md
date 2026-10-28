# Youthnic OMS - Data Engineering Pipeline Specification

**Owner:** Data Engineering Team (`agency-data-engineer`)  
**Scope:** Medallion Data Architecture (Bronze -> Silver -> Gold), Conformed Dimensions, Data Contracts, Quality Scoring & Reconciliation Pipelines.

---

## 1. Overview & Architecture

Youthnic OMS implements a strict Medallion Architecture pattern for processing high-velocity multi-channel ecommerce orders, courier logistics events, payment gateway settlements, and COD remittances:

```
┌─────────────────────────────────────────────────────────────┐
│                        BRONZE LAYER                         │
│  - Ephemeral in-memory streaming ingestion (Excel, CSV, ZIP) │
│  - Raw telemetry audit store: TrackingLog                   │
│  - Real-time webhook & event queues                         │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                        SILVER LAYER                         │
│  - Conformed typed entities: Order, Shipment, Return        │
│  - Financial transaction ledger: AccountTrailEvent          │
│  - In-batch deduplication & database idempotency guards      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                         GOLD LAYER                          │
│  - Analytical monthly closing & accounts status marts       │
│  - SLA-backed settlement & remittance summaries             │
│  - Automated Data Quality scoring contract (Health/Anomaly) │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Ingestion & Storage Architecture (Bronze Layer)

### 2.1 Ephemeral In-Memory Streaming
- **Zero Raw File Disk Spills:** Ingestion processes (courier remittance sheets, payment gateway settlement files, zip bundles) stream directly through `streamZipEntry` and `ExcelJS` streaming readers. Raw files are not retained on disk to preserve disk space and ensure customer PII security.
- **Audit Logging:** Every raw status transition, webhook receipt, and courier polling response is logged to the `TrackingLog` table with timestamped raw payloads.

---

## 3. Conformed Dimension & Contract Layer (Silver Layer)

### 3.1 Idempotency & Concurrency Controls
1. **Batch In-Memory Deduplication (`seenInBatch`):**
   - High-throughput spreadsheets frequently contain duplicate rows or repeated AWBs.
   - `reconciliation.service.ts` tracks AWBs in a set per transaction batch. Duplicate rows within the same upload are counted under `skippedDuplicates` without double-mutating shipments.
2. **Database Idempotency Guards:**
   - Once a shipment is marked `codRemitted = true` with a positive `codRemittedAmount`, subsequent imports do not overwrite with null or lower values unless an explicit re-settlement transaction is authorized.
3. **Bi-directional Courier State Synchronization:**
   - Reverse shipments and size exchanges follow an explicit rank-ordered state machine (`orderStatusForReturn` in `return-tracking.ts`).
   - If a courier cancels a reverse pickup (`CANCELLED`), an order previously marked `EXCHANGE_REQUESTED` reverts to `DELIVERED` safely without human intervention.

---

## 4. Analytical Data Marts (Gold Layer)

### 4.1 Schema Evolution & Status Synchronization
Whenever the database schema evolves (such as adding `EXCHANGE_REQUESTED` or new courier channels like Velocity / Delhivery), all downstream analytical layers must be synchronized:
- `accounts-report.service.ts`: `STATUS_LABELS` explicitly recognizes `EXCHANGE_REQUESTED: 'Exchange requested'`.
- `accounts.service.ts`: `backfillDeliveredAt` maintenance sweeps include `EXCHANGE_REQUESTED` to avoid missing delivered-date dimensions.
- `order-tabs.ts`: Active size exchanges are categorized under `Exchange in progress` (distinct from refund returns `Return in progress`) so financial books do not conflate merchandise replacement with cash refund liability.

---

## 5. Automated Data Quality (DQ) Scoring Contract

Every settlement and remittance file imported into the system generates an audit record in `ReconciliationImport` with an embedded Data Quality contract:

```typescript
export interface DataQualitySummary {
  scorePercentage: number;  // (matchedRows / totalRows) * 100 rounded to 1 decimal
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  skippedDuplicates: number;
  hasAnomalies: boolean;     // true if unmatchedRows > 0
  status: 'HEALTHY' | 'WARNING' | 'CRITICAL';
}
```

### 5.1 Status Thresholds
| Status | Threshold | Operational Response |
|---|---|---|
| `HEALTHY` | `scorePercentage >= 95%` | Batch approved automatically for reconciliation. |
| `WARNING` | `80% <= scorePercentage < 95%` | Batch accepted; review flagged in Accounts ledger. |
| `CRITICAL` | `scorePercentage < 80%` | Batch requires manual verification by Finance before disbursement. |

---

## 6. Observability, Maintenance & SLAs

1. **Continuous Verification:**
   - Test suite `tests/data-engineer-pipeline.spec.ts` verifies:
     - Bronze-to-Silver stream deduplication
     - Database idempotency checks
     - Data quality score precision and status transitions
     - Gold layer status label parity
     - Exchange state transitions and cancellations
2. **Automated Maintenance Jobs:**
   - `backfillDeliveredAt` cron cleanses historical orders where courier delivery occurred without triggering a Shopify webhook.
   - `backfillMissingRefundTrailEvents` ensures double-entry parity for all settled returns.
