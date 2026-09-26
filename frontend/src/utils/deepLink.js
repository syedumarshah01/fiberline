/**
 * Deep links: `?box=<uuid>`, `?pole=<uuid>`, `?cable=<uuid>`, `?customer=<uuid>`.
 *
 * This is what a QR sticker on a pole points at, and it is the whole reason the
 * feature works: a technician scans, the browser opens the app, the app reads the
 * query string and opens that box's documentation — no map, no searching, no
 * typing a code into a box with cold hands.
 *
 * Kept pure so both directions can be tested without a browser: `parseDeepLink`
 * (query string → what to select) and `buildDeepLink` (what to select → link the
 * QR code should carry).
 */

/** The query parameter each kind of thing uses. */
export const KIND_PARAM = {
  pole: 'pole',
  box: 'box',
  enclosure: 'box',
  cable: 'cable',
  customer: 'customer',
};

/** What the API calls each kind (the QR route takes these). */
export const KIND_API = {
  pole: 'pole',
  box: 'box',
  enclosure: 'box',
  cable: 'cable',
  customer: 'customer',
};

const UUID = /^[0-9a-fA-F-]{6,64}$/;

/**
 * Read a deep link out of a query string.
 *
 * @param {string} search  `window.location.search`, with or without the '?'
 * @returns {{kind: string, id: string} | null} what to select, or null
 */
export function parseDeepLink(search) {
  if (!search) return null;
  const query = String(search).replace(/^\?/, '');
  if (!query) return null;
  let params;
  try {
    params = new URLSearchParams(query);
  } catch {
    return null;
  }
  for (const [key, value] of params.entries()) {
    const kind = key.toLowerCase();
    if (!KIND_PARAM[kind]) continue;
    const id = String(value).trim();
    // A scanned sticker can be damaged, or the link hand-edited. Anything that
    // is not plausibly an id is ignored rather than sent to the API.
    if (!id || !UUID.test(id)) continue;
    return { kind: KIND_PARAM[kind], id };
  }
  return null;
}

/** The deep link for one thing — what goes inside the QR code. */
export function buildDeepLink(kind, id, base = '') {
  const param = KIND_PARAM[String(kind).toLowerCase()];
  if (!param || !id) return null;
  const origin = String(base).replace(/\/+$/, '');
  return `${origin}/?${param}=${encodeURIComponent(id)}`;
}

/** The API path for that thing's QR code (server-rendered SVG). */
export function qrPath(kind, id, params = {}) {
  const api = KIND_API[String(kind).toLowerCase()];
  if (!api || !id) return null;
  const query = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== null && value !== undefined && value !== ''),
  ).toString();
  return `/api/qr/${api}/${encodeURIComponent(id)}${query ? `?${query}` : ''}`;
}

/**
 * Put the selection in the address bar, so the link a tech copies (or the QR on
 * the next sticker) is the same shape as the one they just scanned.
 *
 * Uses replaceState: scanning five boxes must not fill the back button with five
 * entries the tech then has to press through.
 */
export function syncLocation(kind, id, { win = null } = {}) {
  const target = win || (typeof window === 'undefined' ? null : window);
  if (!target?.history?.replaceState) return null;
  const link = id ? buildDeepLink(kind, id, target.location?.origin || '') : null;
  const url = link ? `${target.location.pathname}${link.slice(link.indexOf('/?') + 1)}` : target.location.pathname;
  try {
    target.history.replaceState(null, '', url);
  } catch {
    return null; // a sandboxed frame can refuse this; the app still works
  }
  return url;
}
