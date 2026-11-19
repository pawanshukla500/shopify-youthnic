import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allStepIds,
  chooseBranch,
  DEFAULT_WORKFLOW,
  invalidTokens,
  matchesFacts,
  orderFacts,
  parseTokens,
  pickOrder,
  resolveOrderPath,
  routeProgress,
  safeColor,
  type WorkflowDefinition,
} from '../frontend/src/workflow-map';
import type { Order, ReturnRecord, Shipment } from '../frontend/src/types';
import { workflowDesignError } from '../src/modules/workflows/workflow-design';

const order = (overrides: Partial<Order> = {}, shipment?: Partial<Shipment>, returns: Partial<ReturnRecord>[] = []): Order => ({
  id: 1,
  shopifyOrderName: '#26YOU6590',
  status: 'NEW',
  paymentMethod: 'COD',
  financialStatus: 'pending',
  tags: '',
  operationalTab: 'new',
  shipment: shipment ? ({ waybillNumber: null, courier: null, labelUrl: null, status: 'PENDING', ...shipment } as Shipment) : null,
  returns: returns.map((entry, index) => ({ id: index + 1, returnStatus: 'INITIATED', refundStatus: 'NONE', qcStatus: null, isExchange: false, ...entry }) as ReturnRecord),
  ...overrides,
} as Order);

const where = (o: Order, definition: WorkflowDefinition = DEFAULT_WORKFLOW) => resolveOrderPath(definition, orderFacts(o));

describe('order facts', () => {
  it('derives tokens from the order, shipment and newest open return', () => {
    const facts = orderFacts(order(
      { status: 'RETURN_REQUESTED', paymentMethod: 'prepaid', financialStatus: 'paid', operationalTab: 'return' },
      { waybillNumber: 'VELP0315465596', courier: 'Velocity', status: 'DELIVERED' },
      [{ returnStatus: 'CANCELLED' }, { returnStatus: 'QC_PENDING', qcStatus: null }]
    ));
    expect(facts).toEqual(expect.arrayContaining([
      'order:RETURN_REQUESTED', 'tab:RETURN', 'payment:PREPAID', 'shipment:DELIVERED',
      'courier:VELOCITY', 'flow:RETURN', 'return:QC_PENDING', 'refund:NONE',
    ]));
  });

  it('treats an order whose only return is cancelled as a forward order', () => {
    expect(orderFacts(order({}, undefined, [{ returnStatus: 'CANCELLED' }]))).toContain('flow:FORWARD');
  });
});

describe('token parsing', () => {
  it('normalises case and spacing and flags typos', () => {
    expect(parseTokens('order:new,  tab : dispatch\nflow:RETURN & qc:*')).toEqual(['ORDER:NEW', 'TAB:DISPATCH', 'FLOW:RETURN&QC:*']);
    expect(invalidTokens('order:NEW, intransit, :x')).toEqual(['INTRANSIT', ':X']);
  });

  it('matches any token, wildcards and & groups', () => {
    const facts = ['order:IN_TRANSIT', 'courier:VELOCITY'];
    expect(matchesFacts('order:NEW, order:IN_TRANSIT', facts)).toBe(true);
    expect(matchesFacts('courier:*', facts)).toBe(true);
    expect(matchesFacts('return:*', facts)).toBe(false);
    expect(matchesFacts('order:IN_TRANSIT&courier:DELHIVERY', facts)).toBe(false);
    expect(matchesFacts('', facts)).toBe(false);
  });
});

