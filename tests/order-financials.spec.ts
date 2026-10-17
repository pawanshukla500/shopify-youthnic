import { describe, expect, it } from 'vitest';
import { extractOrderFinancials, moneyOrNull, orderFinancialSummary } from '../src/modules/orders/order-financials';
import type { ShopifyOrderWebhook } from '../src/types';

const payload = (extra: Partial<ShopifyOrderWebhook> = {}): ShopifyOrderWebhook => ({
  id: 1883, name: '#26YOU6061', number: 6061, created_at: '2026-10-17T11:13:00Z',
  total_price: '573.32', currency: 'INR', financial_status: 'paid',
  total_shipping_price_set: { shop_money: { amount: '45.00', currency_code: 'INR' } },
  total_discounts: '70.68', total_tax: '27.30', taxes_included: true,
  tax_lines: [{ title: 'CGST', rate: 0.05, price: '27.30' }],
  discount_codes: [{ code: 'newyou10', amount: '70.68', type: 'percentage' }],
  shipping_lines: [{ title: 'Shipping Fee', price: '45.00' }],
  line_items: [{ id: 1, title: 'Kurta', quantity: 1, price: '599.00' }],
  ...extra,
});

describe('Shopify order financial breakdown', () => {
  it('matches the screenshot without shifting shipping into the discount or assuming 18% GST', () => {
    const stored = extractOrderFinancials(payload());
    expect(stored).toMatchObject({ totalShipping: 45, totalDiscounts: 70.68, totalTax: 27.3, taxesIncluded: true, shippingTitle: 'Shipping Fee' });
    expect(stored.discountCodes?.[0].code).toBe('newyou10');
    expect(orderFinancialSummary({ ...stored, totalAmount: 573.32, financialStatus: 'paid' }, [{ price: 599, quantity: 1 }]))
      .toEqual({ subtotal: 599, total: 573.32, shipping: 45, discount: 70.68, tax: 27.3, paid: 573.32 });
  });

  it('keeps missing amounts unknown rather than inventing a discount, free shipping or tax', () => {
    expect(orderFinancialSummary({ totalAmount: 573.32 }, [{ price: 599, quantity: 1 }]))
      .toEqual({ subtotal: 599, total: 573.32, shipping: null, discount: null, tax: null, paid: null });
  });

  it('preserves a zero total for a fully discounted order', () => {
    expect(orderFinancialSummary({ totalAmount: 0, totalShipping: 0, totalDiscounts: 599, totalTax: 0, financialStatus: 'paid' }, [{ price: 599, quantity: 1 }]))
      .toMatchObject({ total: 0, discount: 599, shipping: 0, tax: 0, paid: 0 });
  });

  it('does not treat a partial payment as fully paid', () => {
    expect(orderFinancialSummary({ totalAmount: 599, totalOutstanding: 399, financialStatus: 'partially_paid' }, [])).toMatchObject({ paid: 200 });
    expect(orderFinancialSummary({ totalAmount: 599, financialStatus: 'partially_paid' }, [])).toMatchObject({ paid: null });
  });

  it('keeps exclusive taxes distinct without adjusting the Shopify total', () => {
    expect(extractOrderFinancials(payload({ taxes_included: false, total_tax: '30' })))
      .toMatchObject({ taxesIncluded: false, totalTax: 30 });
  });

  it('uses discounted shipping lines when the money set is absent, including free shipping', () => {
    expect(extractOrderFinancials(payload({ total_shipping_price_set: undefined, shipping_lines: [{ price: '45', discounted_price: '0' }] })).totalShipping).toBe(0);
    expect(extractOrderFinancials(payload({ total_shipping_price_set: undefined, shipping_lines: [{ price: '20' }, { price: '25' }] })).totalShipping).toBe(45);
  });

  it('prefers shop money over a shipping-line fallback', () => {
    expect(extractOrderFinancials(payload({ shipping_lines: [{ price: '999' }] })).totalShipping).toBe(45);
  });

  it('keeps notes and useful attributes but excludes checkout credentials', () => {
    const stored = extractOrderFinancials(payload({ note: '<script>not executable</script>', note_attributes: [
      { name: 'Delivery instructions', value: 'Evening' }, { name: 'cart_token', value: 'private' },
      { name: 'gk_order_confirmation_url', value: 'private' }, { name: 'Payment_Authorization_Key', value: 'private' },
    ] }));
    expect(stored.shopifyNote).toBe('<script>not executable</script>');
    expect(stored.additionalDetails).toEqual([{ name: 'Delivery instructions', value: 'Evening' }]);
  });

  it.each([undefined, null, '', 'invalid', -1, Infinity, true])('rejects missing or invalid money: %s', (value) => {
    expect(moneyOrNull(value)).toBeNull();
  });

  it('keeps exact zero values', () => {
    expect(moneyOrNull('0.00')).toBe(0);
  });

  it('does not erase a stored breakdown when a webhook omits financial fields', () => {
    const sparse = extractOrderFinancials({ id: 1, name: '#1', number: 1, created_at: '2026-10-17', total_price: '100', currency: 'INR', line_items: [] });
    expect(sparse).not.toHaveProperty('totalShipping');
    expect(sparse).not.toHaveProperty('totalDiscounts');
    expect(sparse).not.toHaveProperty('totalTax');
    expect(sparse).not.toHaveProperty('taxesIncluded');
    expect(sparse).not.toHaveProperty('shippingTitle');
  });

  it('does not claim a partially refunded order is still fully paid', () => {
    expect(orderFinancialSummary({ totalAmount: 100, totalOutstanding: 0, financialStatus: 'partially_refunded' }, []).paid).toBeNull();
    expect(orderFinancialSummary({ totalAmount: 100, totalOutstanding: 0, financialStatus: 'voided' }, []).paid).toBe(0);
  });
});
