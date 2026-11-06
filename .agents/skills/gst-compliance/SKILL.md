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
### A. Product Rates for Indian Apparel
- **Kurtis / Garments $\le$ ₹1,000 per piece**: **5% GST**
- **Garments > ₹1,000 per piece**: **12% GST** (or 18% for specific accessories)
- **Universal 18% assumption is strictly prohibited.**

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
- **Payment Gateway MDR Fees**: 18% IGST on processing charges.
- **Courier Logistics Services**: 18% IGST on freight charges.

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
