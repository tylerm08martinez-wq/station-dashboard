'use strict';

// Single-source CSV reader for the Station 849 dashboard tools (issue #85).
//
// Dual-loadable with no build step:
// - Browser: window.parseCSV / window.columnGetter (and window.CsvLib.*)
// - Node: require('./lib/csv').parseCSV
//
// Canonical implementation lifted verbatim from ibno-coder.html; the
// masterlist-builder.html copy was derived from it and is now retired in
// favor of this module. Handles: BOM strip, quoted fields with embedded
// commas / newlines, doubled-quote escapes, and blank-row skipping.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.CsvLib = api;
    root.parseCSV = api.parseCSV;
    root.columnGetter = api.columnGetter;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function parseCSV(text) {
    // Strip BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    const rows = [];
    let i = 0;
    const len = text.length;

    while (i < len) {
      const row = [];
      while (true) {
        if (i >= len) { row.push(''); break; }

        if (text[i] === '"') {
          // Quoted field — handles embedded commas, newlines, and doubled quotes
          i++;
          let field = '';
          while (i < len) {
            if (text[i] === '"') {
              if (i + 1 < len && text[i + 1] === '"') { field += '"'; i += 2; }
              else { i++; break; }
            } else {
              field += text[i++];
            }
          }
          row.push(field.trim());
        } else {
          // Unquoted field
          let field = '';
          while (i < len && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') {
            field += text[i++];
          }
          row.push(field.trim());
        }

        if (i < len && text[i] === ',') { i++; continue; }  // next field
        if (i < len && text[i] === '\r') i++;
        if (i < len && text[i] === '\n') i++;
        break; // end of row
      }
      if (row.some(f => f !== '')) rows.push(row);  // drop fully-blank rows
    }
    return rows;
  }

  function columnGetter(headerRow) {
    const map = Object.create(null);
    const headers = Array.isArray(headerRow) ? headerRow : [];
    headers.forEach(function (header, index) {
      const key = String(header == null ? '' : header).trim().toUpperCase();
      if (key && map[key] === undefined) map[key] = index;
    });

    return function get(row, name) {
      const key = String(name == null ? '' : name).trim().toUpperCase();
      const index = map[key];
      if (!Array.isArray(row) || index === undefined || index < 0 || index >= row.length) return '';
      const cell = row[index];
      return String(cell == null ? '' : cell).trim();
    };
  }

  // Header validation shared by the report-dropping tools: the canonical
  // names from `expected` not present in `headerRow`, matched the way
  // columnGetter matches (trimmed, case-insensitive). [] means valid. Tools
  // that read columns by name silently get empty cells when a header is
  // missing — callers use this to fail loudly instead.
  function missingHeaders(headerRow, expected) {
    const present = Object.create(null);
    (Array.isArray(headerRow) ? headerRow : []).forEach(function (h) {
      const key = String(h == null ? '' : h).trim().toUpperCase();
      if (key) present[key] = true;
    });
    return (Array.isArray(expected) ? expected : []).filter(function (name) {
      return !present[String(name).trim().toUpperCase()];
    });
  }

  return { parseCSV: parseCSV, columnGetter: columnGetter, missingHeaders: missingHeaders };
});
