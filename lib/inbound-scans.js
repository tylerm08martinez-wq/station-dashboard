'use strict';

// Shared "Inbound and Van Scans" report parser (ADR-0012 / issue #297, slice 2
// of #295). Extracted from the IBNO Coder's inline parsing (findHeaderIndex +
// readFields in lib/ibno-rules.js) so the Address Catcher can consume the SAME
// parser instead of its own local one — one parser, no drift.
//
// SCOPE: this module yields only the fields the issue specifies — per
// package: PKG_LABEL_XREF (trk#), LABEL_ADDRESS1 / LABEL_CITY / LABEL_STATE /
// POSTAL_CODE, and IB_WORK_AREA. lib/ibno-rules.js's readFields() needs a much
// larger field set (PLA_LOOKUP, BELT, STATUS_CODES1, VAN_WORK_AREA, etc.) for
// its coding decisions and keeps building that itself — this module is not a
// replacement for readFields, it is the header-location + narrow-field-read
// building block both the IBNO Coder and the Address Catcher now share.
//
// Additive extension (issue #357): statusCodes (STATUS_CODES1, raw
// '||'-separated string, e.g. "33||300") and vanScanTime (VAN_SCAN_TIME1,
// raw as-printed) are now also read here so the Address Catcher can derive
// its CODED and ON TRUCK pills from the SAME shared parser rather than a
// second local read. This is purely additive — the existing five fields are
// unchanged, and lib/ibno-rules.js's OWN readFields() reads STATUS_CODES1 /
// VAN_SCAN_TIME1 directly itself (see its module comment) rather than through
// this module, so the IBNO Coder's behavior is completely unaffected by this
// change (its tests stay green with zero modification, per #357's AC).
//
// Additive extension (issue #358): firmName (LABEL_FIRM_NAME, raw as-printed,
// 86% filled in the real 2026-07-01 export) is now also read here so the
// Address Catcher can conservatively name-match a package against a
// suppressed adds-a-unit dictionary entry's recipient name (see
// lib/address-dictionary.js's ADDS-A-UNIT SUPPRESSION comment and
// lib/address-match.js's matchNameAdvisories). Purely additive — same
// discipline as the #357 fields above; lib/ibno-rules.js does not read this
// field and is completely unaffected.
//
// Behavior preserved from the prior inline logic:
// - Header location: some exports ("Inbound and Van Scans - Full Detail by
//   Date") prepend a title/compliance preamble ABOVE the real header row.
//   findHeaderIndex locates the real header by signature (PKG_LABEL_XREF +
//   LABEL_ADDRESS1 both present) so a preamble never produces empty results.
// - A row with no PKG_LABEL_XREF is skipped (mirrors the Address Catcher's
//   prior local parseInboundRows contract, which this module replaces).
//
// Dual-loadable with no build step:
// - Browser: window.InboundScans
// - Node: require('./lib/inbound-scans')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.InboundScans = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  function resolveColumnGetter() {
    if (root && root.CsvLib && typeof root.CsvLib.columnGetter === 'function') return root.CsvLib.columnGetter;
    if (root && typeof root.columnGetter === 'function') return root.columnGetter;
    if (typeof require === 'function') return require('./csv').columnGetter;
    return null;
  }

  const columnGetter = resolveColumnGetter();

  // Header signature: both columns appear in every Inbound and Van Scans
  // export's real header and never in a preamble line. NOTE: lib/ibno-rules.js
  // locates the same report's header with a DIFFERENT signature pair
  // (PKG_LABEL_XREF + INBOUND_DATE) — both are valid signatures against the
  // real export (all four columns co-occur in every header), and this module
  // intentionally keeps the signature the Address Catcher's prior local
  // parser used (#296) rather than switching lib/ibno-rules.js's own
  // findHeaderIndex to delegate here, which would be a behavior change to the
  // live IBNO Coder outside this issue's scope (#297 requires ibno-coder.html
  // behavior UNCHANGED). See the module comment above for what IS shared.
  const HEADER_SIGNATURE = ['PKG_LABEL_XREF', 'LABEL_ADDRESS1'];

  // findHeaderIndex(rows) -> index of the real header row. No match (e.g. a
  // malformed file) -> 0, preserving the legacy rows[0]-is-header behavior.
  function findHeaderIndex(rows) {
    if (!Array.isArray(rows)) return 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      const cells = row.map(function (c) { return String(c == null ? '' : c).trim().toUpperCase(); });
      if (HEADER_SIGNATURE.every(function (sig) { return cells.indexOf(sig) !== -1; })) return i;
    }
    return 0;
  }

  // readScanFields(row, get) -> the shared field set for ONE data row:
  // { trackingId, labelAddress1, labelCity, labelState, postalCode,
  //   ibWorkArea, statusCodes, vanScanTime, firmName }. `get` is a
  // header-indexed accessor (columnGetter(headerRow)). This is the single
  // place these column names are read for the Address Catcher —
  // lib/ibno-rules.js's readFields() (which needs a much larger field set for
  // coding decisions) calls this for the ORIGINAL five-field subset instead
  // of re-reading the columns itself, so the IBNO Coder and the Address
  // Catcher can never drift on what those five fields mean.
  // statusCodes/vanScanTime (#357) and firmName (#358) are additive and not
  // consumed by lib/ibno-rules.js (it reads STATUS_CODES1 / VAN_SCAN_TIME1
  // itself — see module comment above).
  function readScanFields(row, get) {
    return {
      trackingId: get(row, 'PKG_LABEL_XREF'),
      labelAddress1: get(row, 'LABEL_ADDRESS1'),
      labelCity: get(row, 'LABEL_CITY'),
      labelState: get(row, 'LABEL_STATE'),
      postalCode: get(row, 'POSTAL_CODE'),
      ibWorkArea: get(row, 'IB_WORK_AREA'),
      statusCodes: get(row, 'STATUS_CODES1'),
      vanScanTime: get(row, 'VAN_SCAN_TIME1'),
      firmName: get(row, 'LABEL_FIRM_NAME'),
    };
  }

  // parseInboundScans(rows) -> record[]. rows in parseCSV/parseXlsx shape
  // (header row + data rows, optionally preceded by a title/compliance
  // preamble). One record per data row carrying a non-blank PKG_LABEL_XREF:
  // { trackingId, labelAddress1, labelCity, labelState, postalCode,
  //   ibWorkArea, statusCodes, vanScanTime, firmName }.
  function parseInboundScans(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const start = findHeaderIndex(rows);
    const sliced = start > 0 ? rows.slice(start) : rows;
    if (sliced.length < 2) return [];
    const get = columnGetter(sliced[0]);
    const out = [];
    for (let r = 1; r < sliced.length; r++) {
      const row = sliced[r];
      if (!Array.isArray(row)) continue;
      const rec = readScanFields(row, get);
      if (!rec.trackingId) continue;
      out.push(rec);
    }
    return out;
  }

  return {
    findHeaderIndex: findHeaderIndex,
    readScanFields: readScanFields,
    parseInboundScans: parseInboundScans,
  };
});
