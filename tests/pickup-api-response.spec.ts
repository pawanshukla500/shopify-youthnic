import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import MockAdapter from 'axios-mock-adapter';
import delhivery from '../src/modules/delhivery/delhivery.service';
let adapter: MockAdapter;
beforeEach(() => { adapter = new MockAdapter((delhivery as any).client); });
afterEach(() => adapter.restore());
describe('pickup acknowledgement', () => {
  it('sends the documented four fields and requires a pickup ID', async () => {
    adapter.onPost('/fm/request/new/').reply((request) => {
      expect(JSON.parse(request.data)).toEqual({ pickup_time: '14:00:00', pickup_date: '2026-12-31', pickup_location: 'Test Warehouse', expected_package_count: 12 });
      return [201, { pickup_id: 98765 }];
    });
    expect(await delhivery.requestPickup('2026-12-31', '14:00:00', 12, 'Test Warehouse')).toMatchObject({ success: true, pickupId: '98765' });
  });
  it('does not consider an HTTP 200 rejection or unknown payload scheduled', async () => {
    adapter.onPost('/fm/request/new/').replyOnce(200, { success: false, error: 'Rejected' });
    expect((await delhivery.requestPickup()).success).toBe(false);
    adapter.onPost('/fm/request/new/').replyOnce(200, {});
    expect(await delhivery.requestPickup()).toMatchObject({ success: false, uncertain: true });
  });
  it('treats timeout as review and an existing-open rejection as unconfirmed date', async () => {
    adapter.onPost('/fm/request/new/').timeoutOnce();
    expect(await delhivery.requestPickup()).toMatchObject({ success: false, uncertain: true });
    adapter.onPost('/fm/request/new/').replyOnce(400, { rmk: 'Another pickup already exists' });
    expect(await delhivery.requestPickup()).toMatchObject({ success: false, alreadyOpen: true, uncertain: false });
  });
});
