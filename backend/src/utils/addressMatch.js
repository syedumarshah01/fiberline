/**
 * Matching a typed address to something the network already knows.
 *
 * A CSR is handed "House 12-B, Street 4, Phase 2" and a phone call. There is no
 * geocoder in this app and, on a network with a few hundred customers, there does
 * not need to be: the address is usually already in the database — an existing
 * customer two doors down, or the box the last install hung off. So resolve
 * locally first, in this order of trust:
 *
 *   1. an asset code the caller typed ("NAP-14", "POLE-0007") — exact, unambiguous;
 *   2. a customer address in the database (this is what makes the answer instant
 *      for a street you have already built);
 *   3. an external geocoder, if one is configured (GEOCODE_BASE_URL).
 *
 * The scoring is deliberately conservative and explainable: a match has to earn
 * its score from the *tokens of the query*, so a long stored address cannot win
 * by containing a lot of words, and a house number that disagrees is a strong
 * signal against (12-B and 12-C are different homes). Anything below the
 * threshold is returned as a suggestion, never silently used — quoting a price
 * for the wrong house is worse than asking the CSR to click the map.
 *
 * Pure: no database, no network. The service layer feeds it rows.
 */

/** Everything except letters, digits and spaces is noise in an address. */
function normalizeAddress(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensOf(value) {
  return normalizeAddress(value).split(' ').filter(Boolean);
}

/**
 * House/lot units: the part of an address that tells two homes on one street
 * apart. "House 12-B" is one unit — digits `12`, suffix `b` — however it is
 * written ("12-B", "12 B", "12b"), and it has to be compared as one, because the
 * difference between 12-B and 12-C is the difference between quoting the
 * customer and quoting their neighbour.
 */
function unitKeys(normalized) {
  const tokens = String(normalized).split(' ').filter(Boolean);
  const units = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!/\d/.test(token)) continue;
    let digits = token.replace(/[^0-9]/g, '');
    let suffix = token.replace(/[0-9]/g, '');
    // "12 b" — a letter token immediately after the number is its suffix.
    if (!suffix && tokens[i + 1] && /^[a-z]$/.test(tokens[i + 1])) {
      suffix = tokens[i + 1];
      i += 1;
    }
    units.push({ digits, suffix });
  }
  return units;
}

/** Indexes of the tokens that make up house units, which may be one token
 *  ("12b") or two ("12" + "b"). */
function unitTokenIndexes(tokens) {
  const indexes = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    if (!/\d/.test(tokens[i])) continue;
    indexes.add(i);
    if (!/[a-z]/.test(tokens[i]) && tokens[i + 1] && /^[a-z]$/.test(tokens[i + 1])) indexes.add(i + 1);
  }
  return indexes;
}

/** Do two house units refer to the same home? "12-B" ≡ "12 B" ≡ "12"; 12-B ≢ 12-C. */
function unitsAgree(queryUnits, candidateUnits) {
  if (!queryUnits.length) return null;
  const same = queryUnits.every((unit) =>
    candidateUnits.some(
      (other) =>
        other.digits === unit.digits &&
        // A missing suffix on either side is "as recorded", not a conflict: the
        // data says 12, the caller says 12-B, and both mean that lot.
        (other.suffix === '' || unit.suffix === '' || other.suffix === unit.suffix),
    ),
  );
  return same;
}

/**
 * Score one stored address against the query.
 *
 * Returns { score, matched_tokens, missing_tokens, numbers_agree, evidence }.
 *
 *   exact          → 1
 *   substring      → 0.95 when the query is a *substantial* run inside the
 *                    candidate (two or more tokens: "street 4 phase 2"). A
 *                    single shared word is not evidence — "islamabad" appears in
 *                    every address in Islamabad.
 *   token overlap  → 0.7 × (query covered) + 0.3 × (candidate covered)
 *   house units    → +0.1 when they agree, and a hard cap at 0.45 when they
 *                    disagree: a different house never clears the threshold,
 *                    whatever else the two addresses have in common.
 *
 * `score` measures overlap; `evidence` (how many query tokens matched) is what
 * `confident` is gated on. One shared token out of seven is a suggestion, not an
 * answer.
 */
