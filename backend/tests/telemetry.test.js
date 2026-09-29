const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTelemetryStatus,
  normalizeTelemetryEvent,
  presentTelemetryStatus,
  rankTelemetryFailures,
  telemetrySummary,
} = require('../src/utils/telemetry');

describe('telemetry normalization', () => {
  test('accepts common vendor aliases and classifies a numeric low reading', () => {
    const event = normalizeTelemetryEvent({
      source: 'olt-a',
      ont_id: 'ONT-7',
      status: 'online',
      rx_power_dbm: -29.5,
      low_signal_threshold_dbm: -27,
      box_code: 'BOX-B',
      cable_code: 'CBL-D1',
      core_number: 4,
      timestamp: '2026-09-29T10:00:00Z',
    });
    assert.equal(event.external_id, 'ONT-7');
    assert.equal(event.status, 'low_signal');
    assert.equal(event.enclosure_identifier, 'BOX-B');
    assert.equal(event.cable_identifier, 'CBL-D1');
    assert.equal(event.core_identifier, '4');
  });

  test('normalizes link-down values without allowing an explicit down event to become low signal', () => {
    assert.equal(normalizeTelemetryStatus('Link Down'), 'link_down');
    assert.equal(normalizeTelemetryStatus('LOS'), 'link_down');
    const event = normalizeTelemetryEvent({ device_id: 'ONT-8', status: 'offline', rx_power_dbm: -40 });
    assert.equal(event.status, 'link_down');
  });

  test('marks old status stale while retaining its original status', () => {
    const row = presentTelemetryStatus({
      external_id: 'ONT-9', status: 'link_down', reported_at: '2026-09-29T09:00:00Z',
    }, { now: new Date('2026-09-29T09:06:00Z'), staleAfterSeconds: 300 });
    assert.equal(row.status, 'link_down');
    assert.equal(row.state, 'stale');
    assert.equal(row.active, false);
    assert.equal(row.age_seconds, 360);
  });
});

describe('telemetry correlation and ranking', () => {
  test('direct box evidence outranks a cable endpoint and keeps stale devices out', () => {
    const devices = [
      { external_id: 'ONT-A', status: 'link_down', active: true, stale: false, enclosure_id: 'box-a', cable_id: 'cable-a' },
      { external_id: 'ONT-B', status: 'low_signal', active: true, stale: false, cable_id: 'cable-a' },
      { external_id: 'ONT-C', status: 'link_down', active: false, stale: true, enclosure_id: 'box-a' },
    ];
    const result = rankTelemetryFailures(devices, {
      cables: [{ id: 'cable-a', code: 'CBL-A', from_enclosure_id: 'box-root', to_enclosure_id: 'box-a' }],
    });
    assert.equal(result.likely_failure.kind, 'box');
    assert.equal(result.likely_failure.id, 'box-a');
    assert.equal(result.likely_failure.link_down_count, 1);
    assert.equal(result.active_devices.length, 2);
  });

  test('summarizes healthy, bad, stale, and unknown states separately', () => {
    const summary = telemetrySummary([
      { state: 'healthy', active: false, stale: false },
      { state: 'link_down', active: true, stale: false },
      { state: 'low_signal', active: true, stale: false },
      { state: 'stale', active: false, stale: true },
      { state: 'unknown', active: false, stale: false },
    ]);
    assert.deepEqual(summary, { total: 5, healthy: 1, link_down: 1, low_signal: 1, stale: 1, unknown: 1, active: 2 });
  });
});
