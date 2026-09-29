/**
 * Unit tests for the deep links a QR sticker carries.
 *
 * This is the part of the feature that a technician never sees and always
 * depends on: if `?box=<uuid>` stops being understood, the sticker on the pole
 * becomes a piece of plastic that opens an empty map.
 *
 * Run with: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseDeepLink, buildDeepLink, qrPath, KIND_PARAM, syncLocation } from './deepLink.js';

const BOX_ID = '3f9a1c2e-4b5d-4e6f-8a90-1234567890ab';
const POLE_ID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';

describe('parseDeepLink', () => {
  it('reads the query parameter a scanned tag carries', () => {
    assert.deepEqual(parseDeepLink(`?box=${BOX_ID}`), { kind: 'box', id: BOX_ID });
    assert.deepEqual(parseDeepLink(`pole=${POLE_ID}`), { kind: 'pole', id: POLE_ID });
    assert.deepEqual(parseDeepLink(`?cable=${BOX_ID}&other=1`), { kind: 'cable', id: BOX_ID });
  });

  it('treats enclosure and box as the same thing, the way the API does', () => {
    assert.deepEqual(parseDeepLink(`?enclosure=${BOX_ID}`), { kind: 'box', id: BOX_ID });
  });

  it('is case-insensitive about the parameter name only', () => {
    assert.deepEqual(parseDeepLink(`?BOX=${BOX_ID}`), { kind: 'box', id: BOX_ID });
  });

  it('returns null for a URL with no tag in it — the app just opens normally', () => {
    assert.equal(parseDeepLink(''), null);
    assert.equal(parseDeepLink('?'), null);
    assert.equal(parseDeepLink('?view=map&zoom=14'), null);
    assert.equal(parseDeepLink(undefined), null);
    assert.equal(parseDeepLink(null), null);
  });

  it('ignores an empty value rather than asking the API for nothing', () => {
    assert.equal(parseDeepLink('?box='), null);
    assert.equal(parseDeepLink('?box=%20'), null);
  });

  it('refuses a value that is not plausibly an id, instead of querying with it', () => {
    // A sticker can be damaged or the link hand-edited; a script tag or a path
    // fragment must never reach the API.
    assert.equal(parseDeepLink('?box=<script>alert(1)</script>'), null);
    assert.equal(parseDeepLink('?box=../../etc/passwd'), null);
    assert.equal(parseDeepLink('?box=1'), null);
    assert.equal(parseDeepLink('?box=not a uuid'), null);
  });

  it('tolerates a trailing hash or extra parameters from a chat client that appended its own', () => {
    assert.deepEqual(parseDeepLink(`?utm_source=whatsapp&box=${BOX_ID}&utm_medium=chat#top`), {
      kind: 'box',
      id: BOX_ID,
    });
  });
});

describe('buildDeepLink', () => {
  it('builds the link that goes inside the QR code', () => {
    assert.equal(buildDeepLink('box', BOX_ID, 'https://app.example.com'), `https://app.example.com/?box=${BOX_ID}`);
    assert.equal(buildDeepLink('pole', POLE_ID, 'https://app.example.com/'), `https://app.example.com/?pole=${POLE_ID}`);
    assert.equal(buildDeepLink('box', BOX_ID), `/?box=${BOX_ID}`);
  });

  it('encodes the id, so an odd id cannot break the query string', () => {
    assert.equal(buildDeepLink('box', 'a b&c=d', 'https://x.test'), 'https://x.test/?box=a%20b%26c%3Dd');
  });

  it('returns null when there is nothing to link to', () => {
    assert.equal(buildDeepLink('box', null), null);
    assert.equal(buildDeepLink('sausage', BOX_ID), null);
  });

  it('round-trips: what a tag carries is what the app reads', () => {
    const link = buildDeepLink('pole', POLE_ID, 'https://app.example.com');
    const parsed = parseDeepLink(link.slice(link.indexOf('?')));
    assert.deepEqual(parsed, { kind: 'pole', id: POLE_ID });
  });
});

describe('qrPath', () => {
  it('points at the API route that renders the code', () => {
    assert.equal(qrPath('box', BOX_ID), `/api/qr/box/${BOX_ID}`);
    assert.equal(qrPath('pole', POLE_ID, { scale: 8 }), `/api/qr/pole/${POLE_ID}?scale=8`);
    assert.equal(qrPath('enclosure', BOX_ID, { ec: 'M', scale: 6, quiet: 4 }), `/api/qr/box/${BOX_ID}?ec=M&scale=6&quiet=4`);
  });

  it('drops empty options rather than sending ?ec=&scale=', () => {
    assert.equal(qrPath('box', BOX_ID, { ec: null, scale: undefined, quiet: '' }), `/api/qr/box/${BOX_ID}`);
  });

  it('has a parameter for every kind of thing that can carry a tag', () => {
    assert.deepEqual(Object.keys(KIND_PARAM).sort(), ['box', 'cable', 'customer', 'enclosure', 'pole']);
    assert.equal(qrPath('sausage', BOX_ID), null);
    
  });
});

describe('syncLocation', () => {
  /** A stand-in for `window`, so this runs without a browser. */
  function fakeWindow(search = '', pathname = '/') {
    const calls = [];
    return {
      location: { origin: 'https://app.example.com', pathname, search },
      history: { replaceState: (state, title, url) => calls.push(url) },
      calls,
    };
  }

  it('puts the selection in the address bar, so the link can be copied or re-tagged', () => {
    const win = fakeWindow();
    const url = syncLocation('box', BOX_ID, { win });
    assert.equal(url, `/?box=${BOX_ID}`);
    assert.deepEqual(win.calls, [`/?box=${BOX_ID}`]);
  });

  it('clears the query when the selection is cleared', () => {
    const win = fakeWindow('?box=x', '/index.html');
    syncLocation('box', null, { win });
    assert.deepEqual(win.calls, ['/index.html']);
  });

  it('uses replaceState — scanning five boxes must not fill the back button', () => {
    const win = fakeWindow();
    syncLocation('pole', POLE_ID, { win });
    assert.equal(win.calls.length, 1);
    assert.equal(typeof win.history.replaceState, 'function');
  });

  it('survives a frame that refuses history changes', () => {
    const win = { location: { origin: 'https://x', pathname: '/' }, history: { replaceState() { throw new Error('blocked'); } } };
    assert.equal(syncLocation('box', BOX_ID, { win }), null);
  });
});