describe('resolveOrderPath on the default design', () => {
  it('puts an unconfirmed COD order at COD confirmation', () => {
    const path = where(order());
    expect(path.currentId).toBe('cod-confirm');
    expect(path.passedIds).toEqual(['received', 'payment-type']);
    expect(path.branches['payment-type']).toBe('COD');
  });

  it('puts an approved prepaid order at Ready to dispatch', () => {
    expect(where(order({ paymentMethod: 'prepaid', financialStatus: 'paid', operationalTab: 'dispatch' })).currentId).toBe('ready');
  });

  it('follows the Velocity branch for an in-transit Velocity parcel', () => {
    const path = where(order({ status: 'IN_TRANSIT', operationalTab: 'transit' }, { waybillNumber: 'VELP1', courier: 'Velocity', status: 'IN_TRANSIT' }));
    expect(path.currentId).toBe('in-transit');
    expect(path.branches.courier).toBe('Velocity');
    expect(path.passedIds).toContain('velocity-awb');
    expect(path.passedIds).not.toContain('delhivery-awb');
  });

  it('does not mark later stages as passed for a cancel before pickup', () => {
    const path = where(order({ status: 'CANCELLED', operationalTab: 'cancel' }));
    expect(path.currentId).toBe('cancelled');
    expect(path.passedIds).not.toContain('ready');
    expect(path.passedIds).not.toContain('in-transit');
  });

  it('sends a cancel after pickup to transit or RTO, not "Cancelled before pickup"', () => {
    const moving = where(order({ status: 'CANCELLED', operationalTab: 'transit' }, { waybillNumber: 'VELP2', courier: 'Velocity', status: 'IN_TRANSIT' }));
    expect(moving.currentId).toBe('in-transit');
    const returning = where(order({ status: 'CANCELLED', operationalTab: 'return' }, { waybillNumber: 'VELP3', courier: 'Velocity', status: 'IN_TRANSIT' }));
    expect(returning.branches['delivery-outcome']).toBe('NDR / RTO');
    expect(returning.currentId).toBe('rto-transit');
    expect(returning.passedIds).not.toContain('cancelled');
  });

  it('places a return at its latest stage even when the order status lags', () => {
    const path = where(order(
      { status: 'RETURN_REQUESTED', operationalTab: 'return' },
      { waybillNumber: '1490', courier: 'Delhivery', status: 'DELIVERED' },
      [{ returnStatus: 'QC_PENDING' }]
    ));
    expect(path.currentId).toBe('return-qc');
    expect(path.passedIds).toEqual(expect.arrayContaining(['delivered', 'return-requested', 'return-received']));
    expect(path.branches['after-delivery']).toBe('Return');
  });

  it('tracks an exchange to the replacement leg', () => {
    const path = where(order(
      { status: 'EXCHANGE_REQUESTED', operationalTab: 'return' },
      { waybillNumber: '1490', courier: 'Delhivery', status: 'DELIVERED' },
      [{ isExchange: true, returnStatus: 'RECEIVED', exchangeForwardStatus: 'IN_TRANSIT' }]
    ));
    expect(path.currentId).toBe('replacement-shipped');
  });

  it('sends a prepaid RTO refund down the NDR / RTO branch', () => {
    const path = where(order({ status: 'REFUNDED', paymentMethod: 'prepaid', operationalTab: 'return' }, { waybillNumber: '1490', status: 'RTO_DELIVERED' }));
    expect(path.branches['delivery-outcome']).toBe('NDR / RTO');
    expect(path.currentId).toBe('rto-refund');
  });

  it('returns no current step when nothing in the design matches', () => {
    const empty: WorkflowDefinition = { properties: {}, sequence: [{ id: 'a', componentType: 'task', type: 'order', name: 'A', properties: { states: 'order:DELIVERED' } }] };
    expect(where(order(), empty)).toEqual({ currentId: null, passedIds: [], routeIds: ['a'], branches: {} });
  });
});

describe('chooseBranch', () => {
  const decision = (conditions: Record<string, string>) => ({
    id: 'd', componentType: 'switch', type: 'decision', name: 'D',
    properties: { conditions },
    branches: Object.fromEntries(Object.keys(conditions).map((name) => [name, []])),
  });
  it('uses only a blank condition as the default, never a mistyped one', () => {
    expect(chooseBranch(decision({ Typo: 'courier xpressbees', Default: '' }), ['order:NEW'])).toBe('Default');
    expect(chooseBranch(decision({ Typo: 'courier xpressbees' }), ['order:NEW'])).toBeNull();
    expect(chooseBranch(decision({ A: 'order:NEW', Default: '' }), ['order:NEW'])).toBe('A');
  });
});

