/**
 * GST Calculation & Tax Compliance Service
 *
 * Implements precise GST computation for sales, returns, freight, and gateway MDR.
 * Replaces hardcoded 18% assumptions with dynamic tax line inspection.
 *
 * Registered GSTIN: 24AERPB8666E1ZB (State: Gujarat, Code: 24)
 */

export interface GstTaxBreakdown {
  grossAmount: number;
  taxableAmount: number;
  totalGst: number;
  cgst: number;
  sgst: number;
  igst: number;
  gstRate: number; // e.g. 5, 12, 18
  isInterState: boolean;
  posState: string;
  posCode: string;
}

export const GUJARAT_GST_CODE = '24';
export const SELLER_GSTIN = process.env.COMPANY_GSTIN || '24AERPB8666E1ZB';

export const GST_STATE_CODE_MAP: Record<string, string> = {
  'jammu and kashmir': '01',
  'himachal pradesh': '02',
  'punjab': '03',
  'chandigarh': '04',
  'uttarakhand': '05',
  'haryana': '06',
  'delhi': '07',
  'rajasthan': '08',
  'uttar pradesh': '09',
  'bihar': '10',
  'sikkim': '11',
  'arunachal pradesh': '12',
  'nagaland': '13',
  'manipur': '14',
  'mizoram': '15',
  'tripura': '16',
  'meghalaya': '17',
  'assam': '18',
  'west bengal': '19',
  'jharkhand': '20',
  'odisha': '21',
  'chhattisgarh': '22',
  'madhya pradesh': '23',
  'gujarat': '24',
  'daman and diu': '26',
  'dadra and nagar haveli and daman and diu': '26',
  'maharashtra': '27',
  'andhra pradesh': '37',
  'karnataka': '29',
  'goa': '30',
  'lakshadweep': '31',
  'kerala': '32',
  'tamil nadu': '33',
  'puducherry': '34',
  'andaman and nicobar islands': '35',
  'telangana': '36',
  'ladakh': '38',
};

export function resolvePosCode(stateName?: string | null): { code: string; state: string } {
  if (!stateName) return { code: '99', state: 'Other Territory' };
  const normalized = stateName.trim().toLowerCase();
  const code = GST_STATE_CODE_MAP[normalized] || '99';
  return { code, state: stateName.trim() };
}

export class GstService {
  /**
   * Apparel GST rate for one piece (HSN 61/62) by its sale value after discount and the supply date.
   * From 22 Sep 2025: 5% up to ₹2,500 per piece, else 18%. Before: 5% up to ₹1,000, else 12%.
   */
  public apparelRate(pieceValue: number, supplyDate: Date | string | null | undefined): number {
    const date = supplyDate ? new Date(supplyDate) : null;
    if (!date || Number.isNaN(date.getTime())) throw new Error('Missing supply date: GST rate cannot be determined.');
    if (!Number.isFinite(pieceValue) || pieceValue < 0) throw new Error('Invalid unit sale value for GST calculation.');
    const isNewSlab = date >= new Date('2025-09-22T00:00:00+05:30');
    return pieceValue <= (isNewSlab ? 2500 : 1000) ? 5 : isNewSlab ? 18 : 12;
  }

  /**
   * The order's GST lines, one per rate, following the government apparel slabs (not Shopify/GoKwik tax
   * lines, which are wrong for this store). Each piece is rated on its value after the order discount;
   * the order total (shipping included, a composite supply) is shared over items by value.
   * Shopify tax lines are used only when the order has no items to rate.
   */
  public orderGstLines(order: {
    taxLines?: any;
    totalAmount: number;
    shopifyCreatedAt?: Date | string | null;
    totalDiscounts?: number | null;
    items?: Array<{ price: number; quantity: number; title?: string | null }>;
  }): Array<{ rate: number; amount: number; qty: number; titles: string[] }> {
    const items = (order.items || []).filter((i) => (Number(i.quantity) || 0) > 0);
    if (items.length) {
      const subtotal = items.reduce((t, i) => t + (Number(i.price) || 0) * i.quantity, 0);
      if (!(subtotal > 0)) throw new Error('Order items have no sale value: GST rate cannot be determined.');
      const afterDiscount = Math.max(0, (subtotal - (order.totalDiscounts || 0)) / subtotal);
      const byRate = new Map<number, { value: number; qty: number; titles: string[] }>();
      for (const item of items) {
        const rate = this.apparelRate((Number(item.price) || 0) * afterDiscount, order.shopifyCreatedAt);
        const g = byRate.get(rate) || { value: 0, qty: 0, titles: [] };
        g.value += (Number(item.price) || 0) * item.quantity;
        g.qty += item.quantity;
        if (item.title) g.titles.push(item.title);
        byRate.set(rate, g);
      }
      const groups = [...byRate.entries()].sort((x, y) => x[0] - y[0]);
      let allocated = 0;
      return groups.map(([rate, g], idx) => {
        // Last group takes the rounding remainder so the lines add up to the order total.
        const amount = idx === groups.length - 1
          ? Math.round((order.totalAmount - allocated) * 100) / 100
          : Math.round(((order.totalAmount * g.value) / subtotal) * 100) / 100;
        allocated += amount;
        return { rate, amount, qty: g.qty, titles: g.titles };
      });
    }
    const rate = this.shopifyTaxLineRate(order.taxLines);
    if (rate !== null) return [{ rate, amount: order.totalAmount, qty: 0, titles: [] }];
    throw new Error('No order items or Shopify tax lines: manual GST review required.');
  }

