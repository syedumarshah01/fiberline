/**
 * Worksheet helpers for the browser side: remembering which steps a technician
 * has ticked, and turning a sheet into something they can keep.
 *
 * The checklist itself comes from the API (`/api/work-orders/:boxId`), generated
 * from the box's documentation — this file never invents a step. Ticks are kept
 * in localStorage per box *and per date*: a sheet regenerated tomorrow is a new
 * day's work, and showing yesterday's ticks would be a lie about work done.
 */

const STORAGE_PREFIX = 'fiberline:worksheet:';

/** The key a box's ticks live under for one work-order reference. */
export function progressKey(reference) {
  return `${STORAGE_PREFIX}${reference}`;
}

function storageOf(store) {
  if (store) return store;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // private mode, or a blocked storage policy
  }
}

/** Which steps are ticked, as an array of step numbers. */
export function readProgress(reference, { store = null } = {}) {
  const target = storageOf(store);
  if (!target) return [];
  try {
    const raw = target.getItem(progressKey(reference));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

/** Tick or untick one step; returns the new list. */
export function toggleStep(reference, step, { store = null } = {}) {
  const current = new Set(readProgress(reference, { store }));
  if (current.has(step)) current.delete(step);
  else current.add(step);
  const next = [...current].sort((a, b) => a - b);
  writeProgress(reference, next, { store });
  return next;
}

function writeProgress(reference, steps, { store = null } = {}) {
  const target = storageOf(store);
  if (!target) return false;
  try {
    if (!steps.length) target.removeItem(progressKey(reference));
    else target.setItem(progressKey(reference), JSON.stringify(steps));
    return true;
  } catch {
    return false; // quota, or storage refused — the sheet still works untracked
  }
}

/** How far along the job is: `{ done, total, steps, label }`. */
export function progressFor(order, { store = null } = {}) {
  const steps = (order?.checklist || []).filter((item) => !item.info && item.step);
  const done = new Set(readProgress(order?.work_order?.reference, { store }));
  const ticked = steps.filter((item) => done.has(item.step)).length;
  return {
    done: ticked,
    total: steps.length,
    steps,
    label: `${ticked}/${steps.length}`,
    complete: steps.length > 0 && ticked === steps.length,
  };
}

/** "as needed" for a material with no count. */
export function quantityLabel(material) {
  return material?.quantity == null ? 'as needed' : `×${material.quantity}`;
}

/**
 * A filename for the downloaded sheet: `WO-BOX-MID-20260925.txt`. The reference
 * is already unique per box per day; anything odd in it is flattened.
 */
export function sheetFilename(order, extension = 'txt') {
  const reference = order?.work_order?.reference || 'worksheet';
  return `${String(reference).replace(/[^A-Za-z0-9._-]+/g, '-')}.${extension}`;
}

/** The label printed under a QR sticker: the code, and what it is. */
export function labelCaption(kind, codeOrName) {
  const noun = { pole: 'Pole', box: 'Box', enclosure: 'Box', cable: 'Cable', customer: 'Customer' };
  return `${noun[String(kind).toLowerCase()] || 'Tag'} ${codeOrName || ''}`.trim();
}
