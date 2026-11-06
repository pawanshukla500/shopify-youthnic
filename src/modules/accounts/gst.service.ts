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
   * Determine effective GST rate for an order from Shopify tax lines or line items.
   * In Indian apparel:
   * - Ready-made garments / kurtis under ₹1,000 per piece: 5% GST
   * - Garments over ₹1,000 per piece: 12% GST (or 18% for specific accessories)
   * Falls back to Shopify order.taxLines if present.
   */
  public determineOrderGstRate(order: {
    taxLines?: any;
    totalAmount: number;
    totalTax?: number | null;
    items?: Array<{ price: number; quantity: number }>;
  }): number {
    // 1. Inspect Shopify taxLines JSON if populated
    if (order.taxLines) {
      try {
        const lines = typeof order.taxLines === 'string' ? JSON.parse(order.taxLines) : order.taxLines;
        if (Array.isArray(lines) && lines.length > 0) {
          const rateSum = lines.reduce((acc: number, l: any) => acc + (parseFloat(l.rate || '0') * 100), 0);
          if (rateSum > 0) return Math.round(rateSum * 100) / 100;
        }
      } catch {
        // ignore and fallback
      }
    }

    // 2. Check totalTax ratio if present
    if (order.totalTax && order.totalAmount > order.totalTax) {
      const taxable = order.totalAmount - order.totalTax;
      const calculatedRate = (order.totalTax / taxable) * 100;
      if (Math.abs(calculatedRate - 5) <= 1) return 5;
      if (Math.abs(calculatedRate - 12) <= 1.5) return 12;
      if (Math.abs(calculatedRate - 18) <= 2) return 18;
    }

    // 3. Fallback based on item unit prices (Standard textile rule in India)
    if (order.items && order.items.length > 0) {
      const allUnder1000 = order.items.every((it) => (it.price || 0) <= 1000);
      if (allUnder1000) return 5;
      return 12;
    }

    // Default rate for ethnic apparel catalog
    return 5;
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
