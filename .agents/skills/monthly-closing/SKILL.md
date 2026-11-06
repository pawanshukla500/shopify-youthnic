---
name: monthly-closing
description: "End-of-month financial closing procedures, cutoff rules, carry-forward balance reconciliation, and immutable snapshot generation."
compatibility: Claude Code, Antigravity, Cursor
metadata:
  author: Youthnic Accounting & Compliance
---

# Monthly Closing Skill (`monthly-closing`)

## 1. Purpose & Invocation Criteria
Use this skill on the 10th of every month (or during manual month-end closing) to execute the formal financial closing pipeline for the previous calendar month.

**Schedule:** 10th of each month, 09:00 AM Asia/Kolkata.

## 2. Timing & Cutoff Invariants
**Crucial Accounting Principle:**
- **Sales Revenue & Output Taxes**: Attributed to the accounting period of the order's creation date (`shopifyCreatedAt`).
- **Returns & Credit Notes**: Attributed to the period of the return's receipt / refund processing date.
- **Bank Receipts**: Attributed to the period when the funds actually credited Youthnic's bank account (`paymentReceivedAt`).
- **Gateway Deductions & Freight**: Attributed to the billing/service invoice period.

### October Sale Settled in November Example:
1. **October Books**:
   - Order placed Oct 28: Gross Sales ₹1,000 posted in October.
   - Bank receipt is ₹0 in October (funds arrive Nov 3).
   - Closing debtor balance of ₹1,000 carries forward into November.
2. **November Books**:
   - Opening debtor balance brought forward: ₹1,000.
   - Bank receipt of ₹988.20 and fee of ₹11.80 posted in November.
   - Closing debtor balance becomes ₹0 (fully settled).
   - **No October receipt is created using November bank credit.**

## 3. Pre-Close Verification Checklist
Before creating the immutable snapshot and emailing the report:
1. All orders in the period have balanced sales vouchers posted.
2. All customer returns in the period have balanced credit notes posted.
3. Bank credits are matched against bank statement lines.
4. General ledger Trial Balance is strictly balanced (`Total Debits == Total Credits`).
5. Missing supplier invoices or unallocated UTRs are compiled into the exceptions ledger.

## 4. Immutable Closing & Reopening Rules
- Once closed, a `MonthlyClosingSnapshot` record is created.
- The numbers of a closed month cannot be silently changed. Any subsequent retroactive adjustment must be posted as an adjusting journal voucher (`JV`) in the open period or via formal versioned restatement.
