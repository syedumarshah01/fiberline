/**
 * Unit tests for matching a typed address to something the network knows.
 *
 * The stakes are asymmetric and the tests are written that way: a match that is
 * too eager quotes a price for the wrong house, so the scoring has to be hard to
 * fool — a house number that disagrees must sink the candidate, and a long stored
 * address must not win merely by being long.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAddress,
  scoreAddressMatch,
  matchAddresses,
  matchAssetCode,
} = require('../src/utils/addressMatch');

describe('normalizeAddress', () => {
  test('case, punctuation and spacing stop mattering', () => {
    assert.equal(normalizeAddress('House 12-B, Street 4'), 'house 12 b street 4');
    assert.equal(normalizeAddress('  PHASE  2 '), 'phase 2');
  });

  test('nothing in, nothing out', () => {
    assert.equal(normalizeAddress(null), '');
    assert.equal(normalizeAddress(undefined), '');
  });
});

describe('scoreAddressMatch', () => {
  test('the same address twice is a certainty', () => {
    const { score } = scoreAddressMatch('House 12-B, Street 4', 'house 12 b street 4');
    assert.equal(score, 1);
  });

  test('a query that appears inside a longer stored address scores high', () => {
    const { score, numbers_agree } = scoreAddressMatch('street 4 phase 2', 'House 12-B, Street 4, Phase 2, Islamabad');
    assert.ok(score >= 0.9, `got ${score}`);
    assert.equal(numbers_agree, true);
  });

  test('a different house on the same street is not a match', () => {
    // The stakes: 12-C and 12-B share a street, a phase and a city. Only the
    // house differs, and quoting the wrong house is the failure that matters.
    const { score, numbers_agree } = scoreAddressMatch('House 12-C, Street 4', 'House 12-B, Street 4');
    assert.equal(numbers_agree, false);
    assert.ok(score < 0.6, `a different house must not clear the threshold (got ${score})`);
  });

  test('the same house is the same house however it is written', () => {
    for (const written of ['12-B', '12 B', '12b']) {
      const { numbers_agree, score } = scoreAddressMatch(`House ${written}, Street 4`, 'House 12-B, Street 4');
      assert.equal(numbers_agree, true, written);
      assert.ok(score >= 0.9, `${written} scored ${score}`);
    }
  });

  test('a bare house number still finds the sub-lot the database recorded', () => {
    const { score, numbers_agree } = scoreAddressMatch('House 12, Street 4', 'House 12-B, Street 4');
    assert.equal(numbers_agree, true, 'the data says 12-B, the caller says 12 — same lot');
    assert.ok(score >= 0.9, `got ${score}`);
  });

  test('one shared word in a long address is a suggestion, not an answer', () => {
    const { score, evidence } = scoreAddressMatch(
      'islamabad',
      'House 12-B, Street 4, Phase 2, Islamabad, Punjab, Pakistan',
    );
    assert.equal(evidence, 1, 'one token matched');
    assert.ok(score < 0.8, `and it is not strong evidence either (got ${score})`);
  });

  test('a completely different street scores nothing usable', () => {
    const { score } = scoreAddressMatch('House 7, Street 9', 'House 12-B, Street 4');
    assert.ok(score < 0.3, `got ${score}`);
  });

  test('an empty side scores zero rather than matching', () => {
    assert.equal(scoreAddressMatch('', 'anything').score, 0);
    assert.equal(scoreAddressMatch('anything', '').score, 0);
  });
});

describe('matchAddresses', () => {
  const entries = [
    { id: 'c1', code: 'CUST-1', address: 'House 12-B, Street 4, Phase 2', rank: 0 },
    { id: 'c2', code: 'CUST-2', address: 'House 12-C, Street 4, Phase 2', rank: 1 },
    { id: 'c3', code: 'CUST-3', address: 'House 88, Street 9, Phase 5', rank: 2 },
  ];

  test('the closest address comes first and the far one is dropped', () => {
    const matches = matchAddresses('house 12 b street 4', entries);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].id, 'c1');
    assert.equal(matches[0].confident, true);
    assert.equal(matches.some((m) => m.id === 'c3'), false, 'a different street is not offered');
  });

  test('a confident match beats a higher-scoring guess', () => {
    // c2 is the same street and shares four tokens, but it is the neighbour:
    // confidence is about evidence, and the neighbour must never be picked.
    const matches = matchAddresses('house 12 b street 4', entries);
    assert.equal(matches[0].confident && matches[0].id === 'c1', true);
    assert.equal(matches[1].confident, false);
  });

  test('a neighbour on the same street still appears, but not as the pick', () => {
    const matches = matchAddresses('house 12 c street 4', entries);
    assert.equal(matches[0].id, 'c2');
  });

  test('the caller\'s own ordering breaks ties, so the answer is stable', () => {
    const twins = [
      { id: 'b', code: 'CUST-B', address: 'House 5, Street 1', rank: 1 },
      { id: 'a', code: 'CUST-A', address: 'House 5, Street 1', rank: 0 },
    ];
    assert.equal(matchAddresses('house 5 street 1', twins)[0].id, 'a');
  });

  test('limit is respected and never returns nothing for a scoring query', () => {
    assert.equal(matchAddresses('house 12 b street 4', entries, { limit: 1 }).length, 1);
  });
});

describe('matchAssetCode', () => {
  const assets = [
    { id: 'nap14', code: 'NAP-14', name: null, kind: 'enclosure' },
    { id: 'pole7', code: 'POLE-0007', name: null, kind: 'pole' },
    { id: 'cab', code: 'CAB-01', name: 'Green cabinet', kind: 'enclosure' },
  ];

  test('an exact code is exact', () => {
    const [best] = matchAssetCode('NAP-14', assets);
    assert.equal(best.id, 'nap14');
    assert.equal(best.score, 1);
    assert.equal(best.how, 'code');
  });

  test('a code pasted inside a sentence still wins', () => {
    const [best] = matchAssetCode('new drop to NAP-14 please', assets);
    assert.equal(best.id, 'nap14');
    assert.equal(best.how, 'code-in-text');
  });

  test('a box name can be used instead of a code', () => {
    const [best] = matchAssetCode('Green cabinet', assets);
    assert.equal(best.id, 'cab');
    assert.equal(best.how, 'name');
  });

  test('punctuation and case do not matter', () => {
    assert.equal(matchAssetCode('nap14', assets)[0].id, 'nap14');
    assert.equal(matchAssetCode('pole 0007', assets)[0].id, 'pole7');
  });

  test('a stray short word does not match a code it is inside', () => {
    // "NAP" is a prefix of "NAP-14" but is not the code; a 3-letter needle would
    // turn every sentence containing it into a match.
    assert.deepEqual(matchAssetCode('nap', assets), []);
  });
});
