import type { ShopifyOrderWebhook } from '../../types';

/** Missing Shopify amounts are unknown, not zero. Never reverse-engineer tax. */
export function moneyOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null;
}

export function extractOrderFinancials(order: ShopifyOrderWebhook) {
  const shippingAmount = moneyOrNull(order.total_shipping_price_set?.shop_money?.amount);
  const shippingLines = order.shipping_lines;
  const lineAmounts = shippingLines?.map((line) => moneyOrNull(line.discounted_price ?? line.price));
  const totalShipping = shippingAmount ?? (
    lineAmounts && lineAmounts.every((amount) => amount !== null)
      ? Math.round(lineAmounts.reduce<number>((sum, amount) => sum + amount!, 0) * 100) / 100
      : null
  );
  return {
    ...(totalShipping !== null ? { totalShipping } : {}),
    ...(order.total_discounts !== undefined ? { totalDiscounts: moneyOrNull(order.total_discounts) } : {}),
    ...(order.total_tax !== undefined ? { totalTax: moneyOrNull(order.total_tax) } : {}),
    ...(order.total_outstanding !== undefined ? { totalOutstanding: moneyOrNull(order.total_outstanding) } : {}),
    ...(typeof order.taxes_included === 'boolean' ? { taxesIncluded: order.taxes_included } : {}),
    ...(order.tax_lines !== undefined ? { taxLines: order.tax_lines } : {}),
    ...(order.discount_codes !== undefined ? { discountCodes: order.discount_codes } : {}),
    ...(shippingLines !== undefined ? { shippingTitle: shippingLines.map((line) => line.title).filter(Boolean).join(', ') || null } : {}),
    ...(order.note !== undefined ? { shopifyNote: order.note } : {}),
    // Checkout tokens and private authentication data are not useful order metadata.
    ...(order.note_attributes !== undefined ? {
      additionalDetails: order.note_attributes.filter((attribute) =>
        !/token|secret|password|authorization|key|confirmation.*url|user_agent|full_url/i.test(attribute.name)
      ),
    } : {}),
  };
}

interface FinancialOrder {
  totalAmount: number;
  totalShipping?: number | null;
  totalDiscounts?: number | null;
  totalTax?: number | null;
  totalOutstanding?: number | null;
  financialStatus?: string | null;
}

export function orderFinancialSummary(order: FinancialOrder, items: Array<{ price: number; quantity: number }>) {
  const total = moneyOrNull(order.totalAmount);
  const outstanding = moneyOrNull(order.totalOutstanding);
  const status = order.financialStatus?.toLowerCase();
  return {
    subtotal: Math.round(items.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100) / 100,
    total,
    shipping: moneyOrNull(order.totalShipping),
    discount: moneyOrNull(order.totalDiscounts),
    tax: moneyOrNull(order.totalTax),
    paid: status === 'refunded' ? 0
      : status === 'partially_refunded' ? null
      : status === 'voided' ? 0
      : total !== null && outstanding !== null ? Math.max(0, Math.round((total - outstanding) * 100) / 100)
      : status === 'paid' ? total
      : status === 'pending' || status === 'voided' ? 0 : null,
  };
}
