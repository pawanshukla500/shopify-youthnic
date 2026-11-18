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

  it('treats case-only differences as ties, keeping input order both ways', () => {
    const zones = [{ z: 'Zone 2', i: 1 }, { z: 'zone 2', i: 2 }, { z: 'Zone 10', i: 3 }];
    expect(sortRows(zones, 'z', 'asc').map((r) => r.i)).toEqual([1, 2, 3]);
    expect(sortRows(zones, 'z', 'desc').map((r) => r.i)).toEqual([3, 1, 2]);
  });

  it('keeps NaN last and valid numbers in order', () => {
    const vals = [{ v: 3 }, { v: Number.NaN }, { v: 1 }];
    expect(sortRows(vals, 'v', 'asc').map((r) => r.v)).toEqual([1, 3, Number.NaN]);
    expect(sortRows(vals, 'v', 'desc').map((r) => r.v)).toEqual([3, 1, Number.NaN]);
  });

  it('orders mixed number/text columns consistently', () => {
    const mixed = [{ v: -2 as number | string }, { v: '-3' as number | string }, { v: -10 as number | string }];
    expect(sortRows(mixed, 'v', 'asc').map((r) => r.v)).toEqual([-10, -2, '-3']);
    expect(sortRows([...mixed].reverse(), 'v', 'asc').map((r) => r.v)).toEqual([-10, -2, '-3']);
  });

  it('keeps missing values last in both directions and does not mutate input', () => {
    expect(sortRows(rows, 'revenue', 'desc').map((r) => r.state)).toEqual(['maharashtra', 'Delhi', 'Gujarat']);
    expect(sortRows(rows, 'revenue', 'asc').map((r) => r.state)).toEqual(['Delhi', 'maharashtra', 'Gujarat']);
    expect(rows[0].state).toBe('Gujarat');
  });
});