function scoreAddressMatch(query, candidate) {
  const q = normalizeAddress(query);
  const c = normalizeAddress(candidate);
  const empty = { score: 0, matched_tokens: [], missing_tokens: [], numbers_agree: null, evidence: 0 };
  if (!q || !c) return empty;
  if (q === c) {
    return { score: 1, matched_tokens: tokensOf(q), missing_tokens: [], numbers_agree: true, evidence: tokensOf(q).length };
  }

  const qTokens = tokensOf(q);
  const cTokens = tokensOf(c);
  const cSet = new Set(cTokens);
  const qUnits = unitKeys(q);
  const cUnits = unitKeys(c);
  const numbersAgree = unitsAgree(qUnits, cUnits);

  // "12b" and "12 b" are the same house written two ways. When the units agree,
  // they count as matched tokens too — otherwise the caller's spelling would
  // dilute the score of the right address and flatter the wrong one.
  const unitIndexes = numbersAgree === true ? unitTokenIndexes(qTokens) : new Set();
  const matched = qTokens.filter((token, index) => cSet.has(token) || unitIndexes.has(index));
  const missing = qTokens.filter((token, index) => !cSet.has(token) && !unitIndexes.has(index));

  let score;
  if (c.includes(q) && qTokens.length >= 2) {
    // The typed address appears verbatim inside the stored one ("street 4 phase
    // 2" ⊂ "House 12-B, Street 4, Phase 2, Islamabad").
    score = 0.95;
  } else {
    const coverage = qTokens.length ? matched.length / qTokens.length : 0;
    const precision = cTokens.length ? matched.length / cTokens.length : 0;
    score = 0.7 * coverage + 0.3 * precision;
  }

  if (numbersAgree === true) score += 0.1;
  if (numbersAgree === false) score = Math.min(score - 0.35, 0.45);

  return {
    score: round3(Math.min(1, Math.max(0, score))),
    matched_tokens: matched,
    missing_tokens: missing,
    numbers_agree: numbersAgree,
    evidence: matched.length,
  };
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

const DEFAULT_THRESHOLD = 0.6;

/**
 * Rank a list of stored addresses against the query.
 *
 * `entries` are `{ address, ... }` rows (customers, enclosure names — anything
 * with an address-ish string); each result carries the entry spread plus
 * `score`, `evidence` and `confident`. Confident matches sort first, then by
 * score, then by the caller's own `rank` field, so the database's ordering
 * breaks ties and the answer is stable between calls.
 */
function matchAddresses(
  query,
  entries,
  { limit = 5, threshold = DEFAULT_THRESHOLD, floor = 0.25 } = {},
) {
  const scored = [];
  for (const entry of entries || []) {
    const field = entry.address ?? entry.name ?? entry.label;
    const { score, matched_tokens, missing_tokens, numbers_agree, evidence } = scoreAddressMatch(query, field);
    // Below the floor the two addresses share a stray word and nothing else.
    // Offering it as a suggestion is noise — the CSR has the map for the rest.
    if (score < floor) continue;
    // Two ways to be confident, because there are two ways to be sure: a good
    // score over several matched tokens, or a single token that settles it —
    // a house unit ("house 12-b") is evidence on its own, "islamabad" is not.
    const unitOnly = evidence === 1 && unitKeysOf(field).length > 0 && matched_tokens.some((t) => /\d/.test(t));
    scored.push({
      ...entry,
      score,
      matched_tokens,
      missing_tokens,
      numbers_agree,
      evidence,
      confident: score >= threshold && (evidence >= 2 || unitOnly),
    });
  }
  // Confident matches first, then by score, then by the caller's own ordering —
  // so the answer does not depend on the order rows came back in.
  scored.sort(
    (a, b) =>
      Number(b.confident) - Number(a.confident) ||
      b.score - a.score ||
      (a.rank ?? 0) - (b.rank ?? 0),
  );
  return scored.slice(0, Math.max(1, limit));
}

/** House units of an address, for the single-token confidence rule. */
function unitKeysOf(value) {
  return unitKeys(normalizeAddress(value));
}

/**
 * Is an asset code what the caller typed? Codes are exact (`NAP-14`), or the
 * query may carry the code inside a sentence ("drop to NAP-14 please"), which is
 * how CSRs actually paste things.
 */
function matchAssetCode(query, entries) {
  const q = normalizeAddress(query).replace(/\s+/g, '');
  if (!q) return [];
  const out = [];
  for (const entry of entries || []) {
    const code = normalizeAddress(entry.code).replace(/\s+/g, '');
    const name = normalizeAddress(entry.name).replace(/\s+/g, '');
    if (!code && !name) continue;
    let score = 0;
    let how = null;
    if (code && q === code) {
      score = 1;
      how = 'code';
    } else if (code && code.length >= 4 && q.includes(code)) {
      score = 0.95;
      how = 'code-in-text';
    } else if (name && name.length >= 4 && q === name) {
      score = 0.9;
      how = 'name';
    } else if (name && name.length >= 5 && q.includes(name)) {
      score = 0.85;
      how = 'name-in-text';
    }
    if (score) out.push({ ...entry, score, how });
  }
  out.sort((a, b) => b.score - a.score || (a.rank ?? 0) - (b.rank ?? 0));
  return out;
}

module.exports = {
  normalizeAddress,
  tokensOf,
  unitKeys,
  scoreAddressMatch,
  matchAddresses,
  matchAssetCode,
  DEFAULT_THRESHOLD,
};
