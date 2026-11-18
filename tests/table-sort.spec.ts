import { describe, expect, it } from 'vitest';
import { sortRows } from '../frontend/src/lib';

const rows = [
  { state: 'Gujarat', orders: 201, revenue: null as number | null },
  { state: 'maharashtra', orders: 312, revenue: 301220.5 },
  { state: 'Delhi', orders: 9, revenue: 1200 },
];

describe('sortRows (sortable report tables)', () => {
  it('sorts numbers numerically, not as text', () => {
    expect(sortRows(rows, 'orders', 'desc').map((r) => r.orders)).toEqual([312, 201, 9]);
    expect(sortRows(rows, 'orders', 'asc').map((r) => r.orders)).toEqual([9, 201, 312]);
  });

  it('sorts text case-insensitively', () => {
    expect(sortRows(rows, 'state', 'asc').map((r) => r.state)).toEqual(['Delhi', 'Gujarat', 'maharashtra']);
  });

  it('keeps missing values last in both directions and does not mutate input', () => {
    expect(sortRows(rows, 'revenue', 'desc').map((r) => r.state)).toEqual(['maharashtra', 'Delhi', 'Gujarat']);
    expect(sortRows(rows, 'revenue', 'asc').map((r) => r.state)).toEqual(['Delhi', 'maharashtra', 'Gujarat']);
    expect(rows[0].state).toBe('Gujarat');
  });
});
