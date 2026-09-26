/**
 * Prop wiring between App, RightPanel and the panels it renders.
 *
 * This is not an architecture test — it is a guard against the failure that cost
 * time twice while building the serviceability panel: a component destructures a
 * prop, the caller never passes it, and React reports nothing at all. The prop is
 * simply `undefined`, the feature silently does nothing, and the first person to
 * notice is a user.
 *
 * It reads the JSX as text (no build step, no DOM) and checks the names line up.
 * Deliberately narrow: only the panels the calls in question touch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(join(here, relative), 'utf8');

/** Prop names destructured by `function Name({ … })` (or `export default`). */
function destructuredProps(source, componentName) {
  const pattern = new RegExp(
    `function\\s+${componentName}\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`,
    'm',
  );
  const match = source.match(pattern);
  if (!match) return null;
  return match[1]
    .split(/[,\n]/)
    .map((entry) => entry.split(':')[0].split('=')[0].trim())
    .filter(Boolean);
}

/** Attribute names passed at a `<Component … />` call site. */
function passedProps(source, componentName) {
  const pattern = new RegExp(`<${componentName}\\b([\\s\\S]*?)/>`, 'm');
  const match = source.match(pattern);
  if (!match) return null;
  const attributes = match[1].matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)\s*=/g);
  return [...attributes].map((m) => m[1]);
}

test('every prop RightPanel destructures is passed by App', () => {
  const app = read('../App.jsx');
  const rightPanel = read('../components/RightPanel.jsx');
  const wanted = destructuredProps(rightPanel, 'RightPanel');
  const passed = passedProps(app, 'RightPanel');
  assert.ok(wanted && wanted.length > 5, 'parsed the RightPanel signature');
  assert.ok(passed && passed.length > 5, 'parsed the RightPanel call site');
  const missing = wanted.filter((prop) => !passed.includes(prop));
  assert.deepEqual(missing, [], `App does not pass: ${missing.join(', ')}`);
});

test('every prop the serviceability panel destructures is passed by RightPanel', () => {
  const rightPanel = read('../components/RightPanel.jsx');
  const wanted = destructuredProps(rightPanel, 'CustomerLookupPanel');
  const passed = passedProps(rightPanel, 'CustomerLookupPanel');
  assert.ok(wanted && wanted.length > 5, 'parsed the panel signature');
  const missing = wanted.filter((prop) => !passed.includes(prop));
  assert.deepEqual(missing, [], `RightPanel does not pass: ${missing.join(', ')}`);
});

test('one check feeds both the panel and the route the map draws', () => {
  // The panel and the polyline come from the same call, so they cannot disagree:
  // App runs the check, puts the answer in state, and hands the route to the maps.
  const app = read('../App.jsx');
  assert.match(app, /<RightPanel[\s\S]*?serviceability=\{serviceability\}/);
  assert.match(app, /api\s*\n?\s*\.checkServiceability/);
  assert.match(app, /setCustomerRoute\(/);
  assert.match(app, /customerRoute=\{customerRoute\}/, 'the map views still get the route');
});

test('the empty-state copy still points at the map click the check needs', () => {
  const rightPanel = read('../components/RightPanel.jsx');
  assert.match(rightPanel, /Click the map at the customer/);
});
