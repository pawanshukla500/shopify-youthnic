---
name: tally-integration
description: "TallyPrime XML voucher generation, chart of accounts mapping, balanced debit/credit validation, and duplicate import prevention."
compatibility: Claude Code, Antigravity, Cursor
metadata:
  author: Youthnic Accounting & Compliance
---

# Tally Integration Skill (`tally-integration`)

## 1. Purpose & Invocation Criteria
Use this skill when generating XML voucher packages or Excel mapping templates for import into TallyPrime ERP.

## 2. Supported Tally Voucher Types
- **Sales Voucher (`<VOUCHER VCHTYPE="Sales">`)**: Itemized sales invoice with Party Ledger, GST POS state, Taxable Sales, and CGST/SGST or IGST.
- **Credit Note (`<VOUCHER VCHTYPE="Credit Note">`)**: Return credit note reversing original sales turnover and output GST.
- **Receipt Voucher (`<VOUCHER VCHTYPE="Receipt">`)**: Bank receipt for gateway payouts and courier COD remittances.
- **Purchase / Expense Voucher (`<VOUCHER VCHTYPE="Purchase">`)**: Freight bills and carrier service charges.
- **Payment Voucher (`<VOUCHER VCHTYPE="Payment">`)**: Outgoing supplier payments and courier wallet top-ups.
- **Journal Voucher (`<VOUCHER VCHTYPE="Journal">`)**: Year-end and month-end adjustments.

## 3. Tally XML Invariants & Conventions
1. **Mathematical Balance**: In Tally XML notation, `ISDEEMEDPOSITIVE` is `Yes` for Debits and `No` for Credits. The signed sum of `<AMOUNT>` across all `<ALLLEDGERENTRIES.LIST>` must equal exactly zero.
2. **Idempotency & GUIDs**: Every voucher carries a unique `<GUID>` (e.g. `YOUTHNIC-{id}-{entryNumber}`) and `<VOUCHERNUMBER>` to prevent duplicate imports into TallyPrime.
3. **Company Context**: Targets `<SVCURRENTCOMPANY>YOUTHNIC (VB EXPORTS)</SVCURRENTCOMPANY>`.
4. **GST Compliance**: Embeds `<STATENAME>` and GST Place of Supply on sales and credit notes.

## 4. Verification Workflow
- Always validate the XML file against the schema before distribution.
- Test export in a Tally test company before importing into production company books.
- Never trigger automated import into live Tally without explicit user authorization.
