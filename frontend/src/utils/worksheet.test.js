/**
 * Unit tests for the browser-side worksheet helpers: which steps are ticked, and
 * how a sheet is labelled and saved.
 *
 * Ticks are per work order, and a work order is per box per day — a sheet
 * regenerated tomorrow must not look half-done because somebody ticked things
 * yesterday. That is the behaviour worth pinning here.
 *
 * Run with: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  progressKey,
  readProgress,
  toggleStep,
  progressFor,
  quantityLabel,
  sheetFilename,
  labelCaption,
} from './worksheet.js';

/** A stand-in for localStorage, so these tests never need a browser. */
function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    size: () => data.size,
  };
}

const order = (reference = 'WO-BOX-MID-20260925') => ({
  work_order: { reference },
  checklist: [
    { step: 1, task: 'Re-splice CBL-F1 #1 ↔ CBL-D2 #1' },
    { step: 2, task: 'Check and repair CBL-D2 #2' },
    { info: true, step: null, task: 'Spare fibres here: 1' },
    { step: 3, task: 'Photograph the tray layout before closing the box' },
    { step: 4, task: 'Close the box, note the date and your name on the job' },
  ],
});

describe('progressKey', () => {
  it('is namespaced and keys on the work order, not the box alone', () => {
    assert.equal(progressKey('WO-BOX-MID-20260925'), 'fiberline:worksheet:WO-BOX-MID-20260925');
    assert.notEqual(progressKey('WO-BOX-MID-20260925'), progressKey('WO-BOX-MID-20260926'));
  });
});

describe('readProgress / toggleStep', () => {
  it('starts empty, ticks a step and unticks it again', () => {
    const store = fakeStore();
    assert.deepEqual(readProgress('WO-1', { store }), []);
    assert.deepEqual(toggleStep('WO-1', 2, { store }), [2]);
    assert.deepEqual(toggleStep('WO-1', 1, { store }), [1, 2]); // sorted
    assert.deepEqual(toggleStep('WO-1', 2, { store }), [1]);
    assert.deepEqual(readProgress('WO-1', { store }), [1]);
  });

  it('keeps each work order separate — yesterday is not half-done today', () => {
    const store = fakeStore();
    toggleStep('WO-BOX-A-20260925', 1, { store });
    toggleStep('WO-BOX-A-20260925', 2, { store });
    assert.deepEqual(readProgress('WO-BOX-A-20260926', { store }), []);
    assert.deepEqual(readProgress('WO-BOX-A-20260925', { store }), [1, 2]);
  });

  it('forgets the key entirely when nothing is ticked, rather than storing []', () => {
    const store = fakeStore();
    toggleStep('WO-1', 1, { store });
    assert.equal(store.size(), 1);
    toggleStep('WO-1', 1, { store });
    assert.equal(store.size(), 0);
  });

  it('survives storage that is full, missing, or holding rubbish', () => {
    // Private mode, a blocked policy, or a different app version's leftovers.
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); }, removeItem: () => {} };
    assert.deepEqual(readProgress('WO-1', { store: broken }), []);
    assert.equal(toggleStep('WO-1', 1, { store: broken }).length, 1); // still returns the new state
    assert.deepEqual(readProgress('WO-1', { store: fakeStore({ 'fiberline:worksheet:WO-1': 'not json' }) }), []);
    assert.deepEqual(readProgress('WO-1', { store: fakeStore({ 'fiberline:worksheet:WO-1': '{"a":1}' }) }), []);
    assert.deepEqual(
      readProgress('WO-1', { store: fakeStore({ 'fiberline:worksheet:WO-1': '[1,"two",null,3,-4,0]' }) }),
      [1, 3],
    );
  });
});

describe('progressFor', () => {
  it('counts the work, never the informational line', () => {
    const store = fakeStore();
    const progress = progressFor(order(), { store });
    assert.equal(progress.total, 4); // not 5: the spare-fibre line is not a step
    assert.equal(progress.done, 0);
    assert.equal(progress.label, '0/4');
    assert.equal(progress.complete, false);
  });

  it('reports done out of total as steps are ticked, and complete at the end', () => {
    const store = fakeStore();
    const sheet = order();
    for (const step of [1, 2, 3]) toggleStep(sheet.work_order.reference, step, { store });
    assert.equal(progressFor(sheet, { store }).label, '3/4');
    assert.equal(progressFor(sheet, { store }).complete, false);
    toggleStep(sheet.work_order.reference, 4, { store });
    assert.equal(progressFor(sheet, { store }).label, '4/4');
    assert.equal(progressFor(sheet, { store }).complete, true);
  });

  it('an empty sheet is never "complete" — there was no work to finish', () => {
    const sheet = { work_order: { reference: 'WO-EMPTY-20260925' }, checklist: [] };
    const progress = progressFor(sheet, { store: fakeStore() });
    assert.equal(progress.label, '0/0');
    assert.equal(progress.complete, false);
  });

  it('copes with no order at all (the panel paints before the fetch answers)', () => {
    const progress = progressFor(null, { store: fakeStore() });
    assert.equal(progress.total, 0);
    assert.equal(progress.label, '0/0');
  });
});

describe('labels and filenames', () => {
  it('prints "as needed" for a material with no count, and the count when there is one', () => {
    assert.equal(quantityLabel({ quantity: null }), 'as needed');
    assert.equal(quantityLabel({ quantity: 3 }), '×3');
    assert.equal(quantityLabel({}), 'as needed');
    assert.equal(quantityLabel(undefined), 'as needed');
  });

  it('names the downloaded sheet after the work order', () => {
    assert.equal(sheetFilename(order()), 'WO-BOX-MID-20260925.txt');
    assert.equal(sheetFilename(order(), 'svg'), 'WO-BOX-MID-20260925.svg');
    assert.equal(sheetFilename({}), 'worksheet.txt');
    // A reference with something odd in it cannot escape into a path.
    assert.equal(sheetFilename({ work_order: { reference: 'WO/BOX MID#1' } }), 'WO-BOX-MID-1.txt');
  });

  it('captions a sticker the way it should read on the pole', () => {
    assert.equal(labelCaption('box', 'BOX-MID'), 'Box BOX-MID');
    assert.equal(labelCaption('pole', 'P-0001'), 'Pole P-0001');
    assert.equal(labelCaption('enclosure', 'BOX-A'), 'Box BOX-A');
    assert.equal(labelCaption('customer', 'CUST-1'), 'Customer CUST-1');
    assert.equal(labelCaption('box', null), 'Box');
  });
});
