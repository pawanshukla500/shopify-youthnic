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
