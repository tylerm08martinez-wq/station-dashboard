'use strict';

// Address normalization — the hazard-bearing core of the Address Catcher
// (ADR-0012 / issue #295). Slice 1 (#296) covered case/whitespace/
// punctuation/ZIP+4. THIS slice (#298, "slice 3") hardens it further so
// formatting-only variants of the same address collapse to one key while
// genuinely different addresses stay distinct — a wrong fold here sends a
// package to the wrong place, so every rule below is deliberately narrow
// and whole-token (never a loose substring match) and biased toward NOT
// folding when a case is ambiguous.
//
// Added in this slice:
//   - Street-type abbreviation folding (DR/DRIVE, AVE/AVENUE, RD/ROAD, ...).
//   - Directional folding (N/NORTH, NE/NORTHEAST, ...).
//   - Suite/unit token normalization: the marker token itself (STE, SUITE,
//     UNIT, APT, #) is DROPPED rather than canonicalized, so "STE 55",
//     "SUITE 55", "UNIT 55", "APT 55", "# 55", "#55", and a bare "55" all
//     reduce to the same trailing token "55". This is deliberately the
//     simplest rule that satisfies the acceptance criteria (STE 55 == 55 ==
//     # 55 == UNIT 55) without inventing a second special case for "bare
//     number, no marker."
//
// Still NOT done (future slices, if ever needed): street-name misspelling
// correction, city-name aliasing, and any fold that would touch house
// number, ZIP, or the substantive street name — those differences must
// always remain distinguishing.
//
// Dual-loadable with no build step:
// - Browser: window.AddressNormalize
// - Node: require('./lib/address-normalize')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AddressNormalize = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Street-type suffix variants -> canonical abbreviation. Whole-token match
  // only (never a substring), applied wherever such a token appears in the
  // address (not just the last token), since suite/unit and city/state/ZIP
  // tokens follow the street name. Mirrors lib/masterlist.js's
  // STREET_SUFFIXES table (kept independent on purpose — different modules,
  // different risk tiers; do not couple them).
  const STREET_SUFFIXES = {
    AVENUE: 'AVE', AVE: 'AVE', AV: 'AVE',
    STREET: 'ST', ST: 'ST',
    DRIVE: 'DR', DRV: 'DR', DR: 'DR',
    ROAD: 'RD', RD: 'RD',
    LANE: 'LN', LN: 'LN',
    BOULEVARD: 'BLVD', BLVD: 'BLVD', BLV: 'BLVD',
    COURT: 'CT', CT: 'CT',
    CIRCLE: 'CIR', CIR: 'CIR',
    PLACE: 'PL', PL: 'PL',
    TRAIL: 'TRL', TRL: 'TRL',
    WAY: 'WAY',
    PARKWAY: 'PKWY', PKWY: 'PKWY',
    HIGHWAY: 'HWY', HWY: 'HWY',
    PLAZA: 'PLZ', PLZ: 'PLZ',
    TERRACE: 'TER', TER: 'TER',
    LOOP: 'LOOP',
    POINT: 'PT', PT: 'PT',
    RIDGE: 'RDG', RDG: 'RDG',
    SQUARE: 'SQ', SQ: 'SQ',
    COVE: 'CV', CV: 'CV',
    PASS: 'PASS', RUN: 'RUN', PARK: 'PARK',
    CROSSING: 'XING', XING: 'XING',
  };

  // Directional variants -> canonical abbreviation. Whole-token match only —
  // "N" must never fold with "S"/"E"/"W" (a real, distinguishing direction),
  // only with its own spelled-out form.
  const DIRECTIONALS = {
    NORTH: 'N', N: 'N',
    SOUTH: 'S', S: 'S',
    EAST: 'E', E: 'E',
    WEST: 'W', W: 'W',
    NORTHEAST: 'NE', NE: 'NE',
    NORTHWEST: 'NW', NW: 'NW',
    SOUTHEAST: 'SE', SE: 'SE',
    SOUTHWEST: 'SW', SW: 'SW',
  };

  // Suite/unit marker tokens that are DROPPED (not canonicalized) so every
  // spelling collapses onto the number that follows. Whole-token match only.
  const UNIT_MARKERS = { STE: true, SUITE: true, UNIT: true, APT: true, '#': true };

  // Unit/suite marker vocabulary for hasUnitToken (issue #342), a strict
  // superset of UNIT_MARKERS above: adds LOT, TRLR, RM, BLDG per the issue's
  // acceptance criteria. Kept as a SEPARATE table (not merged into
  // UNIT_MARKERS) on purpose — normalizeAddress's folding behavior for those
  // four tokens was never specified/tested and changing what it collapses is
  // out of scope for this slice (the issue asks for a detector, not a change
  // to normalizeAddress's key-generation behavior). hasUnitToken is a pure
  // ADDITIVE read of raw text; it does not affect the canonical key.
  const HAS_UNIT_MARKERS = Object.assign({}, UNIT_MARKERS, {
    LOT: true, TRLR: true, RM: true, BLDG: true,
  });

  // normalizeAddress(raw) -> canonical match key (uppercase string), or ''
  // for blank/unusable input. Pure, no DOM.
  function normalizeAddress(raw) {
    let s = String(raw == null ? '' : raw);
    if (!s.trim()) return '';
    s = s.toUpperCase();
    s = s.replace(/\./g, ' ');   // "N." -> "N "
    s = s.replace(/,/g, ' ');    // commas -> space (don't glue adjacent tokens)
    // ZIP+4 -> ZIP5. Matches a 5-digit ZIP followed by a hyphen-or-space and
    // exactly 4 more digits, at a word boundary so a 9-digit unrelated number
    // isn't mistaken for one. Keep the ZIP5, drop the +4 suffix entirely.
    s = s.replace(/\b(\d{5})[-\s](\d{4})\b/g, '$1');
    // Split a "#" glued directly to a number ("#55" -> "# 55") so the
    // unit-marker-drop step below sees them as separate tokens, the same as
    // an already-spaced "# 55".
    s = s.replace(/#(\d)/g, '# $1');
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return '';

    const tokens = s.split(' ').filter(Boolean).reduce(function (acc, token) {
      if (UNIT_MARKERS[token]) return acc; // drop the marker; keep the number after it
      if (STREET_SUFFIXES[token]) { acc.push(STREET_SUFFIXES[token]); return acc; }
      if (DIRECTIONALS[token]) { acc.push(DIRECTIONALS[token]); return acc; }
      acc.push(token);
      return acc;
    }, []);

    return tokens.join(' ').replace(/\s+/g, ' ').trim();
  }

  // hasUnitToken(raw) -> boolean. Detects whether a RAW (pre-normalization)
  // address string carries a unit/suite marker token — #, APT, UNIT, STE,
  // SUITE, LOT, TRLR, RM, BLDG (issue #342's adds-a-unit vocabulary). Must
  // run on raw text, not the output of normalizeAddress: normalizeAddress
  // DROPS the marker token itself (that's the whole point of its unit-folding
  // rule), so by the time an address is canonicalized there is no way to
  // recover whether a marker was ever present.
  //
  // Two match rules:
  // 1. Whole-token match against the vocabulary (never a bare letter-run
  //    substring) — "APTITUDE"/"ARMSTRONG" must not false-positive just
  //    because they contain "APT"/"RM" as a run of letters.
  // 2. Any token CONTAINING a '#' counts. Real exports fuse the marker into
  //    one token — "Apt# 1034", "STE#5", "#238" — and whole-token matching
  //    missed those (/verify on PR #345 found 21 real adds-a-unit rows
  //    surviving on exactly this shape). '#' has no legitimate non-unit use
  //    inside an address token, and over-detection here is safe BY DESIGN:
  //    hasUnitToken feeds addsUnit, which only fires when the ORIGINAL side
  //    LACKS a unit token — a broader corrected-side read can only suppress
  //    more person-specific mappings, never surface a bad suggestion. This
  //    function still never affects normalizeAddress's key generation.
  function hasUnitToken(raw) {
    let s = String(raw == null ? '' : raw);
    if (!s.trim()) return false;
    s = s.toUpperCase();
    s = s.replace(/\./g, ' ').replace(/,/g, ' ');
    const tokens = s.split(/\s+/).filter(Boolean);
    return tokens.some(function (token) {
      if (token.indexOf('#') !== -1) return true; // fused forms: "APT#", "#1034", "STE#5"
      return !!HAS_UNIT_MARKERS[token];
    });
  }

  // stripUnitTokens(raw) -> a STREET-PREFIX canonical key: house number
  // through the recognized street-suffix token (DR/ST/AVE/...), with
  // everything AFTER the suffix (unit markers, unit numbers, apartment/
  // recipient names glued into the address field, city/state/ZIP)
  // discarded — never just the unit marker itself removed (issue #365,
  // standing-business-redirect exemption).
  //
  // Why this exists / how it differs from normalizeAddress: normalizeAddress
  // drops only the MARKER token ("STE"/"APT"/"#"/...) and KEEPS the trailing
  // number, so "123 MAIN ST" and "123 MAIN ST APT 4" normalize to two
  // DIFFERENT keys — correct for its job (matching a package's exact address
  // down to the unit), but wrong for #365's question, which is "ignoring the
  // unit, is this even the same PLACE?".
  //
  // Truncating at the street suffix (rather than trying to strip a fixed
  // unit-marker vocabulary from the tail) is deliberately more robust than
  // an earlier version of this function that only dropped the
  // HAS_UNIT_MARKERS vocabulary: the real 2026-06-24 export contains trailing
  // tokens after the suffix that are NOT in that vocabulary at all --
  // "27441 N BLACK CANYON HWY JOSEPH MCLAREN" (a recipient's name typed
  // straight into the original-address field) and "3119 W COCHISE DR UNITE
  // 110" (a typo'd marker, "UNITE" not "UNIT") -- and a marker-vocabulary
  // strip would have left those trailing tokens in place on one side only,
  // making a same-place, person-specific correction look like a different
  // place (a dangerous false EXEMPT). Truncating at the street suffix
  // sidesteps the whole problem: whatever comes after the suffix, unit
  // marker or typo or human name, is irrelevant to "which building is this",
  // so it is dropped uniformly on both sides. A mapping is only ever
  // EXEMPTED (see address-dictionary.js) when this street-prefix key
  // actually differs -- i.e. the correction changes the recognizable street
  // address itself, not merely something after it.
  //
  // If no recognized street-suffix token is found (an address the
  // STREET_SUFFIXES table doesn't cover), this falls back to the FULL
  // normalizeAddress-folded string with no truncation -- fails toward
  // treating the two sides as MORE likely to look identical (same string),
  // which is the safe direction (biases toward NOT exempting an addsUnit
  // mapping, never toward wrongly exempting one).
  //
  // Deliberately a pure, additive, read-only helper: it does NOT change
  // normalizeAddress's own key generation or behavior anywhere else.
  function stripUnitTokens(raw) {
    let s = String(raw == null ? '' : raw);
    if (!s.trim()) return '';
    s = s.toUpperCase();
    s = s.replace(/\./g, ' ');
    s = s.replace(/,/g, ' ');
    s = s.replace(/\b(\d{5})[-\s](\d{4})\b/g, '$1');
    s = s.replace(/#(\d)/g, '# $1');
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return '';

    const rawTokens = s.split(' ').filter(Boolean);
    const folded = [];
    let suffixIndex = -1;
    for (let i = 0; i < rawTokens.length; i++) {
      const token = rawTokens[i];
      if (UNIT_MARKERS[token]) continue; // drop the marker itself, same as normalizeAddress
      if (STREET_SUFFIXES[token]) {
        folded.push(STREET_SUFFIXES[token]);
        suffixIndex = folded.length - 1;
        continue;
      }
      if (DIRECTIONALS[token]) { folded.push(DIRECTIONALS[token]); continue; }
      folded.push(token);
    }

    // Truncate right after the LAST recognized street-suffix token (an
    // address has exactly one street suffix in practice; taking the last
    // is a harmless tie-break if a directional/suffix-like word appears
    // earlier, e.g. a "PARK" street name token). Everything from there on
    // (unit marker/number, typo'd marker, glued-in name, city/state/ZIP) is
    // irrelevant to "which place is this".
    const truncated = suffixIndex === -1 ? folded : folded.slice(0, suffixIndex + 1);
    return truncated.join(' ').replace(/\s+/g, ' ').trim();
  }

  // normalizeName(raw) -> canonical match key (uppercase string), or '' for
  // blank/unusable input. Issue #358 (name-matched unit corrections advisory
  // tier): folds case/whitespace/punctuation ONLY — the same conservative
  // discipline as normalizeAddress, but deliberately WITHOUT any of
  // normalizeAddress's address-specific folding (street-suffix/directional/
  // unit-marker tables don't apply to a person's name). No fuzzy matching:
  // this is whole-string equality after folding, never a partial/substring
  // or edit-distance match — the caller (addsUnit name-match advisory) must
  // bias to MISSING over a wrong match, since a matching name is still only
  // a lead to verify, never a trusted fix (a name can legitimately route to
  // an office instead of the unit).
  function normalizeName(raw) {
    let s = String(raw == null ? '' : raw);
    if (!s.trim()) return '';
    s = s.toUpperCase();
    s = s.replace(/[.,]/g, ' ');       // punctuation -> space (don't glue tokens)
    s = s.replace(/[^A-Z0-9 &'-]/g, ''); // drop other punctuation/symbols outright
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  return {
    normalizeAddress: normalizeAddress,
    hasUnitToken: hasUnitToken,
    stripUnitTokens: stripUnitTokens,
    normalizeName: normalizeName,
  };
});