describe('default design', () => {
  const tokens = JSON.stringify(DEFAULT_WORKFLOW).toUpperCase();
  const enumValues = (name: string) => {
    const schema = readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8');
    const body = schema.match(new RegExp(`enum ${name} \\{([^}]*)\\}`))![1];
    return body.split('\n').map((line) => line.replace(/\/\/.*/, '').trim()).filter(Boolean);
  };

  it('maps every Prisma OrderStatus and every non-cancelled ReturnStatus to a stage', () => {
    for (const status of enumValues('OrderStatus')) expect(tokens, `order:${status}`).toContain(`ORDER:${status}`);
    for (const status of enumValues('ReturnStatus').filter((s) => s !== 'CANCELLED')) expect(tokens, `return:${status}`).toContain(`RETURN:${status}`);
  });

  it('is accepted by the save API validator and has unique ids', () => {
    expect(workflowDesignError(DEFAULT_WORKFLOW)).toBeNull();
    const ids = allStepIds(DEFAULT_WORKFLOW.sequence);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('save API validator', () => {
  const step = { id: 'a', componentType: 'task', type: 'order', name: 'A', properties: {} };
  it.each([
    [null, 'sequence'],
    [{ properties: {}, sequence: [{ ...step, id: '' }] }, 'id, name'],
    [{ properties: {}, sequence: [step, step] }, 'duplicate'],
    [{ properties: {}, sequence: [{ ...step, componentType: 'container' }] }, 'unsupported'],
    [{ properties: {}, sequence: [{ ...step, componentType: 'switch', branches: { Yes: 'x' } }] }, 'invalid branch'],
    // 100k three-byte characters: under the limit in UTF-16 units, over it in bytes.
    [{ properties: { name: '₹'.repeat(100_000) }, sequence: [step] }, 'too large'],
  ])('rejects %j', (definition, message) => {
    expect(workflowDesignError(definition)).toContain(message);
  });
});

describe('canvas helpers', () => {
  it('accepts only plain #rrggbb colours, since they are written into a stylesheet', () => {
    expect(safeColor('#2563eb')).toBe('#2563eb');
    expect(safeColor('#2563EB')).toBe('#2563EB');
    for (const bad of ['red', '#fff', 'red; } body { display: none', '#2563eb;', '', null, 7]) expect(safeColor(bad)).toBeNull();
  });

  it('counts progress in stages and adds the longest branch of decisions not reached yet', () => {
    // COD, Velocity, in transit: received, cod-confirm, ready, velocity-awb, picked-up, in-transit (6th) and
    // out-for-delivery are walked; "Delivery outcome" is undecided, its longest branch is
    // Delivered (1) + Return (4 + QC passed 2) = 7, so 7 + 7 = 14 stages.
    const transit = where(order({ status: 'IN_TRANSIT', operationalTab: 'transit' }, { waybillNumber: 'VELP1', courier: 'Velocity', status: 'IN_TRANSIT' }));
    expect(routeProgress(DEFAULT_WORKFLOW, transit)).toEqual({ stage: 6, stages: 14 });

    const closed = where(order({ status: 'DELIVERED', operationalTab: 'closed' }, { waybillNumber: 'VELP1', courier: 'Velocity', status: 'DELIVERED' }));
    expect(routeProgress(DEFAULT_WORKFLOW, closed)).toEqual({ stage: 9, stages: 9 });

    expect(routeProgress(DEFAULT_WORKFLOW, { currentId: null, passedIds: [], routeIds: [], branches: {} })).toBeNull();
  });
});

describe('pickOrder', () => {
  const a = order({ id: 1, shopifyOrderName: '#26YOU65901' });
  const b = order({ id: 2, shopifyOrderName: '#26YOU6590' }, { waybillNumber: 'VELP77' }, [{ returnWaybillNumber: 'RVP9' }]);
  it('prefers an exact order name or AWB over a partial search hit', () => {
    expect(pickOrder([a, b], '#26YOU6590')?.id).toBe(2);
    expect(pickOrder([a, b], '26you6590')?.id).toBe(2);
    expect(pickOrder([a, b], 'VELP77')?.id).toBe(2);
    expect(pickOrder([a, b], 'rvp9')?.id).toBe(2);
    expect(pickOrder([a, b], '26YOU')?.id).toBe(1);
    expect(pickOrder([], 'x')).toBeNull();
  });
});
