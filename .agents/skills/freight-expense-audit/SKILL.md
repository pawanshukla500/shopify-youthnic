---
name: freight-expense-audit
description: "Audit courier logistics freight charges, Delhivery and Velocity billings, wallet deductions, and cross-carrier deduplication."
compatibility: Claude Code, Antigravity, Cursor
metadata:
  author: Youthnic Accounting & Compliance
---

# Freight Expense Audit Skill (`freight-expense-audit`)

## 1. Purpose & Invocation Criteria
Use this skill when auditing Delhivery and Velocity freight charges, reconciling courier wallet debits, auditing weight discrepancy surcharges, and preventing double-booking between shipping aggregators and underlying couriers.

## 2. Core Deduplication Invariant (Velocity vs Underlying Courier)
**CRITICAL RULE:**
- When an order is manifested and shipped via **Velocity**, Velocity may utilize underlying carriers (Delhivery, Ekart, Bluedart, Shadowfax).
- **Double-Freight Guard**: If an AWB was dispatched under Velocity, only the actual Velocity freight invoice is booked as a financial expense in the General Ledger. Any charges shown by the underlying courier are for operational reference only.
- Under no circumstances should both Velocity and Delhivery be billed for the same AWB.

## 3. Freight Cost Classification
- **Forward Freight**: `EXPENSE_FREIGHT_FORWARD`
- **Return to Origin (RTO)**: `EXPENSE_FREIGHT_RTO`
- **Customer Reverse Pickup**: `EXPENSE_FREIGHT_REVERSE`
- **COD Collection/Handling Fee**: `EXPENSE_COD_HANDLING`
- **Weight Discrepancy Surcharges**: `EXPENSE_WEIGHT_SURCHARGES`
- **Input GST on Freight**: `INPUT_IGST` (18% on logistics services)

## 4. Wallet Top-Up vs Expense
- **Wallet Top-Up Invariant**: Adding funds to a Delhivery or Velocity wallet is an Asset-to-Asset prepayment transfer:
  - **Debit**: `COURIER_WALLET_DELHIVERY` (Asset)
  - **Credit**: `BANK_MAIN` (Asset)
  - **A wallet top-up is NEVER an expense.**
- When a parcel is delivered or manifested, the wallet debit converts the prepayment into a freight expense:
  - **Debit**: `EXPENSE_FREIGHT_FORWARD`
  - **Credit**: `COURIER_WALLET_DELHIVERY`

## 5. Freight Reversals & Credits
- Credits from successful weight disputes or courier service failures must credit the corresponding freight expense ledger or courier payable account.
