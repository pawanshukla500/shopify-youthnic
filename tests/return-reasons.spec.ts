import { describe, it, expect } from 'vitest';
import {
  mapReturnReason,
  reverseProductDescription,
  selectReturnFulfillmentLines,
} from '../src/modules/returns/return-reasons';

describe('return reasons', () => {
  it('maps OMS reasons onto Shopify and Delhivery One labels', () => {
    expect(mapReturnReason('Changed mind')).toEqual({
      shopifyReason: 'UNWANTED',
      delhiveryReason: 'Others',
      note: 'Changed mind',
    });
    expect(mapReturnReason('Damaged product').delhiveryReason).toBe('Damaged product');
    expect(mapReturnReason('Damaged product').shopifyReason).toBe('DEFECTIVE');
    expect(mapReturnReason('Quality is not good').delhiveryReason).toBe('Quality is not good');
    expect(mapReturnReason('Size mismatch').shopifyReason).toBe('SIZE_TOO_SMALL');
    expect(mapReturnReason('Wrong item').shopifyReason).toBe('WRONG_ITEM');
  });

  it('puts the Delhivery reason in the reverse product description', () => {
    expect(reverseProductDescription('Changed mind', 'Brown Rayon Kurti')).toBe(
      'Others — Changed mind — Brown Rayon Kurti'
    );
    expect(reverseProductDescription('Damaged product')).toBe('Damaged product');
  });

  it('matches Shopify fulfillment lines by SKU for returnCreate', () => {
    const chosen = selectReturnFulfillmentLines(
      [
        { id: 'gid://shopify/FulfillmentLineItem/1', quantity: 1, sku: 'BT216', title: 'Kurti' },
        { id: 'gid://shopify/FulfillmentLineItem/2', quantity: 2, sku: 'OTHER', title: 'Dupatta' },
      ],
      [{ sku: 'BT216', title: 'Kurti', quantity: 1 }]
    );
    expect(chosen).toEqual([{ fulfillmentLineItemId: 'gid://shopify/FulfillmentLineItem/1', quantity: 1 }]);
  });
});
