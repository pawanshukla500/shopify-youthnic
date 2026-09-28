/**
 * Courier normalization helpers.
 *
 * Delhivery ships under several carrier labels depending on how the order was
 * fulfilled — "Delhivery", "Delhivery Express", "Delhivery Surface",
 * "Delhivery B2C" (and any casing thereof) all belong to us. A strict
 * `=== 'delhivery'` check misclassifies those variants as third-party couriers,
 * which suppresses Delhivery tracking/label flows and wrongly resets audit
 * fields. Any carrier string containing "delhivery" (case-insensitive) is Delhivery;
 * everything else (Blue Dart, DTDC, Ekart, India Post, ...) is a third party that
 * must never be polled against the Delhivery tracking API.
 */
export const DELHIVERY_COURIER_PATTERN = /delhivery/i;

/**
 * True when the courier name is any Delhivery variant. Null/undefined/empty
 * courier names are treated as non-Delhivery.
 */
export function isDelhiveryCourier(courier?: string | null): boolean {
  return DELHIVERY_COURIER_PATTERN.test(courier || '');
}
