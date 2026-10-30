# COD Manual Refund Workflow & Reverse Logistics Specification

## 1. Overview & Business Objectives

In e-commerce operations, Cash on Delivery (COD) orders present a financial reconciliation risk:
1. **No Online Gateway In Shopify**: Unlike prepaid orders (processed via Razorpay, PhonePe, or Shopify Payments), COD orders do not have an automated refund rails in Shopify. Attempting an automated API refund on a COD order results in a zero-money ledger entry on Shopify while leaving the customer unpaid.
2. **Mandatory Proof of Payout**: COD returns must be settled manually by the finance/accounts team via IMPS, NEFT, or UPI. Every manual payout must be accompanied by non-repudiable audit evidence: either a Bank UTR (Unique Transaction Reference) / Transaction ID or an uploaded payout receipt / screenshot.
3. **Single-Refund Invariant**: Under no circumstance may an order receive more than one refund. If an order has been refunded once (either automatically via payment gateway or manually via bank transfer), all subsequent refund attempts across all endpoints and UI triggers must be strictly blocked.
4. **Exchange vs. Return Separation**: When a customer requests a size exchange (`isExchange === true`), the returned item is inspected at QC to trigger a replacement order dispatch. Monetary refund logic is barred for exchange returns.

---

## 2. Core Architecture & State Machine

### 2.1 Return & Refund Lifecycle

```
Customer Return Initiated
         │
         ▼
  Warehouse Intake
  (Barcode Gun Scan on /returns)
         │
         ├── QC Outcome: REJECTED ──> Mark QC_REJECTED (No Refund)
         │
         └── QC Outcome: APPROVED / PARTIAL
                  │
                  ├── Is Size Exchange? (`isExchange === true`)
                  │         └── Dispatch Size Replacement (Zero Money Refund)
                  │
                  ├── Is Prepaid? (`paymentMethod !== 'COD'`)
                  │         └── Check Single-Refund Invariant
                  │                  └── Auto-Refund via Shopify API
                  │                           └── Mark REFUNDED & PROCESSED
                  │
                  └── Is COD? (`paymentMethod === 'COD'`)
                            └── Mark REFUND_PENDING / PENDING
                                     └── Tag Shopify: COD_MANUAL_REFUND_DUE
                                              │
                                              ▼
                                   Operator Opens Manual Refund Modal
                                   - Validates Bank UTR or Uploads Screenshot
                                   - Enforces Single-Refund Invariant
                                   - Acquires Concurrency Mutex Lock
                                              │
                                              ▼
                                   Audit Record Saved in Account Trail
                                   Order Marked status: REFUNDED, financialStatus: refunded
```

---

## 3. Financial Invariants & Concurrency Safeguards

### 3.1 Single-Refund Invariant
Across all four refund entry points:
- `POST /api/orders/:id/refund`
- `POST /api/orders/:id/refunds/manual`
- `POST /api/returns/:id/refund`
- `POST /api/returns/scan`

The system evaluates:
```typescript
if (order.financialStatus === 'refunded' || order.status === 'REFUNDED') {
  throw new Error(`Order ${order.shopifyOrderName} has already been refunded. Only one refund per order is permitted.`);
}

const priorCompletedRefund = await prisma.accountTrailEvent.findFirst({
  where: {
    orderId,
    eventType: { in: ['REFUND_AUTOMATIC', 'REFUND_MANUAL'] },
    status: 'COMPLETED',
  },
});
if (priorCompletedRefund) {
  throw new Error(`Order ${order.shopifyOrderName} already has a completed refund. Only one refund per order is permitted.`);
}
```

### 3.2 In-Flight Concurrency Mutex
To prevent race conditions caused by operator double-clicking or simultaneous requests from different workstations:
```typescript
const manualRefundsInFlight = new Set<number>();

if (manualRefundsInFlight.has(orderId)) {
  throw new Error('A manual refund for this order is currently being recorded. Please wait.');
}
manualRefundsInFlight.add(orderId);
try {
  // Execute database transaction and audit trail write
} finally {
  manualRefundsInFlight.delete(orderId);
}
```

### 3.3 Proof of Payment Validation
A manual refund payload must supply at least one proof of remittance:
```typescript
const hasUtr = Boolean(externalReference && externalReference.trim());
const hasEvidence = Boolean(evidence && evidence.contentBase64);

if (!hasUtr && !hasEvidence) {
  throw new Error('Payment proof is required. Please provide either a Payment Reference Number (Bank UTR / Txn ID) or upload a payout screenshot.');
}
```

---

## 4. UI/UX Reverse Logistics Workspace (`/returns`)

The `/returns` workspace has been modernized with:
1. **Interactive 5-Metric Ribbon**:
   - `Total Returns`: Complete reverse logistics count.
   - `Pending QC`: Returns awaiting warehouse package inspection.
   - `COD Refund Due` *(Amber Highlight)*: Identifies COD returns that passed QC and need cash payout.
   - `Size Exchanges` *(Purple Theme)*: Replacements without money movement.
   - `Settled / Refunded` *(Green Theme)*: Fully resolved return cases.
   - *Clicking any card acts as a quick-filter toggle.*
2. **Category Quick-Filter Tabs**:
   - Tab strip (`All Returns`, `COD Refund Due`, `Size Exchanges`, `Pending QC`, `Settled / Refunded`) with live counts.
3. **Hands-Free Warehouse Scanner Intake**:
   - Waybill input listener triggers submission when the warehouse barcode gun sends `Enter` keypress.
4. **Action Routing**:
   - COD orders waiting for payout feature a high-contrast amber button: `Record COD Refund` (triggers `ManualRefundModal`).
   - Prepaid orders display `Shopify Auto-Refund`.
   - Size exchange orders display `Size Replacement`.
   - Settled orders display `✓ Settled`.

---

## 5. Verification & Test Coverage

- **Unit & Integration Suite (`vitest`)**:
  - `tests/manual-refund-and-awb-reroute.spec.ts`
  - `tests/refund-safety.spec.ts`
  - `tests/account-trail.spec.ts`
  - `tests/exchange-orders.spec.ts`
  - `tests/return-scan.spec.ts`
- **Playwright Browser End-to-End Suite**:
  - `tests/browser/order_workspace.py`
  - `tests/browser/returns_workspace.py`
