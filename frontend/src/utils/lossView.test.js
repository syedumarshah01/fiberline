import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OLT_TYPE_LABELS,
  formatDb,
  lossEntryClass,
  lossSourceLabel,
  budgetStatusClass,
  spliceLossClass,
  splitterLabel,
} from './lossView.js';

describe('formatDb', () => {
  it('formats numbers with two decimals', () => {
    assert.equal(formatDb(0.35), '0.35');
    assert.equal(formatDb(1.2), '1.20');
    assert.equal(formatDb(28), '28.00');
    assert.equal(formatDb('17.1'), '17.10'); // pg decimals arrive as strings
  });

  it('renders missing values as a dash', () => {
    assert.equal(formatDb(null), '—');
    assert.equal(formatDb(undefined), '—');
    assert.equal(formatDb(''), '—');
    assert.equal(formatDb('n/a'), '—');
  });
});

describe('lossEntryClass — verified vs assumed vs flagged', () => {
  it('measured entries are teal', () => {
    assert.equal(lossEntryClass({ measured: true, loss_db: 0.12 }), 'loss-measured');
  });

  it('defaulted entries are amber', () => {
    assert.equal(lossEntryClass({ measured: false, loss_db: 0.1 }), 'loss-assumed');
  });

  it('a flagged bad splice is red and beats measured', () => {
    assert.equal(lossEntryClass({ measured: true, loss_db: 0.9, flagged: 'bad_splice' }), 'loss-flagged');
  });

  it('fiber entries with problems read as attention-worthy', () => {
    assert.equal(lossEntryClass({ type: 'fiber', length_missing: true }), 'loss-assumed');
    assert.equal(lossEntryClass({ type: 'fiber', duplicate_cable: true }), 'loss-assumed');
  });

  it('plain fiber entries are neutral', () => {
    assert.equal(lossEntryClass({ type: 'fiber', loss_db: 0.7 }), 'loss-neutral');
    assert.equal(lossEntryClass(null), 'loss-neutral');
  });
});

describe('lossSourceLabel', () => {
  it('explains where each number came from', () => {
    assert.equal(lossSourceLabel({ measured: true }), 'measured');
    assert.equal(lossSourceLabel({ measured: false }), 'assumed (default)');
    assert.equal(lossSourceLabel({ flagged: 'bad_splice' }), 'bad splice — re-splice');
    assert.equal(lossSourceLabel({ type: 'fiber' }), 'calculated');
    assert.equal(lossSourceLabel({ length_missing: true }), 'length unknown');
    assert.equal(lossSourceLabel({ duplicate_cable: true }), 'same cable — not re-counted');
  });
});

describe('budgetStatusClass', () => {
  it('maps status to color classes', () => {
    assert.equal(budgetStatusClass('OK'), 'loss-status-ok');
    assert.equal(budgetStatusClass('MARGINAL'), 'loss-status-marginal');
    assert.equal(budgetStatusClass('FAIL'), 'loss-status-fail');
    assert.equal(budgetStatusClass(undefined), 'loss-status-fail');
  });
});

describe('spliceLossClass — box documentation QC coloring', () => {
  it('flags readings above the bad-splice threshold', () => {
    assert.equal(spliceLossClass(0.62), 'loss-flagged');
    assert.equal(spliceLossClass(0.51, 0.5), 'loss-flagged');
  });

  it('healthy readings are teal', () => {
    assert.equal(spliceLossClass(0.12), 'loss-measured');
    assert.equal(spliceLossClass(0.5), 'loss-measured'); // exactly at threshold is fine
  });

  it('no reading at all is neutral', () => {
    assert.equal(spliceLossClass(null), 'loss-neutral');
    assert.equal(spliceLossClass(''), 'loss-neutral');
  });
});

describe('splitterLabel', () => {
  it('shows the ratio for unnamed splitters', () => {
    assert.equal(splitterLabel({ split_count: 4 }), '1:4');
  });

  it('shows name and ratio for named ones', () => {
    assert.equal(splitterLabel({ name: 'Tray A', split_count: 8 }), 'Tray A · 1:8');
  });

  it('degrades gracefully', () => {
    assert.equal(splitterLabel({}), 'splitter');
    assert.equal(splitterLabel(null), 'splitter');
  });
});

describe('OLT_TYPE_LABELS', () => {
  it('covers the three budgeted transport types', () => {
    assert.deepEqual(Object.keys(OLT_TYPE_LABELS).sort(), ['gpon', 'p2p', 'xgs_pon']);
  });
});
