---
name: gateway-reconciliation
description: "Payment gateway settlement reconciliation, GoKwik/Easebuzz fee deduplication, PhonePe settlement, and MDR accounting."
compatibility: Claude Code, Antigravity, Cursor
metadata:
  author: Youthnic Accounting & Compliance
---

# Gateway Reconciliation Skill (`gateway-reconciliation`)

## 1. Purpose & Invocation Criteria
Use this skill when processing GoKwik, Easebuzz, or PhonePe settlement reports, segregating gross collections from processing expenses, and ensuring deduplication between checkout aggregators and payment processors.

## 2. Core Deduplication Invariant (GoKwik vs Easebuzz)
**CRITICAL RULE:**
- **GoKwik** is the checkout aggregator / technology platform.
- **Easebuzz** is the underlying licensed payment gateway acquiring the funds.
- **Deduplication Safeguard**: If an order flows via GoKwik checkout and is processed via Easebuzz, verify the fee owner. **Never record the same MDR processing fee under both GoKwik and Easebuzz!**
- Platform/service fees billed separately by GoKwik are booked under `EXPENSE_PG_FEES_GOKWIK`.
- Payment gateway MDR fees deducted by Easebuzz are booked under `EXPENSE_PG_FEES_EASEBUZZ`.

## 3. Gateway Accounting Formula
For a settlement batch:
$$\text{Gross Collection} = \text{Actual Bank Receipt} + \text{MDR Fee Expense} + \text{Input GST on Fee}$$

### Example for ₹1,000 collection with ₹10 fee and ₹1.80 fee GST:
- **Debit**: `BANK_MAIN` ₹988.20 (actual funds credited)
- **Debit**: `EXPENSE_PG_FEES_EASEBUZZ` ₹10.00
- **Debit**: `INPUT_IGST` ₹1.80
- **Credit**: `CLEARING_EASEBUZZ` ₹1,000.00
- **Total Debits**: ₹1,000.00 == **Total Credits**: ₹1,000.00

## 4. Verification & Audit Precedence
1. Bank credit transaction on authorized bank statement with matching UTR.
2. Gateway settlement batch payout advice.
3. Order level transaction IDs.

## 5. Restrictions
- Never reduce sales turnover by gateway processing deductions.
- An order's payment is not bank-verified until matched against an actual bank credit line.
