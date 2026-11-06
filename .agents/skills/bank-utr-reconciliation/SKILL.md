---
name: bank-utr-reconciliation
description: "Reconcile bank statements against payment settlements, COD remittances, multi-order UTR allocation, and verification statuses."
compatibility: Claude Code, Antigravity, Cursor
metadata:
  author: Youthnic Accounting & Compliance
---

# Bank & UTR Reconciliation Skill (`bank-utr-reconciliation`)

## 1. Purpose & Invocation Criteria
Use this skill when uploading and reconciling bank statements (HDFC, ICICI, SBI) against gateway settlements and courier COD remittances.

## 2. Bank Verification Standard
**STRICT ACCOUNTING RULE:**
- An order or settlement is **NEVER** marked `VERIFIED` simply because a UTR string appears in an uploaded gateway report.
- Verification requires an exact or within-tolerance match against an actual incoming bank credit transaction row on an official bank statement.

## 3. Reconciliation Status Taxonomy
- **`VERIFIED`**: Exact match between bank credit amount, UTR, and settlement batch net amount.
- **`PENDING_BANK_EVIDENCE`**: Settlement batch recorded in OMS, but bank statement for that date has not been uploaded yet.
- **`PARTIALLY_MATCHED`**: Bank credit matches UTR, but only a subset of orders are confirmed.
- **`AMOUNT_MISMATCH`**: Bank credit matches UTR, but the rupee amount differs beyond the ₹1.00 tolerance.
- **`DUPLICATE`**: Same UTR credited twice or uploaded in multiple files.
- **`UNMATCHED`**: Bank statement line has no matching settlement batch or COD remittance in OMS.
- **`NEEDS_REVIEW`**: Disputed credit, chargeback deduction, or unusual banking adjustment.

## 4. Multi-Order UTR Allocation Procedure
1. One bank UTR typically settles dozens or hundreds of orders in a single bulk payout.
2. The settlement batch header captures the total bank UTR and aggregate net payout.
3. Once the batch is verified against the bank statement line, all child orders linked to the batch inherit the verified status with `paymentVerified = true` and `paymentVerifiedAt = statement.transactionDate`.
