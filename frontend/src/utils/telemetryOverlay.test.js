import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { impactOverlay, impactCableStyle, impactBoxState } from './impactOverlay.js';

describe('live telemetry overlay', () => {
  const snapshot = {
    source: 'olt-lab',
    summary: { active: 2, link_down: 1, low_signal: 1, stale: 1 },
    devices: [
      { source: 'olt-lab', external_id: 'ONT-1', state: 'link_down', status: 'link_down', active: true, stale: false, enclosure_id: 'box-a', cable_id: 'cable-a', lat: 34, lng: 71 },
      { source: 'olt-lab', external_id: 'ONT-2', state: 'low_signal', status: 'low_signal', active: true, stale: false, enclosure_id: 'box-b', cable_id: 'cable-b' },
      { source: 'olt-lab', external_id: 'ONT-3', state: 'stale', status: 'link_down', active: false, stale: true, enclosure_id: 'box-c', cable_id: 'cable-c' },
    ],
  };

  it('highlights active link-down and low-signal relationships, not stale rows', () => {
    const overlay = impactOverlay(null, snapshot);
    assert.equal(overlay.active, true);
    assert.equal(overlay.telemetryDownBoxIds.has('box-a'), true);
    assert.equal(overlay.telemetryLowSignalBoxIds.has('box-b'), true);
    assert.equal(overlay.telemetryDownBoxIds.has('box-c'), false);
    assert.equal(impactCableStyle('cable-a', overlay).telemetry, 'link_down');
    assert.equal(impactCableStyle('cable-b', overlay).telemetry, 'low_signal');
  });

  it('keeps manual downstream impact precedence over telemetry styling', () => {
    const impact = { failure: { cable_ids: ['cable-a'], box_ids: ['box-a'] }, affected: { cable_ids: ['cable-a'], box_ids: ['box-a'], customer_count: 1 } };
    const overlay = impactOverlay(impact, snapshot);
    assert.equal(impactCableStyle('cable-a', overlay).color, '#ef5350');
    assert.deepEqual(impactBoxState('box-a', overlay), { dark: true, failed: true, telemetry: 'link_down' });
  });
});
