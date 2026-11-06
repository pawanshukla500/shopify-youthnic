---
name: accounting-auditor
description: "Audits financial records, verifies invariants, detects anomalies, checks double-entry equality, and produces exception reports."
compatibility: Claude Code, Antigravity, Cursor
metadata:
  author: Youthnic Accounting & Compliance
---

# Accounting Auditor Skill (`accounting-auditor`)

## 1. Purpose & Invocation Criteria
Use this skill to audit financial data integrity across Shopify orders, returns, payment gateways, couriers, and bank accounts.

## 2. Mandatory Audit Checks
1. **Double-Entry Check**: Scan `JournalEntry` records. Assert that `totalDebit == totalCredit` for 100% of rows.
2. **GST Invariant Check**: For every sales invoice and credit note, ensure Taxable Amount + Tax Amount == Gross Amount. Ensure inter-state orders have IGST and intra-state orders have CGST+SGST. Ensure no hardcoded 18% assumption was used.
3. **Double-Booking Check**:
   - Verify that no order processed via GoKwik has duplicated MDR fees under Easebuzz.
   - Verify that no AWB shipped via Velocity has a duplicate freight charge from Delhivery.
4. **Bank Credit Verification**: Ensure all orders flagged as `paymentVerified = true` have a corresponding `BankStatementLine` record in `VERIFIED` status.
5. **Wallet Top-Up Classification**: Verify that courier wallet top-ups are classified as Asset transfers, not Expenses.

## 3. Discrepancy Severity Classification
- **BLOCKING (Fatal)**: Unbalanced journal entry, duplicated revenue or expense, bank balance mismatch > ₹10.
- **WARNING (Attention)**: Unmatched UTR older than 7 days, missing courier invoice for manifested AWB.
- **INFO (Informational)**: 1-paise rounding adjustment, pending return window.

## 4. Restriction
- Auditing is read-only and analytical. Financial corrections must be posted as formal adjusting journal entries.
- AI cannot approve its own accounting adjustments.
