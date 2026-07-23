'use strict';

// 999 Aging report parser (issue #439, grill-resolved 2026-07-08).
//
// A snapshot-only parser for the "999 and Belt Number Detail" report — the
// data source for the Address Catcher's "999 Aging" panel: a work-down list
// of what's stuck in the 999 work area, oldest-first by DAYS_ACTIVE, grouped
// by CATEGORY (the category is the prescription for HOW to work the
// package). Display-only (ADR-0012 wall): this module only reads and shapes
// rows for lib/data-table.js to render — it never writes to the correction
// dictionary, any session, or sync. Snapshot-only (grill decision 3): the
// report is self-aging (DAYS_ACTIVE, SWAK_TM_FIRST carry the history), so
// there is deliberately no accumulation/persistence layer here — each drop
// replaces the view.
//
// Report shape (verified against the real fixture
// reports/source-files/2026-06-30-999-and-belt-number-detail.csv): an SSRS
// export WITH a preamble — row 0 a "Textbox4" stub, row 1 the quoted
// facility/scan-date block, row 2 the real header. 20 columns: TRKID1,
// SCAN_CREATE_TM, DISPLAYED_WORK_AREA_NBR, PLANNED_WORK_AREAS, CATEGORY,
// SWAK_TM_FIRST, SWAK_TYPE_FIRST, DAYS_ACTIVE, NETWORK, STOP_ID_TYPE,
// STOP_ID, ADDRESS, LABEL_POSTAL_CODE, ZIP11_SCORE, GEO_SCORE,
// PREV_DELV_SUMMARY, PSD, PLANNED, TRAILER_NBR, BARCODE.
//
// DISPLAYED_WORK_AREA_NBR is NOT always 999 (78 of 83 in the real sample;
// also 100/500/600/7700) — this module surfaces it as a plain column, it
// never filters on it.
//
// Dual-loadable with no build step:
// - Browser: window.Aging999
// - Node:    require('./lib/aging-999')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Aging999 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const csvApi = (typeof require === 'function') ? require('./csv') : null;
  const columnGetter = (csvApi && csvApi.columnGetter) ? csvApi.columnGetter : (root && root.columnGetter);

  // findHeaderIndex(rows) -> index of the real header row. The export carries
  // a "Textbox4" title row and a quoted facility/scan-date summary block
  // ABOVE the header. TRKID1 + CATEGORY + DAYS_ACTIVE appear in the real
  // header and never in the preamble, so the first row carrying all three
  // (trim+uppercase match) is the header. No match -> 0, preserving the
  // legacy rows[0]-is-header fallback (mirrors MasterlistLib.findHeaderIndex
  // / IbnoRules.findHeaderIndex).
  const HEADER_SIGNATURE = ['TRKID1', 'CATEGORY', 'DAYS_ACTIVE'];
  function findHeaderIndex(rows) {
    if (!Array.isArray(rows)) return 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      const keys = row.map(function (c) { return String(c == null ? '' : c).trim().toUpperCase(); });
      if (HEADER_SIGNATURE.every(function (sig) { return keys.indexOf(sig) !== -1; })) return i;
    }
    return 0;
  }

  // ageBucket(daysActive) -> one of the fixed summary buckets. Boundaries are
  // half-open on the low end: [0,1) '<1', [1,3) '1-3', [3,7) '3-7',
  // [7,30) '7-30', [30, +inf) '30+'. A non-numeric/negative daysActive falls
  // back to '<1' rather than being silently dropped from the summary.
  const AGE_BUCKETS = ['<1', '1-3', '3-7', '7-30', '30+'];
  function ageBucket(daysActive) {
    const d = Number(daysActive);
    if (!isFinite(d) || d < 1) return '<1';
    if (d < 3) return '1-3';
    if (d < 7) return '3-7';
    if (d < 30) return '7-30';
    return '30+';
  }

  // parseRows(rows) -> record[]. rows is CsvLib.parseCSV shape (array of
  // arrays), typically from SpreadsheetLib.readSpreadsheet. Columns are
  // matched by exact header name (trim+uppercase, no digit-suffix folding —
  // this report's names, e.g. TRKID1, are literal, not suffixed variants of
  // a shared name). Any row without a TRKID1 is skipped (blank/garbage row).
  // DAYS_ACTIVE is parsed to a Number (NaN when unparseable, never dropped —
  // a blank ADDRESS or malformed age must still render, never silently
  // vanish from the work-down list).
  // Number('') and Number('  ') are 0, not NaN — so a blank DAYS_ACTIVE cell
  // would parse to "0 days" and sink to the freshest end of the list, the
  // opposite of the NaN-sorts-oldest contract above. Guard blank -> NaN.
  function numOrNaN(v) {
    const s = String(v == null ? '' : v).trim();
    return s === '' ? NaN : Number(s);
  }

  function parseRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const start = findHeaderIndex(rows);
    const get = columnGetter(rows[start]);
    const out = [];
    for (let r = start + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      const trkid1 = get(row, 'TRKID1');
      if (!trkid1) continue; // skip blank / unparseable rows
      out.push({
        TRKID1: trkid1,
        SCAN_CREATE_TM: get(row, 'SCAN_CREATE_TM'),
        DISPLAYED_WORK_AREA_NBR: get(row, 'DISPLAYED_WORK_AREA_NBR'),
        PLANNED_WORK_AREAS: get(row, 'PLANNED_WORK_AREAS'),
        CATEGORY: get(row, 'CATEGORY'),
        SWAK_TM_FIRST: get(row, 'SWAK_TM_FIRST'),
        SWAK_TYPE_FIRST: get(row, 'SWAK_TYPE_FIRST'),
        DAYS_ACTIVE: numOrNaN(get(row, 'DAYS_ACTIVE')),
        NETWORK: get(row, 'NETWORK'),
        STOP_ID_TYPE: get(row, 'STOP_ID_TYPE'),
        STOP_ID: get(row, 'STOP_ID'),
        ADDRESS: get(row, 'ADDRESS'), // often blank (41 of 83 real rows) — render gracefully, never crash/drop
        LABEL_POSTAL_CODE: get(row, 'LABEL_POSTAL_CODE'),
        ZIP11_SCORE: get(row, 'ZIP11_SCORE'),
        GEO_SCORE: get(row, 'GEO_SCORE'),
        PREV_DELV_SUMMARY: get(row, 'PREV_DELV_SUMMARY'),
        PSD: get(row, 'PSD'),
        PLANNED: get(row, 'PLANNED'),
        TRAILER_NBR: get(row, 'TRAILER_NBR'),
        BARCODE: get(row, 'BARCODE'),
      });
    }
    return out;
  }

  // sortForView(records) -> a NEW array (non-mutating), the work-down list
  // order: grouped by CATEGORY (the prescription for how to work the
  // package), category groups ordered by their own oldest DAYS_ACTIVE
  // descending (the most overdue category leads), and oldest-first by
  // DAYS_ACTIVE within each group. Unparseable DAYS_ACTIVE (NaN) sorts as
  // oldest (surfaces first) rather than silently sinking to the bottom.
  function sortKeyDays(d) { return isFinite(d) ? d : Infinity; }
  function sortForView(records) {
    const list = Array.isArray(records) ? records.slice() : [];
    const maxByCategory = Object.create(null);
    list.forEach(function (rec) {
      const cat = rec.CATEGORY || '';
      const d = sortKeyDays(rec.DAYS_ACTIVE);
      if (!(cat in maxByCategory) || d > maxByCategory[cat]) maxByCategory[cat] = d;
    });
    return list.sort(function (a, b) {
      const catA = a.CATEGORY || '', catB = b.CATEGORY || '';
      if (catA !== catB) return maxByCategory[catB] - maxByCategory[catA];
      return sortKeyDays(b.DAYS_ACTIVE) - sortKeyDays(a.DAYS_ACTIVE);
    });
  }

  // summarize(records) -> { total, categories: [{category, count}],
  // ageBuckets: [{bucket, count}] }. categories sorted count-desc (ties
  // alphabetical); ageBuckets in the fixed AGE_BUCKETS order (zero counts
  // included, so the summary shape is stable across drops).
  function summarize(records) {
    const list = Array.isArray(records) ? records : [];
    const catCounts = Object.create(null);
    const bucketCounts = Object.create(null);
    AGE_BUCKETS.forEach(function (b) { bucketCounts[b] = 0; });
    list.forEach(function (rec) {
      const cat = rec.CATEGORY || '(uncategorized)';
      catCounts[cat] = (catCounts[cat] || 0) + 1;
      bucketCounts[ageBucket(rec.DAYS_ACTIVE)]++;
    });
    const categories = Object.keys(catCounts)
      .map(function (cat) { return { category: cat, count: catCounts[cat] }; })
      .sort(function (a, b) { return b.count - a.count || a.category.localeCompare(b.category); });
    const ageBuckets = AGE_BUCKETS.map(function (b) { return { bucket: b, count: bucketCounts[b] }; });
    return { total: list.length, categories: categories, ageBuckets: ageBuckets };
  }

  return {
    HEADER_SIGNATURE: HEADER_SIGNATURE,
    AGE_BUCKETS: AGE_BUCKETS,
    findHeaderIndex: findHeaderIndex,
    ageBucket: ageBucket,
    parseRows: parseRows,
    sortForView: sortForView,
    summarize: summarize,
  };
});
