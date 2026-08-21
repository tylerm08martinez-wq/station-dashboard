'use strict';

// Parser for the dedicated No Van Scan (NVS) report export (issue #416, ADR-0017).
//
// This is a NET-NEW parser, deliberately NOT the shared Inbound-and-Van-Scans
// parser (lib/inbound-scans.js): the NVS export carries DEVICE_DIM_CODE (size
// class) and ISSUE_TYPE columns the shared report lacks, and FedEx pre-filters
// it to no-van-scan / misload rows. Unlike the SSRS exports the other tools eat,
// this report has NO preamble — row 0 IS the header.
//
// Dual-loadable with no build step:
// - Browser: window.NvsReportLib / window.parseNvsReport
// - Node: require('./lib/nvs-report').parseNvsReport
//
// parseNvsReport(text) -> { headers, records }
//   headers: the raw header names (row 0), trimmed.
//   records: one keyed object per data row. Keys are the UPPERCASED, trimmed
//            header names (e.g. record.SORT_SID, record.DEVICE_DIM_CODE); values
//            are trimmed strings. Empty cells become ''. Fully-blank rows are
//            dropped (lib/csv.js already skips them).
//
// Two report DIALECTS (issue #436/#444, ADR-0017 addendum): the same export
// also arrives as .xlsx, with a multi-line SSRS preamble in row 0, the header
// in row 1, and friendly display headers (D, TRACKING, WA, TRAILER SCAN, ...)
// instead of the CSV's canonical keys (DEVICE_DIM_CODE, PKG_LABEL_XREF,
// IB_WORK_AREA, TRAILER_SCAN, ...). parseNvsRows(rows) is the shared entry
// point for BOTH dialects: it accepts rows already in CsvLib.parseCSV shape
// (an array of row arrays — exactly what CsvLib.parseCSV and XlsxLib.parseXlsx
// both return), locates the real header row by CONTENT (the first row whose
// mapped keys include BELT + SORT_SID/PKG_LABEL_XREF, per the grill
// recommendation — tolerant of a preamble that grows a line, instead of
// assuming a fixed row index), and maps every header cell through
// HEADER_ALIASES onto the CSV's canonical key before building records.
// parseNvsReport(text) is now a thin CSV-only wrapper: parseCSV(text) then
// parseNvsRows(rows). A CSV's headers are ALREADY canonical, so none of them
// match a HEADER_ALIASES key and they pass through unchanged — the CSV path's
// behavior and output are byte-for-byte the same as before this change.
//
// HEADER_ALIASES is the 16-entry name-based alias map pinned in the parent
// issue's grill-resolution comment (#436, 2026-07-07): 12 renamed headers
// (DEST->DESTINATION, HOT PKG->PRIORITY_PACKAGE, TRACKING->PKG_LABEL_XREF,
// WA->IB_WORK_AREA, SID->SORT_SID, D->DEVICE_DIM_CODE, WGT->PKG_WEIGHT,
// ADDRESS1->LABEL_ADDRESS1, CITY->LABEL_CITY, POSTAL->POSTAL_CODE,
// ISSUE->ISSUE_TYPE, TRAILER SCAN->TRAILER_SCAN) plus 4 that differ only by
// space vs underscore (headerKey() does NOT normalize spaces to underscores,
// so these need explicit entries too): IB TIME->IB_TIME,
// IB TRAILER->IB_TRAILER, AUTO SORT->AUTO_SORT, STATUS CODES->STATUS_CODES.
// Only BELT is byte-identical between dialects (no alias entry needed).
//
// ASSUMPTION (issue #444, documented per the issue's "don't freeze on
// ambiguity" instruction): the parent's grill-comment prose abbreviates the
// last alias as "TRAILER SCAN" -> "TRAILER_SC", but the real CSV fixture's
// canonical header (and every existing consumer/test) is TRAILER_SCAN, not
// TRAILER_SC — verified against reports/source-files/2026-07-07-...csv and
// tests/nvs-report.test.js's `TRAILER_SCAN` assertions. Treated the actual
// canonical key already in use as authoritative over the doc's shorthand and
// mapped TRAILER SCAN -> TRAILER_SCAN accordingly.
//
// LOUD REFUSAL on a missing required column (issue #445, ADR-0017 addendum
// decision 1): REQUIRED_COLUMNS is the full 17-column canonical schema (every
// key BELT plus every HEADER_ALIASES target). If the detected header row's
// mapped keys are missing ANY of them — because FedEx renamed or dropped a
// column and no alias covers the new name — parseNvsRows() throws instead of
// building records from a partial/misaligned schema. The thrown Error names
// every missing canonical column in its message and carries them as
// `err.missingColumns` for callers that want the list without parsing prose.
// nvs-builder.html's existing SpreadsheetLib.readSpreadsheet(...).then(...)
// chain already funnels a thrown error from inside .then() into its .catch()
// -> window.alert(), so this throw surfaces as a visible in-tool error with
// no extra wiring; the change handler additionally resets state so no
// worklist renders from the partial parse (see nvs-builder.html).
//
// ISSUE_TYPE classification (issue #418): the report carries two row kinds —
// "No Van Scan" (not loaded) and "Misload - <area> | <handler> <time>"
// (misloaded: already van-scanned, to the WRONG truck).
//   isMisload(issueType)  -> true when ISSUE_TYPE starts with "Misload".
//   isNoVanScan(issueType) -> true when ISSUE_TYPE starts with "No Van Scan".
//     A row matching NEITHER kind is excluded from the worklist entirely
//     (issue #419) — the exclusion lives in lib/nvs-worklist.js; both
//     classifiers live here so there is one classification home.
//   parseMisload(issueType) -> { scannedArea, handler, time, raw } for a
//     misload row (e.g. "Misload - 484 | DBerends 03:44 AM" -> scannedArea
//     '484', handler 'DBerends', time '03:44 AM'); null for a non-misload row.
//     SEMANTICS (corrected, #441 misload-redesign verdict 2026-07-08): the
//     parsed area is where the package was mis-SCANNED (whose truck got the
//     wrong scan), NOT a destination. The package BELONGS to the row's own
//     IB_WORK_AREA. The handler/time are the mis-scan actor and when. A
//     malformed detail string never crashes: scannedArea/handler/time come
//     back '' with the raw remainder preserved in `raw`, which the tool
//     displays verbatim on the row (issue #419 — never hide a package over
//     bad data).

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.NvsReportLib = api;
    root.parseNvsReport = api.parseNvsReport;
  }
  // parseNvsRows is reached via NvsReportLib.parseNvsRows in the browser
  // (no separate window.* shortcut, mirroring how the other classifiers are
  // reached today).
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const csvApi = (typeof require === 'function') ? require('./csv') : null;
  const parseCSV = csvApi && csvApi.parseCSV ? csvApi.parseCSV : (root && root.parseCSV);

  function headerKey(name) {
    return String(name == null ? '' : name).trim().toUpperCase();
  }

  // xlsx friendly header (uppercased/trimmed via headerKey) -> CSV canonical
  // key. See the file-header comment above for the full rationale and the
  // TRAILER_SCAN assumption. BELT is intentionally absent (byte-identical).
  const HEADER_ALIASES = {
    'DEST': 'DESTINATION',
    'IB TIME': 'IB_TIME',
    'IB TRAILER': 'IB_TRAILER',
    'AUTO SORT': 'AUTO_SORT',
    'HOT PKG': 'PRIORITY_PACKAGE',
    'TRACKING': 'PKG_LABEL_XREF',
    'WA': 'IB_WORK_AREA',
    'SID': 'SORT_SID',
    'D': 'DEVICE_DIM_CODE',
    'WGT': 'PKG_WEIGHT',
    'ADDRESS1': 'LABEL_ADDRESS1',
    'CITY': 'LABEL_CITY',
    'POSTAL': 'POSTAL_CODE',
    'STATUS CODES': 'STATUS_CODES',
    'ISSUE': 'ISSUE_TYPE',
    'TRAILER SCAN': 'TRAILER_SCAN',
  };

  // The full 17-column canonical schema (issue #445): BELT (the one
  // byte-identical column, absent from HEADER_ALIASES) plus every
  // HEADER_ALIASES target. A header row missing any of these — from either
  // dialect — fails the parse loudly rather than building partial records.
  const REQUIRED_COLUMNS = ['BELT'].concat(
    Array.from(new Set(Object.keys(HEADER_ALIASES).map(function (k) { return HEADER_ALIASES[k]; })))
  );

  // Raw header cell -> canonical record key. A CSV's headers are already
  // canonical (e.g. "SORT_SID"), so they miss HEADER_ALIASES and pass through
  // headerKey() unchanged, identical to pre-#444 behavior.
  function canonicalKey(rawHeader) {
    const key = headerKey(rawHeader);
    return Object.prototype.hasOwnProperty.call(HEADER_ALIASES, key) ? HEADER_ALIASES[key] : key;
  }

  // The real header row, located by CONTENT rather than a fixed index — the
  // CSV dialect has no preamble (header is row 0); the xlsx dialect has a
  // multi-line SSRS preamble ahead of it (verified: row 0). Scanning a small
  // window and testing for BELT + (SORT_SID or PKG_LABEL_XREF) tolerates a
  // preamble that grows a line without breaking ingestion (grill
  // recommendation, #436). Falls back to row 0 if nothing matches, preserving
  // prior behavior for any input this heuristic doesn't recognize.
  const HEADER_SCAN_WINDOW = 10;
  function findHeaderRowIndex(rows) {
    const limit = Math.min(rows.length, HEADER_SCAN_WINDOW);
    for (let i = 0; i < limit; i++) {
      const keys = rows[i].map(canonicalKey);
      if (keys.indexOf('BELT') !== -1 &&
          (keys.indexOf('SORT_SID') !== -1 || keys.indexOf('PKG_LABEL_XREF') !== -1)) {
        return i;
      }
    }
    return 0;
  }

  // Shared entry point for both dialects: rows already in CsvLib.parseCSV
  // shape (array of row arrays), from either CsvLib.parseCSV or
  // XlsxLib.parseXlsx.
  function parseNvsRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return { headers: [], records: [] };

    const headerIdx = findHeaderRowIndex(list);
    const headers = list[headerIdx].map(function (h) { return String(h == null ? '' : h).trim(); });
    const keys = headers.map(canonicalKey);

    const missing = REQUIRED_COLUMNS.filter(function (col) { return keys.indexOf(col) === -1; });
    if (missing.length) {
      const err = new Error(
        'NVS report is missing required column(s): ' + missing.join(', ') + '. ' +
        'FedEx likely renamed or dropped a header in the source file — add the new ' +
        'name to HEADER_ALIASES in lib/nvs-report.js, or re-check the export.'
      );
      err.name = 'NvsMissingColumnsError';
      err.missingColumns = missing;
      throw err;
    }

    const records = list.slice(headerIdx + 1).map(function (row) {
      const rec = Object.create(null);
      keys.forEach(function (key, i) {
        if (!key || rec[key] !== undefined) return; // first occurrence of a key wins
        const cell = row[i];
        rec[key] = String(cell == null ? '' : cell).trim();
      });
      return rec;
    });

    return { headers: headers, records: records };
  }

  function parseNvsReport(text) {
    return parseNvsRows(parseCSV(String(text == null ? '' : text)));
  }

  function isMisload(issueType) {
    return /^\s*Misload/i.test(String(issueType == null ? '' : issueType));
  }

  function isNoVanScan(issueType) {
    return /^\s*No Van Scan/i.test(String(issueType == null ? '' : issueType));
  }

  // "Misload - <area> | <handler> <time>" -> { scannedArea, handler, time, raw }.
  // scannedArea = the area whose truck received the WRONG scan (corrected
  // semantics, #441 misload-redesign verdict — not a destination; the package
  // belongs to the row's own IB_WORK_AREA). Non-misload -> null. Malformed
  // detail -> ''-fields + the raw remainder, displayed verbatim by the tool
  // (issue #419).
  function parseMisload(issueType) {
    const s = String(issueType == null ? '' : issueType);
    // Same "starts with Misload" prefix isMisload() tests, plus the detail capture.
    const head = /^\s*Misload\s*(?:-\s*)?(.*)$/i.exec(s);
    if (!head) return null;
    const detail = head[1].trim();
    // Handler names can contain spaces (e.g. "SLUJAN II"), so anchor the time
    // at the end and take everything between "|" and it as the handler.
    const m = /^(.*?)\s*\|\s*(.*?)\s+(\d{1,2}:\d{2}\s*(?:AM|PM))\s*$/i.exec(detail);
    if (!m) return { scannedArea: '', handler: '', time: '', raw: detail };
    return { scannedArea: m[1].trim(), handler: m[2].trim(), time: m[3].trim(), raw: detail };
  }

  return {
    parseNvsReport: parseNvsReport,
    parseNvsRows: parseNvsRows,
    headerKey: headerKey,
    HEADER_ALIASES: HEADER_ALIASES,
    REQUIRED_COLUMNS: REQUIRED_COLUMNS,
    isMisload: isMisload,
    isNoVanScan: isNoVanScan,
    parseMisload: parseMisload,
  };
});
