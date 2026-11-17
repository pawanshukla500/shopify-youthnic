export interface SettlementRow { orderId?: number; utr?: string | null; remittanceRef?: string | null }

export function settlementEvidence(rows: SettlementRow[]) {
  const utrs = [...new Set(rows.map((row) => row.utr?.trim()).filter((utr): utr is string => Boolean(utr)))];
  const refs = [...new Set(rows.map((row) => row.remittanceRef?.trim()).filter((ref): ref is string => Boolean(ref)))];
  const missingUtrCount = rows.filter((row) => !row.utr?.trim()).length;
  return {
    bankTransactionId: utrs.length === 1 && !missingUtrCount ? utrs[0] : null,
    bankTransactionIds: utrs, missingUtrCount, settlementRefs: refs,
    state: rows.length > 0 && missingUtrCount === 0 ? 'Completed' as const : 'Pending' as const,
    singleSettlement: refs.length === 1 && rows.every((row) => row.remittanceRef === refs[0]),
  };
}

export function istDateRange(startDate: string, endDate: string) {
  const parse = (text: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('Dates must use YYYY-MM-DD.');
    const utc = new Date(`${text}T00:00:00Z`);
    if (!Number.isFinite(utc.getTime()) || utc.toISOString().slice(0, 10) !== text) throw new Error('Invalid calendar date.');
    return new Date(`${text}T00:00:00+05:30`);
  };
  const start = parse(startDate), lastDay = parse(endDate);
  if (lastDay < start) throw new Error('End date must not be before start date.');
  return { start, end: new Date(lastDay.getTime() + 24 * 3600 * 1000) };
}

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/** Convert `period` into IST (+05:30) boundaries so server timezone (UTC on VPS) never shifts "today". */
export function dashboardPeriodRange(period: string, now = new Date()): { gte?: Date; lt?: Date } {
  const key = period.toLowerCase();
  if (!key || key === 'all') return {};
  const istDay = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  const todayStr = istDay(now);
  if (key === 'today') {
    const r = istDateRange(todayStr, todayStr);
    return { gte: r.start, lt: r.end };
  }
  if (key === 'yesterday') {
    const yStr = istDay(new Date(now.getTime() - 24 * 3600 * 1000));
    const r = istDateRange(yStr, yStr);
    return { gte: r.start, lt: r.end };
  }
  if (key === '7days') {
    const sevenStr = istDay(new Date(now.getTime() - 6 * 24 * 3600 * 1000));
    return { gte: istDateRange(sevenStr, todayStr).start };
  }
  if (key === 'month') {
    return { gte: istDateRange(`${todayStr.slice(0, 7)}-01`, todayStr).start };
  }
  return {};
}