  /** Rate from Shopify tax lines (CGST + SGST add up); a cross-check only. Null when there are none. */
  public shopifyTaxLineRate(taxLines: any): number | null {
    let lines: any = null;
    try {
      lines = typeof taxLines === 'string' ? JSON.parse(taxLines) : taxLines;
    } catch {
      return null;
    }
    if (!Array.isArray(lines) || !lines.length) return null;
    const ratesByTitle = new Map<string, Set<number>>();
    for (const l of lines) {
      const rate = Math.round(parseFloat(l?.rate || '0') * 10000) / 100;
      if (!(rate > 0)) continue;
      const title = String(l?.title || '').trim().toUpperCase();
      ratesByTitle.set(title, (ratesByTitle.get(title) || new Set<number>()).add(rate));
    }
    // One tax title at two rates (IGST 5% and IGST 18%) is a mixed-rate order.
    if ([...ratesByTitle.values()].some((rates) => rates.size > 1)) {
      throw new Error('Mixed GST rates require item-wise invoice/credit-note postings.');
    }
    const sum = [...ratesByTitle.values()].reduce((acc, rates) => acc + [...rates][0], 0);
    return sum > 0 ? Math.round(sum * 100) / 100 : null;
  }

  /** Single GST rate for the order; throws for a mixed-rate order (use orderGstLines to split it). */
  public determineOrderGstRate(order: Parameters<GstService['orderGstLines']>[0]): number {
    const lines = this.orderGstLines(order);
    if (lines.length > 1) throw new Error('Mixed GST rates require item-wise invoice/credit-note postings.');
    return lines[0].rate;
  }

  /**
   * Compute precise tax breakdown for an invoice / sale amount (tax inclusive).
   */
  public calculateSalesTax(
    grossAmount: number,
    customerState: string | null | undefined,
    forcedRate?: number,
    order?: any
  ): GstTaxBreakdown {
    const { code, state } = resolvePosCode(customerState);
    const isInterState = code !== GUJARAT_GST_CODE;
    const gstRate = forcedRate !== undefined ? forcedRate : (order ? this.determineOrderGstRate(order) : 5);

    // Gross is tax inclusive: Gross = Taxable * (1 + rate/100)
    // Taxable = Gross / (1 + rate/100)
    const factor = 1 + gstRate / 100;
    const taxableAmount = Math.round((grossAmount / factor) * 100) / 100;
    const totalGst = Math.round((grossAmount - taxableAmount) * 100) / 100;

    let cgst = 0;
    let sgst = 0;
    let igst = 0;

    if (isInterState) {
      igst = totalGst;
    } else {
      // Intra-state Gujarat: 50% CGST + 50% SGST
      cgst = Math.round((totalGst / 2) * 100) / 100;
      sgst = Math.round((totalGst - cgst) * 100) / 100;
    }

    return {
      grossAmount,
      taxableAmount,
      totalGst,
      cgst,
      sgst,
      igst,
      gstRate,
      isInterState,
      posState: state,
      posCode: code,
    };
  }

  /**
   * Compute credit note tax reversal for customer returns.
   */
  public calculateReturnTax(
    refundAmount: number,
    customerState: string | null | undefined,
    originalGstRate: number = 5
  ): GstTaxBreakdown {
    return this.calculateSalesTax(refundAmount, customerState, originalGstRate);
  }

  /**
   * Compute input GST on payment gateway processing fees (typically 18% GST on MDR).
   */
  public calculateGatewayFeeTax(feeExclusive: number, feeGstRate: number = 18): {
    feeExclusive: number;
    feeGst: number;
    feeInclusive: number;
  } {
    const feeGst = Math.round((feeExclusive * (feeGstRate / 100)) * 100) / 100;
    const feeInclusive = Math.round((feeExclusive + feeGst) * 100) / 100;
    return { feeExclusive, feeGst, feeInclusive };
  }

  /**
   * Compute input GST on courier freight invoices (typically 18% on logistics services).
   */
  public calculateFreightTax(freightInclusive: number, freightGstRate: number = 18): {
    taxableFreight: number;
    freightGst: number;
    totalFreight: number;
  } {
    const factor = 1 + freightGstRate / 100;
    const taxableFreight = Math.round((freightInclusive / factor) * 100) / 100;
    const freightGst = Math.round((freightInclusive - taxableFreight) * 100) / 100;
    return {
      taxableFreight,
      freightGst,
      totalFreight: freightInclusive,
    };
  }
}

export const gstService = new GstService();
