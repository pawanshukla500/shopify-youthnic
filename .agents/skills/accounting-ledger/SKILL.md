---
name: accounting-ledger
description: "Auditable double-entry financial ledger operations, chart of accounts management, and balanced journal voucher posting."
compatibility: Claude Code, Antigravity, Cursor
metadata:
  author: Youthnic Accounting & Compliance
---

# Accounting Ledger Skill (`accounting-ledger`)

## 1. Purpose & Invocation Criteria
Use this skill when posting financial transactions, managing the chart of accounts, verifying double-entry invariants, and generating trial balances for Shopify Youthnic (VB Exports).

**Invocation Triggers:**
- Posting sales invoices, return credit notes, or manual journal adjustments.
- Verifying whether general ledger accounts are in balance (`Total Debits == Total Credits`).
- Creating new ledger accounts under standard classification (Asset, Liability, Equity, Revenue, Expense).
- Inspecting transaction histories and audit evidence.

## 2. Required Source Data
- Valid source document reference: Shopify Order Name (`#26YOU...`), Return ID, Bank UTR, or Courier Invoice Number.
- Document Date (source creation) and Posting Date (books entry).
- Accounting Period (`YYYY-MM`).
- Line items with account code, debit amount, credit amount, and narration.

## 3. Document & Evidence Precedence
1. Primary Bank Statement / Bank UTR Credit (Highest truth for cash movements).
2. Courier Remittance / Gateway Settlement official invoice/statement.
3. Shopify Order & Line Item pricing/tax lines.
4. Internal operational records.

## 4. Calculation & Reconciliation Procedures
- All monetary amounts must use Decimal or integer paise arithmetic. Binary floating-point arithmetic is forbidden.
- For every journal entry:
  $$\sum \text{Debits} = \sum \text{Credits}$$
- Rounding differences exceeding ₹0.02 trigger a validation error. Minor 1-paise rounding discrepancies are adjusted against the primary debit/credit line with an audit note.

## 5. Accounting Invariants
1. **Double-Entry Equality**: Under no circumstances may an unbalanced voucher be posted.
2. **Sales Revenue Integrity**: Gateway MDR fees and freight charges are recorded as separate expenses; they must never reduce gross sales turnover directly.
3. **Wallet Transfers**: Courier wallet top-ups are recorded as Asset-to-Asset prepayment transfers (`Bank` $\to$ `Courier Wallet`), never as freight expenses.

## 6. Exception Scenarios
- Missing account code: Auto-seeds standard chart of accounts or throws exception if unmapped.
- Period closed: Posting into a closed accounting period requires authorized reopening or adjustment journal entries in the current open period.
- Negative debit/credit: Must be converted to opposite credit/debit with proper notation.

## 7. Approval Requirements
- Automated system postings for sales and returns are pre-approved by system rules.
- Manual journal vouchers (`JV`) and retroactive adjustments require review by Head of Accounts.

## 8. Practical Example
### Posting a ₹1,000 Sale with 5% GST (Intra-state Gujarat):
- **Debit**: `SUNDRY_DEBTORS_PREPAID` ₹1,000.00
- **Credit**: `SALES_REVENUE` ₹952.38
- **Credit**: `OUTPUT_CGST` (2.5%) ₹23.81
- **Credit**: `OUTPUT_SGST` (2.5%) ₹23.81
- **Total Debits**: ₹1,000.00 == **Total Credits**: ₹1,000.00

## 9. Restrictions
- **NEVER invent financial facts**: Do not guess amounts, UTRs, or dates.
- AI cannot approve its own accounting adjustments.
