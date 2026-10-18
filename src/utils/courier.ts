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
export const VELOCITY_COURIER_PATTERN = /velocity|shipfastt/i;

/**
 * True when the courier name, tracking URL, or waybill number matches Velocity Shipping.
 */
export function isVelocityCourier(
  courier?: string | null,
  trackingUrl?: string | null,
  waybillNumber?: string | null
): boolean {
  if (VELOCITY_COURIER_PATTERN.test(courier || '')) return true;
  if (VELOCITY_COURIER_PATTERN.test(trackingUrl || '')) return true;
  if (trackingUrl && /velocityshipping\.in|shipfastt\.in/i.test(trackingUrl)) return true;
  if (waybillNumber && /^(PD|VEHR|VEL)[0-9A-Z]+$/i.test(waybillNumber.trim())) return true;
  return false;
}

/**
 * True when the courier name, tracking URL, or waybill number matches Delhivery.
 * - Courier name contains "delhivery" (case-insensitive)
 * - Tracking URL contains "delhivery" (e.g. delhivery.com/track)
 * - Or waybill is a 12-15 digit numeric format and courier is generic, blank, or an external OMS marker (e.g. OMS Guru)
 */
export function isDelhiveryCourier(
  courier?: string | null,
  trackingUrl?: string | null,
  waybillNumber?: string | null
): boolean {
  // If explicitly identified as Velocity, it is not direct Delhivery
  if (isVelocityCourier(courier, trackingUrl, waybillNumber)) {
    return false;
  }

  if (DELHIVERY_COURIER_PATTERN.test(courier || '')) return true;
  if (DELHIVERY_COURIER_PATTERN.test(trackingUrl || '')) return true;

  // Guard against known third-party couriers
  if (
    courier &&
    /bluedart|blue dart|dtdc|ekart|e-kart|shadowfax|xpressbees|xpress bees|ecom express|india post|speed post|smartr|amazon|velocity/i.test(
      courier
    )
  ) {
    return false;
  }

  // If waybill is 12-15 digits and courier is generic, absent, or external OMS (e.g. OMS Guru)
  if (waybillNumber && /^[0-9]{12,15}$/.test(waybillNumber.trim())) {
    if (
      !courier ||
      /^(other|surface|express|standard|delhivery|courier|oms\s*guru|omsguru|oms|custom|manual|api|shipway|unicommerce|logistics)$/i.test(
        courier.trim()
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Normalizes courier / logistics provider name into a clean, standard label.
 * E.g., maps "omsguru" with Delhivery AWB to "Delhivery",
 * "blue dart" to "Blue Dart", "ekart" to "Ekart", etc.
 */
export function normalizeCourierName(
  courier?: string | null,
  trackingUrl?: string | null,
  waybillNumber?: string | null
): string {
  if (isDelhiveryCourier(courier, trackingUrl, waybillNumber)) {
    if (courier && /delhivery\s+(surface|express|b2c)/i.test(courier.trim())) {
      const match = courier.trim().match(/delhivery\s+(surface|express|b2c)/i);
      const variant = match ? match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase() : '';
      return variant ? `Delhivery ${variant}` : 'Delhivery';
    }
    return 'Delhivery';
  }

  if (isVelocityCourier(courier, trackingUrl, waybillNumber)) {
    return 'Velocity';
  }

  const c = (courier || '').trim();
  if (/velocity/i.test(c)) return 'Velocity';
  if (/bluedart|blue dart/i.test(c)) return 'Blue Dart';
  if (/ekart|e-kart/i.test(c)) return 'Ekart';
  if (/dtdc/i.test(c)) return 'DTDC';
  if (/shadowfax/i.test(c)) return 'Shadowfax';
  if (/xpressbees|xpress bees/i.test(c)) return 'Xpressbees';
  if (/ecom express/i.test(c)) return 'Ecom Express';
  if (/india post|speed post/i.test(c)) return 'India Post';
  if (/smartr/i.test(c)) return 'Smartr';
  if (/amazon/i.test(c)) return 'Amazon Shipping';

  if (!c || /^(other|oms\s*guru|omsguru|oms|custom|manual|api)$/i.test(c)) {
    return 'Other';
  }

  return c;
}
