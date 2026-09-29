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
 * True when the courier name, tracking URL, or waybill number matches Delhivery.
 * - Courier name contains "delhivery" (case-insensitive)
 * - Tracking URL contains "delhivery" (e.g. delhivery.com/track)
 * - Or waybill is a 12-15 digit numeric format and courier is not an explicit third-party
 */
export function isDelhiveryCourier(
  courier?: string | null,
  trackingUrl?: string | null,
  waybillNumber?: string | null
): boolean {
  if (DELHIVERY_COURIER_PATTERN.test(courier || '')) return true;
  if (DELHIVERY_COURIER_PATTERN.test(trackingUrl || '')) return true;

  // Guard against known third-party couriers
  if (
    courier &&
    /bluedart|blue dart|dtdc|ekart|e-kart|shadowfax|xpressbees|xpress bees|ecom express|india post|speed post/i.test(
      courier
    )
  ) {
    return false;
  }

  // If waybill is 12-15 digits and courier is generic or absent
  if (waybillNumber && /^[0-9]{12,15}$/.test(waybillNumber.trim())) {
    if (!courier || /^(other|surface|express|standard|delhivery|courier)$/i.test(courier.trim())) {
      return true;
    }
  }

  return false;
}
