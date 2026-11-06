---
name: gst-compliance
description: "Goods and Services Tax (GST) computation, Place of Supply determination, tax line validation, and credit note reversal."
compatibility: Claude Code, Antigravity, Cursor
metadata:
  author: Youthnic Accounting & Compliance
---

# GST Compliance Skill (`gst-compliance`)

## 1. Purpose & Invocation Criteria
Use this skill when auditing tax calculations, determining GST rates for apparel items, establishing Place of Supply (POS), splitting CGST/SGST vs IGST, and creating tax-compliant credit notes.

**Registered Business Details:**
- **Legal Entity**: YOUTHNIC (VB EXPORTS)
- **Registered GSTIN**: `24AERPB8666E1ZB`
- **Origin State**: Gujarat (State Code: `24`)

## 2. Required Source Data
- Customer shipping address / State name.
- Shopify `taxLines` JSON and item unit prices.
- Return refund amounts.
- Gateway MDR and courier logistics fee invoices.

## 3. GST Calculation Rules & Procedures
### A. Time-Effective Apparel Rates
- **Before 22 September 2025:** qualifying apparel up to ₹1,000 per piece: 5%; exceeding ₹1,000: 12%.
- **From 22 September 2025:** qualifying readymade garments/made-ups up to ₹2,500 per piece: 5%; exceeding ₹2,500: 18%.
- This fallback applies only to supported HSN 61/62 and qualifying 63 products, using the applicable transaction value and date of supply. It is not a rule for every saree, fabric or accessory.
- Prefer verified invoice/item GST tax lines. When multiple rates apply, calculate tax item-wise rather than forcing one order-level rate.
- If original invoice data, item classification, discount allocation, or supply date is uncertain, stop automatic voucher posting and request accounting review.
- Government references: https://www.pib.gov.in/FactsheetDetails.aspx?Id=150293&lang=1 and https://www.pib.gov.in/Pressreleaseshare.aspx?PRID=2168426&lang=2 .

### B. Place of Supply (POS) Classification
- **Intra-state (Buyer state == Gujarat / Code 24)**:
  - CGST: 50% of total tax
  - SGST: 50% of total tax
- **Inter-state (Buyer state != Gujarat)**:
  - IGST: 100% of total tax

### C. Tax-Inclusive Calculation Formula
$$\text{Taxable Amount} = \frac{\text{Gross Amount}}{1 + \frac{\text{Rate}}{100}}$$
$$\text{Total GST} = \text{Gross Amount} - \text{Taxable Amount}$$

### D. Input Tax Credit (ITC)
- Record the gateway or carrier's **actual supplier invoice tax lines** and GST registration/recipient place of supply.
- Never force all supplier taxes into INPUT_IGST. Use the actual eligible IGST or CGST/SGST split, and classify ineligible ITC separately.
- An expense booked to Tally and an ITC claim are different decisions; do not claim credit until evidence and eligibility are verified.

## 4. Accounting Invariants
- Taxable Sales + Output GST must equal Gross Sales Invoice Amount.
- Every Credit Note must reverse output tax at the exact rate of the original invoice.
- Supplier invoices without valid GSTIN are flagged for manual review; ITC is marked pending.

## 5. Exception Scenarios
- Missing customer state: Default to `99-Other Territory` and flag for address correction.
- Tax rate mismatch: Highlight difference between Shopify checkout rate and HSN schedule rate.

## 6. Practical Example
### Customer Return of ₹799 in Maharashtra (Inter-state, 5% GST):
- Taxable Amount = $\frac{799}{1.05} = ₹760.95$
- Output IGST Reversed = $799 - 760.95 = ₹38.05$
- Credit Note Total = ₹799.00
