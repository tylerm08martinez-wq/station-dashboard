'use strict';

// Clean Excel-ready export core (PRD #384, tracer bullet #385, ADR-0015).
//
// Turns parsed report rows (WITH the SSRS preamble) into de-preambled keyed
// records, then serializes them to a barcode-safe CSV so Excel keeps tracking
// numbers / barcodes as text instead of collapsing them to `1.2E+11`.
//
// PURE: no DOM, no storage. Dual-loadable with no build step:
// - Browser: window.ReportClean.*
// - Node:    require('./lib/report-clean')
//
// It REUSES the existing header-finders rather than rolling a new preamble
// detector. Each report family already ships one:
//  - Inbound and Van Scans      -> IbnoRules.findHeaderIndex
//  - Manual Assignment Detail   -> MasterlistLib.findHeaderIndex
//        (NOT IbnoRules.findHeaderIndex — that keys on PKG_LABEL_XREF +
//         INBOUND_DATE, which this report LACKS, so it would return 0 and
//         treat the SSRS preamble as the header. The MasterList Builder's
//         finder keys on TRACKING ID + ORIGINAL SCAN, which this report has.)
//  - Address Corrections        -> AddressCatcherSession.findCorrectionsHeaderIndex
//        (no SSRS preamble at all — the header is row 0.)
// The tracer bullet (#385) wired only the Inbound report; #386 added the two
// Address Catcher reports below.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.ReportClean = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  // Header-finders live in three different libs (one per report family).
  // Resolve each the dual-loadable way the rest of lib/ does: prefer an
  // injected/global, else require it in Node. Lazy + cached, so a browser that
  // loads a lib AFTER this file still works, and Node never eagerly pulls a
  // heavy dep it won't use for the report type in hand.
  const LIB_NODE_MODULES = {
    IbnoRules: './ibno-rules',
    MasterlistLib: './masterlist',
    AddressCatcherSession: './address-catcher-session',
  };
  const libCache = Object.create(null);
  function resolveLib(name) {
    if (libCache[name]) return libCache[name];
    let lib =
      (root && root[name]) ||
      (typeof globalThis !== 'undefined' && globalThis[name]) ||
      null;
    if (!lib && typeof require === 'function' && LIB_NODE_MODULES[name]) {
      try { lib = require(LIB_NODE_MODULES[name]); } catch (e) { lib = null; }
    }
    if (lib) libCache[name] = lib;
    return lib;
  }

  // ── Report-type registry ────────────────────────────────────────────────
  // Each report type declares how to strip its preamble (which lib's
  // header-finder) and which columns hold tracking numbers / barcodes that
  // Excel would wreck. Barcode columns are matched case-insensitively against
  // the real header at serialize time. The header-finder is resolved lazily.
  const REPORT_TYPES = {
    'inbound-van-scans': {
      label: 'Inbound and Van Scans',
      // SSRS-preambled: title/compliance block sits above the real header.
      headerFinder: { lib: 'IbnoRules', fn: 'findHeaderIndex' },
      // Columns that are numeric-looking tracking IDs / scanned barcodes and
      // collapse to scientific notation or truncate in Excel.
      barcodeColumns: [
        'PKG_LABEL_XREF',
        'EXPRESS_TRACK',
        'IB_BARCODE_SCANNED',
        'SCAN_BARCODE',
        'VAN_BARCODE_SCANNED',
        'VAN_SCAN_BARCODE',
      ],
    },
    'manual-assignment': {
      label: 'Manual Assignment Detail at IB Scan',
      // SSRS-preambled (a Textbox4 title block above the real header). Uses the
      // MasterList Builder's finder — see the file-top note on why not IbnoRules.
      headerFinder: { lib: 'MasterlistLib', fn: 'findHeaderIndex' },
      // Real columns: TRACKING_ID + SCAN_BARCODE are barcodes; POSTAL_CODE is an
      // 11-digit ZIP+4 concatenation Excel also collapses to 8.5E+10.
      barcodeColumns: ['TRACKING_ID', 'SCAN_BARCODE', 'POSTAL_CODE'],
    },
    'address-corrections': {
      label: 'Address Corrections',
      // NO SSRS preamble — the header is row 0. Reuses the Address Catcher's
      // own header-finder (signature: Tracking id + Original/Corrected Address).
      headerFinder: { lib: 'AddressCatcherSession', fn: 'findCorrectionsHeaderIndex' },
      // The real export's numeric tracking column (Original/Corrected Address
      // are free text, never barcode-wrapped).
      barcodeColumns: ['Tracking id'],
    },
  };

  function getReportType(reportType) {
    const cfg = REPORT_TYPES[reportType];
    if (!cfg) {
      throw new Error('report-clean: unknown reportType "' + reportType + '"');
    }
    return cfg;
  }

  // Locate the header row index for a report, delegating to the reused
  // header-finder. No preamble / malformed file falls back to 0, matching the
  // legacy behavior of the finders themselves.
  function headerIndexFor(rows, cfg) {
    if (!Array.isArray(rows)) return 0;
    const spec = cfg.headerFinder;
    const lib = resolveLib(spec.lib);
    const finder = lib && typeof lib[spec.fn] === 'function' ? lib[spec.fn] : null;
    if (!finder) {
      throw new Error(
        'report-clean: header-finder "' + spec.lib + '.' + spec.fn + '" unavailable (' + spec.lib + ' not loaded)'
      );
    }
    return finder(rows) || 0;
  }

  // Normalize a header cell to a stable column name (trimmed). Blank headers
  // become positional placeholders so a stray empty column never collides.
  function normalizeColumns(headerRow) {
    const seen = Object.create(null);
    return (Array.isArray(headerRow) ? headerRow : []).map(function (h, i) {
      let name = String(h == null ? '' : h).trim();
      if (!name) name = 'COLUMN_' + (i + 1);
      // De-dup repeated header names so record keys stay 1:1 with columns.
      if (seen[name] !== undefined) {
        seen[name] += 1;
        name = name + '_' + seen[name];
      } else {
        seen[name] = 0;
      }
      return name;
    });
  }

  // columnsFor(rows, reportType) -> string[] of the real header, preamble
  // stripped. Empty when there is no header.
  function columnsFor(rows, reportType) {
    const cfg = getReportType(reportType);
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const start = headerIndexFor(rows, cfg);
    return normalizeColumns(rows[start]);
  }

  // barcodeColumnsFor(reportType) -> string[] the declared barcode/tracking
  // columns for that report (as declared; case-insensitive at serialize time).
  function barcodeColumnsFor(reportType) {
    return getReportType(reportType).barcodeColumns.slice();
  }

  // cleanRecords(rows, reportType) -> record[]
  // Strips the SSRS preamble via the report's header-finder and returns one
  // plain object per data row, keyed by the real header column names. A report
  // with a header but no data rows yields [] (header-only export downstream).
  function cleanRecords(rows, reportType) {
    const cfg = getReportType(reportType);
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const start = headerIndexFor(rows, cfg);
    const columns = normalizeColumns(rows[start]);
    const records = [];
    for (let i = start + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      const rec = Object.create(null);
      for (let c = 0; c < columns.length; c++) {
        const cell = row[c];
        rec[columns[c]] = cell == null ? '' : String(cell);
      }
      records.push(rec);
    }
    return records;
  }

  // ── Report-dialect display decoders ─────────────────────────────────────
  // fedexDateShort(raw) -> 'MM/DD/YY' for the Address Corrections report's
  // Date encoding: a literal `1` prefix + YY + MMDD ('1260612' -> '06/12/26').
  // Anything that doesn't fit the encoding — wrong length, non-digits, a bad
  // month/day — passes through RAW so a report dialect change never blanks a
  // cell (issue #516: display-only decode; search/sort stay over the raw
  // value, which already sorts chronologically).
  function fedexDateShort(raw) {
    const s = raw == null ? '' : String(raw).trim();
    if (!/^1\d{6}$/.test(s)) return s;
    const yy = s.slice(1, 3);
    const mm = parseInt(s.slice(3, 5), 10);
    const dd = parseInt(s.slice(5, 7), 10);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return s;
    return s.slice(3, 5) + '/' + s.slice(5, 7) + '/' + yy;
  }

  // ── CSV serialization ───────────────────────────────────────────────────
  // Standard RFC-4180 field escaping: quote when the value contains a comma,
  // quote, CR/LF, or a leading `=` (so Excel doesn't eval a bare formula), and
  // double any embedded quotes.
  function escapeField(value) {
    const s = value == null ? '' : String(value);
    if (s === '') return '';
    if (/[",\r\n]/.test(s) || s.charAt(0) === '=') {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // Wrap a barcode/tracking value as an Excel text-forcing formula: `="<v>"`.
  // Excel evaluates `="12345"` to the literal text 12345, so it never applies
  // scientific notation or truncation. Blank stays blank (no `=""` noise).
  function barcodeField(value) {
    const s = value == null ? '' : String(value);
    if (s === '') return '';
    // `="<v>"` contains `=` and `"`, so it always needs CSV quoting.
    return '"=""' + s.replace(/"/g, '""') + '"""';
  }

  // toBarcodeSafeCsv(records, columns, barcodeColumns) -> string
  // Serializes records to CSV. `columns` fixes the column order and the header
  // row. Any column named in `barcodeColumns` (case-insensitive) is wrapped
  // `="…"` so Excel keeps it as text. With no records the result is a valid
  // header-only CSV. CRLF line endings — what Excel expects on Windows.
  function toBarcodeSafeCsv(records, columns, barcodeColumns) {
    const cols = Array.isArray(columns) ? columns : [];
    const barcodeSet = Object.create(null);
    (Array.isArray(barcodeColumns) ? barcodeColumns : []).forEach(function (c) {
      barcodeSet[String(c == null ? '' : c).trim().toUpperCase()] = true;
    });
    const isBarcode = cols.map(function (c) {
      return barcodeSet[String(c == null ? '' : c).trim().toUpperCase()] === true;
    });

    const lines = [];
    lines.push(cols.map(escapeField).join(','));
    (Array.isArray(records) ? records : []).forEach(function (rec) {
      const cells = cols.map(function (col, i) {
        const raw = rec == null ? '' : rec[col];
        return isBarcode[i] ? barcodeField(raw) : escapeField(raw);
      });
      lines.push(cells.join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  // cleanReport(rows, reportType) -> { columns, records, barcodeColumns, csv }
  // Convenience one-call bundle for the host tool: de-preambled columns +
  // records + the ready-to-download barcode-safe CSV. Header-only when the
  // report has no data rows.
  function cleanReport(rows, reportType) {
    const columns = columnsFor(rows, reportType);
    const records = cleanRecords(rows, reportType);
    const barcodeColumns = barcodeColumnsFor(reportType);
    const csv = toBarcodeSafeCsv(records, columns, barcodeColumns);
    return {
      columns: columns,
      records: records,
      barcodeColumns: barcodeColumns,
      csv: csv,
    };
  }

  return {
    REPORT_TYPES: REPORT_TYPES,
    cleanRecords: cleanRecords,
    columnsFor: columnsFor,
    barcodeColumnsFor: barcodeColumnsFor,
    toBarcodeSafeCsv: toBarcodeSafeCsv,
    cleanReport: cleanReport,
    fedexDateShort: fedexDateShort,
  };
});
