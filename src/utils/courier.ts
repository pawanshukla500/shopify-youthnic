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
export const VELOCITY_COURIER_PATTERN = /(velocity|shipfastt|\bamazon\b|\bats\b)/i;

/**
 * True when the courier name, tracking URL, or waybill number matches Velocity Shipping.
 * Explicitly guards against AWS S3 URLs (*.amazonaws.com) used by Delhivery.
 */
export function isVelocityCourier(
  courier?: string | null,
  trackingUrl?: string | null,
  waybillNumber?: string | null
): boolean {
  const c = (courier || '').trim();
  const url = (trackingUrl || '').trim();
  const wb = (waybillNumber || '').trim();

  // If explicitly identified as Delhivery by courier name or URL, it is NEVER direct Velocity
  if (DELHIVERY_COURIER_PATTERN.test(c) || (url && /delhivery/i.test(url))) {
    return false;
  }

  // Check courier name (Velocity, Shipfastt, Amazon / ATS)
  if (VELOCITY_COURIER_PATTERN.test(c)) return true;

  // Check tracking / label URL specifically (avoid matching generic amazonaws.com host)
  if (url) {
    if (
      /velocityshipping\.in|shipfastt\.in|shazam\.velocity\.in|velocity-shazam|ship\.amazon\.in|track\.amazon\.in|\/labels\/amazon\/|\/labels\/velocity\//i.test(
        url
      )
    ) {
      return true;
    }
  }

  // Velocity specific waybill prefixes
  if (wb && /^(PD|VEHR|VEL)[0-9A-Z]+$/i.test(wb)) return true;

  return false;
}

/**
 * True when the courier name, tracking URL, or waybill number matches Delhivery.
 * - Courier name contains "delhivery" (case-insensitive)
 * - Tracking URL contains "delhivery" (e.g. delhivery.com/track, delhivery-express.s3.amazonaws.com)
 * - Or waybill is a 12-15 digit numeric format and courier is generic, blank, or an external OMS marker (e.g. OMS Guru)
 */
export function isDelhiveryCourier(
  courier?: string | null,
  trackingUrl?: string | null,
  waybillNumber?: string | null
): boolean {
  const c = (courier || '').trim();
  const url = (trackingUrl || '').trim();
  const wb = (waybillNumber || '').trim();

  // If courier explicitly contains delhivery or url contains delhivery
  if (DELHIVERY_COURIER_PATTERN.test(c) || (url && /delhivery/i.test(url))) {
    return true;
  }

  // If explicitly identified as Velocity, it is not direct Delhivery
  if (isVelocityCourier(courier, trackingUrl, waybillNumber)) {
    return false;
  }

  // Guard against known third-party couriers
  if (
    c &&
    /bluedart|blue dart|dtdc|ekart|e-kart|shadowfax|xpressbees|xpress bees|ecom express|india post|speed post|smartr|amazon|velocity/i.test(
      c
    )
  ) {
    return false;
  }

  // If waybill is 12-15 digits and courier is generic, absent, or external OMS (e.g. OMS Guru)
  if (wb && /^[0-9]{12,15}$/.test(wb)) {
    if (
      !c ||
      /^(other|surface|express|standard|delhivery|courier|oms\s*guru|omsguru|oms|custom|manual|api|shipway|unicommerce|logistics)$/i.test(
        c
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

/**
 * Resolves standard customer-facing live tracking URL.
 * For Velocity shipments (including Amazon / ATS / Shipfastt via Velocity):
 * returns `https://www.velocityshipping.in/track/${waybillNumber}`
 * For Delhivery shipments:
 * returns `https://www.delhivery.com/track/package/${waybillNumber}`
 */
export function getTrackingUrl(
  courier?: string | null,
  waybillNumber?: string | null,
  existingUrl?: string | null
): string | undefined {
  const wb = (waybillNumber || '').trim();
  if (isVelocityCourier(courier, existingUrl, wb)) {
    return wb ? `https://www.velocityshipping.in/track/${encodeURIComponent(wb)}` : (existingUrl || undefined);
  }
  if (isDelhiveryCourier(courier, existingUrl, wb)) {
    return wb ? `https://www.delhivery.com/track/package/${encodeURIComponent(wb)}` : (existingUrl || undefined);
  }
  if (existingUrl) return existingUrl;
  if (!wb) return undefined;

  const c = (courier || '').toLowerCase();
  if (c.includes('ekart') || c.includes('proship')) return `https://t.proship.in/${encodeURIComponent(wb)}`;
  if (c.includes('bluedart')) return `https://www.bluedart.com/tracking?trackNumber=${encodeURIComponent(wb)}`;
  if (c.includes('dtdc')) return `https://www.dtdc.in/tracking/shipment-tracking.asp?trackingNo=${encodeURIComponent(wb)}`;

  return undefined;
}
