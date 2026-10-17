/**
 * Warehouse pickup scheduling helpers.
 *
 * Delhivery B2C pickup request (POST /fm/request/new/) tells the field
 * executive to collect manifested forward parcels from a registered warehouse.
 * Only one pickup can be open per warehouse; another can be created after
 * that one is completed.
 *
 * Reverse (customer) pickups do not use this API. Manifesting a shipment with
 * payment_mode "Pickup" schedules that doorstep pickup automatically.
 */

export interface PickupSlot {
  date: string;
  time: string;
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Calendar date in Asia/Kolkata, from a UTC instant. */
export function istDateParts(now: Date): { year: number; month: number; day: number; minutes: number } {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return {
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth() + 1,
    day: ist.getUTCDate(),
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
  };
}

export function formatIstDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function addIstDays(year: number, month: number, day: number, days: number): string {
  const utc = Date.UTC(year, month - 1, day) + days * 24 * 60 * 60 * 1000;
  const next = new Date(utc);
  return formatIstDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** "11:00:00" / "11:00" → minutes from midnight. Invalid values fall back to 11:00. */
export function parseClockMinutes(value: string | undefined, fallback = 11 * 60): number {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((value || '').trim());
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallback;
  return hours * 60 + minutes;
}

export function minutesToClock(total: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, total));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${pad(hours)}:${pad(minutes)}:00`;
}

/**
 * Pick a pickup slot the field executive can still honour.
 * Working window is 10:00–18:00 IST. A request needs ~90 minutes of lead time.
 * After 16:30 IST the slot moves to the next day at the configured time.
 */
export function planWarehousePickupSlot(now: Date, configuredTime: string): PickupSlot {
  const parts = istDateParts(now);
  const today = formatIstDate(parts.year, parts.month, parts.day);
  const configured = parseClockMinutes(configuredTime, 11 * 60);
  const latestSameDayStart = 16 * 60 + 30;

  if (parts.minutes >= latestSameDayStart) {
    return {
      date: addIstDays(parts.year, parts.month, parts.day, 1),
      time: minutesToClock(configured),
    };
  }

  const earliest = parts.minutes + 90;
  const chosen = Math.max(configured, earliest);
  const rounded = Math.ceil(chosen / 30) * 30;
  const clamped = Math.min(Math.max(rounded, 10 * 60), 18 * 60);
  return { date: today, time: minutesToClock(clamped) };
}

/** Manifest day is IST, independently of the host timezone. */
export function nextDayWarehousePickupSlot(now: Date, configuredTime: string): PickupSlot {
  const parts = istDateParts(now);
  return {
    date: addIstDays(parts.year, parts.month, parts.day, 1),
    time: minutesToClock(parseClockMinutes(configuredTime, 14 * 60)),
  };
}

export function readPickupId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const bag = data as Record<string, any>;
  const nested = bag.data && typeof bag.data === 'object' ? bag.data : {};
  const raw = bag.pickup_id ?? bag.pickupId ?? nested.pickup_id ?? nested.pickupId;
  if (raw == null || raw === '' || typeof raw === 'boolean' || String(raw) === '0' || !/^[a-zA-Z0-9_-]{1,100}$/.test(String(raw))) return null;
  return String(raw);
}

/**
 * Delhivery rejects a second open pickup for the same warehouse.
 * This is not proof our requested date was accepted; the caller must not mark it scheduled.
 */
export function isExistingPickupError(message: string): boolean {
  const text = (message || '').toLowerCase();
  if (!text) return false;
  return (
    /already (exist|exists|created|scheduled|open)/.test(text) ||
    /pickup request.*(exist|exists|open|pending|scheduled)/.test(text) ||
    /duplicate pickup/.test(text) ||
    /another pickup/.test(text)
  );
}
