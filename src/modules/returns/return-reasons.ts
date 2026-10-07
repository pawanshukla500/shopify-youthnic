/**
 * Return reasons shared by the OMS, Shopify Returns, and Delhivery reverse pickup.
 *
 * Delhivery One's "Initiate Return" dialog offers Damaged product, Quality is
 * not good, and Others. The public manifestation API has no separate reason
 * enum — the reason travels in products_desc, which the edit API can change
 * until the reverse parcel is picked up. Shopify returnCreate takes ReturnReason.
 */

export type ShopifyReturnReason =
  | 'DEFECTIVE'
  | 'NOT_AS_DESCRIBED'
  | 'WRONG_ITEM'
  | 'SIZE_TOO_SMALL'
  | 'UNWANTED'
  | 'OTHER';

/** Labels Delhivery One shows on Initiate Return. */
export type DelhiveryReturnReason = 'Damaged product' | 'Quality is not good' | 'Others';

export interface MappedReturnReason {
  shopifyReason: ShopifyReturnReason;
  delhiveryReason: DelhiveryReturnReason;
  note: string;
}

export function mapReturnReason(reason: string): MappedReturnReason {
  const note = reason.trim() || 'Others';
  const lower = note.toLowerCase();
  if (/damag|defect|broken|torn/.test(lower)) {
    return { shopifyReason: 'DEFECTIVE', delhiveryReason: 'Damaged product', note };
  }
  if (/quality|not good|not as described/.test(lower)) {
    return { shopifyReason: 'NOT_AS_DESCRIBED', delhiveryReason: 'Quality is not good', note };
  }
  if (/wrong/.test(lower)) {
    return { shopifyReason: 'WRONG_ITEM', delhiveryReason: 'Others', note };
  }
  if (/size/.test(lower)) {
    return { shopifyReason: 'SIZE_TOO_SMALL', delhiveryReason: 'Others', note };
  }
  if (/changed mind|unwanted|don'?t want/.test(lower)) {
    return { shopifyReason: 'UNWANTED', delhiveryReason: 'Others', note };
  }
  return { shopifyReason: 'OTHER', delhiveryReason: 'Others', note };
}

/** What the field executive and Delhivery One see on the reverse order. */
export function reverseProductDescription(reason: string, itemSummary?: string): string {
  const mapped = mapReturnReason(reason);
  const detail = mapped.note === mapped.delhiveryReason ? mapped.note : `${mapped.delhiveryReason} — ${mapped.note}`;
  const withItems = itemSummary ? `${detail} — ${itemSummary}` : detail;
  return withItems.slice(0, 180);
}

export interface FulfillmentLineChoice {
  id: string;
  quantity: number;
  sku?: string | null;
  title?: string | null;
}

export interface RequestedReturnLine {
  sku?: string | null;
  title?: string | null;
  quantity: number;
}

/** Match OMS lines to Shopify fulfillment line items for returnCreate. */
export function selectReturnFulfillmentLines(
  lines: FulfillmentLineChoice[],
  requested: RequestedReturnLine[]
): Array<{ fulfillmentLineItemId: string; quantity: number }> {
  const used = new Map<string, number>();
  const chosen: Array<{ fulfillmentLineItemId: string; quantity: number }> = [];

  const remaining = (line: FulfillmentLineChoice) => line.quantity - (used.get(line.id) || 0);

  for (const item of requested) {
    const wanted = Math.max(0, Math.floor(item.quantity));
    if (wanted < 1) continue;
    const specific = lines.find((line) => {
      if (remaining(line) < 1) return false;
      if (item.sku && line.sku && item.sku.trim() === line.sku.trim()) return true;
      if (item.title && line.title && item.title.trim() === line.title.trim()) return true;
      return false;
    });
    const match = specific || lines.find((line) => remaining(line) > 0);
    if (!match) continue;
    const quantity = Math.min(wanted, remaining(match));
    if (quantity < 1) continue;
    used.set(match.id, (used.get(match.id) || 0) + quantity);
    chosen.push({ fulfillmentLineItemId: match.id, quantity });
  }

  return chosen;
}
