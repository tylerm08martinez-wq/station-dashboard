'use strict';

// ZIP -> ISP -> Belt lookup (issue #438, grilled 2026-07-07). See
// notes/zip-isp-belt.md for the canonical table (do not edit that note —
// tests/zip-isp-belt.test.js parses it and asserts TABLE matches verbatim).
//
// Product: ZIP -> ISP lookup IS the product. The belt is shown only as humble
// orientation text ("usually belt N00", with the source date) — NEVER as a
// mismatch verdict, flag, or comparison against report belts. The grill
// rejected mismatch hints on real-data evidence: table-vs-report belt
// disagreement is routine (special belts absorb heavy spillover; the table
// itself is off in places), exactly as the sender warned. There is
// deliberately no translation between the report's `B- 0N EVEN/ODD` belt
// vocabulary and this table's `N00` values.
//
// Dual-loadable with no build step:
// - Browser: window.ZipIspBeltLib
// - Node: require('./lib/zip-isp-belt')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ZipIspBeltLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SOURCE_DATE = '2026-06-02';

  // Verbatim, in notes/zip-isp-belt.md's order. "Shantg" (85085) and "Shantig"
  // (85024, 85331) are spelled exactly as the source email — likely the same
  // ISP, unconfirmed; do not normalize.
  const TABLE = [
    { zip: '85255', isp: 'A-D', belt: '600' },
    { zip: '85262', isp: 'A-D', belt: '600' },
    { zip: '85263', isp: 'A-D', belt: '600' },
    { zip: '85266', isp: 'A-D', belt: '600' },
    { zip: '85377', isp: 'A-D', belt: '600' },
    { zip: '85320', isp: 'Alpha', belt: '600' },
    { zip: '85332', isp: 'Alpha', belt: '600' },
    { zip: '85342', isp: 'Alpha', belt: '600' },
    { zip: '85358', isp: 'Alpha', belt: '600' },
    { zip: '85361', isp: 'Alpha', belt: '600' },
    { zip: '85362', isp: 'Alpha', belt: '600' },
    { zip: '85387', isp: 'Alpha', belt: '600' },
    { zip: '85390', isp: 'Alpha', belt: '600' },
    { zip: '85083', isp: 'BB', belt: '100' },
    { zip: '85310', isp: 'BB', belt: '100' },
    { zip: '85381', isp: 'Colimax', belt: '300' },
    { zip: '85382', isp: 'Colimax', belt: '500' },
    { zip: '85086', isp: 'Desert West', belt: '600' },
    { zip: '85087', isp: 'Desert West', belt: '600' },
    { zip: '85324', isp: 'Desert West', belt: '600' },
    { zip: '85022', isp: 'Hermes', belt: '300' },
    { zip: '85023', isp: 'Hermes', belt: '300' },
    { zip: '85032', isp: 'Hermes', belt: '300' },
    { zip: '85053', isp: 'Hermes', belt: '300' },
    { zip: '85021', isp: 'JJS', belt: '100' },
    { zip: '85029', isp: 'JJS', belt: '100' },
    { zip: '85051', isp: 'JJS', belt: '100' },
    { zip: '85302', isp: 'Lehman', belt: '100' },
    { zip: '85304', isp: 'Lehman', belt: '100' },
    { zip: '85306', isp: 'Lehman', belt: '100' },
    { zip: '85383', isp: 'Monarch', belt: '500' },
    { zip: '85050', isp: 'MSJ', belt: '400' },
    { zip: '85054', isp: 'MSJ', belt: '400' },
    { zip: '85254', isp: 'MSJ', belt: '400' },
    { zip: '85057', isp: 'postal', belt: null },
    { zip: '85085', isp: 'Shantg', belt: '500' },
    { zip: '85024', isp: 'Shantig', belt: '500' },
    { zip: '85331', isp: 'Shantig', belt: '600' },
    { zip: '85027', isp: 'ZE', belt: '200' },
    { zip: '85308', isp: 'ZE', belt: '200' },
  ];

  const BY_ZIP = {};
  TABLE.forEach(function (row) { BY_ZIP[row.zip] = row; });

  // Normalize: trim, strip non-digits, take the first 5 digits (so ZIP+4
  // works) -> require exactly 5 digits after that, else null.
  function normalizeZip(zip) {
    if (typeof zip !== 'string') return null;
    const digits = zip.trim().replace(/\D/g, '');
    if (digits.length < 5) return null;
    return digits.slice(0, 5);
  }

  function lookup(zip) {
    const z = normalizeZip(zip);
    if (!z) return null;
    return BY_ZIP.hasOwnProperty(z) ? BY_ZIP[z] : null;
  }

  function orientationText(zip) {
    const row = lookup(zip);
    if (!row) return '';
    return row.belt === null
      ? 'ISP: ' + row.isp + ' · no ISP belt (zip list ' + SOURCE_DATE + ')'
      : 'ISP: ' + row.isp + ' · usually belt ' + row.belt + ' (zip list ' + SOURCE_DATE + ')';
  }

  // The ZIP at the END of a display address string
  // ('4441 N Buckboard Trl SCOTTSDALE AZ 85251' -> '85251'), or null.
  // End-anchored with a non-digit boundary before the five digits, so a
  // 5-digit street number never matches and a longer trailing digit run (a
  // hyphen-less ZIP9 like '850085050', a box/lot number) yields null rather
  // than a confidently wrong last-5 read. ZIP+4 with either separator
  // ('85383-1234', '85383 1234') resolves to the ZIP5.
  function zipFromDisplay(display) {
    const s = String(display == null ? '' : display).trim();
    const m = /(?:^|\D)(\d{5})(?:[-\s]\d{4})?$/.exec(s);
    return m ? m[1] : null;
  }

  function orientationTextForAddress(display) {
    return orientationText(zipFromDisplay(display));
  }

  return {
    SOURCE_DATE: SOURCE_DATE,
    TABLE: TABLE,
    lookup: lookup,
    orientationText: orientationText,
    zipFromDisplay: zipFromDisplay,
    orientationTextForAddress: orientationTextForAddress,
  };
});
