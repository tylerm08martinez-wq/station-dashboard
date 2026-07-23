'use strict';

// One front door for every report file the dashboard tools accept, routed by
// the file's actual CONTENT, not its extension — because the FedEx exports lie
// about their type constantly: a ".xls" is often really an .xlsx ZIP, an HTML
// table, or plain CSV, and a ".csv" sometimes arrives BOM-first. Sniffing the
// bytes means a mislabeled file still loads instead of being silently rejected.
//
// Dual-loadable, no build step:
// - Browser: window.SpreadsheetLib.readSpreadsheet
// - Node:    require('./lib/spreadsheet').readSpreadsheet  (for tests)
//
// readSpreadsheet(bytes) -> Promise<rows>, rows in CsvLib.parseCSV shape
// (header first, blank rows dropped, every cell a trimmed string) so the
// In-Area-12 engine and header validation consume any source identically.
//
// Routing by leading bytes:
//   50 4B ............  "PK"  -> .xlsx (ZIP)            -> XlsxLib.parseXlsx
//   D0 CF 11 E0 ......  OLE2  -> legacy binary .xls     -> clear, actionable error
//   '<' (after WS) ....  HTML/XML table export          -> parseHtmlTable
//   anything else .....  delimited text (CSV/TSV)       -> CsvLib.parseCSV
//
// The legacy binary .xls (BIFF/OLE2) is the one format we can't read in-browser
// without a heavy decoder — so we name it and tell the user the one-click fix
// (re-export as .xlsx or .csv) instead of failing with a cryptic parse error.

(function (root, factory) {
  const deps = {
    CsvLib: (typeof require === 'function') ? safeRequire('./csv') : (root && root.CsvLib),
    XlsxLib: (typeof require === 'function') ? safeRequire('./xlsx') : (root && root.XlsxLib),
  };
  function safeRequire(p) { try { return require(p); } catch (e) { return null; } }
  const api = factory(deps, root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SpreadsheetLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps, root) {

  function getCsvLib() { return deps.CsvLib || (root && root.CsvLib); }
  function getXlsxLib() { return deps.XlsxLib || (root && root.XlsxLib); }

  function toU8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (typeof ArrayBuffer !== 'undefined' && bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (bytes && bytes.buffer instanceof ArrayBuffer) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (typeof bytes === 'string') return new TextEncoder().encode(bytes);
    throw new Error('spreadsheet: expected an ArrayBuffer, Uint8Array, or string');
  }

  function decodeText(u8) {
    // ignoreBOM defaults false, so a UTF-8 BOM is stripped here; CsvLib also
    // guards it, so double-safety either way.
    return new TextDecoder('utf-8').decode(u8);
  }

  // Minimal, dependency-free HTML-table reader. Many "Excel" exports are really
  // an HTML document with one <table>; take the first table, its <tr> rows, and
  // each row's <td>/<th> cells, stripped of tags and entity-decoded. Regex-based
  // on purpose: env-agnostic (no DOMParser/jsdom needed) and these exports are
  // flat tables, not arbitrary nested HTML.
  function parseHtmlTable(html) {
    const tableMatch = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(html);
    const scope = tableMatch ? tableMatch[1] : html;
    const rows = [];
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    const cellRe = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let tr;
    while ((tr = trRe.exec(scope)) !== null) {
      const cells = [];
      let cell;
      cellRe.lastIndex = 0;
      while ((cell = cellRe.exec(tr[1])) !== null) {
        cells.push(stripTags(cell[1]));
      }
      if (cells.some(function (c) { return c !== ''; })) rows.push(cells);
    }
    return rows;
  }

  function stripTags(s) {
    return decodeEntities(
      s.replace(/<br\s*\/?>/gi, ' ')      // line breaks -> spaces
       .replace(/<[^>]+>/g, '')           // drop any remaining tags
    ).replace(/\s+/g, ' ').trim();
  }

  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    // Self-contained on purpose: HTML table text carries &nbsp; (which the xlsx
    // decoder doesn't cover), so handle the full set here.
    return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);/g, function (m, code) {
      switch (code) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        case 'nbsp': return ' ';
        default:
          if (code[0] === '#') {
            const cp = (code[1] === 'x' || code[1] === 'X') ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return isNaN(cp) ? m : String.fromCodePoint(cp);
          }
          return m;
      }
    });
  }

  // bytes -> Promise<rows>. Synchronous detection, async only for the xlsx
  // inflate path; wrapped in Promise.resolve so callers have one code path.
  function readSpreadsheet(bytes) {
    return Promise.resolve().then(function () {
      const u8 = toU8(bytes);
      if (u8.length === 0) return [];

      // .xlsx (ZIP). Match the FULL local-file-header signature PK\x03\x04, not
      // just "PK" — a CSV that happens to start with "PKG_LABEL_XREF" also
      // begins 0x50 0x4b, and must NOT be mistaken for a ZIP.
      if (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04) {
        const xlsx = getXlsxLib();
        if (!xlsx) throw new Error('spreadsheet: xlsx reader unavailable');
        return xlsx.parseXlsx(u8);
      }

      // Legacy binary .xls (OLE2 compound file): can't read without a heavy
      // decoder — give the one-click fix instead of a cryptic failure.
      if (u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) {
        throw new Error('this is a legacy binary .xls — open it in Excel and re-save as .xlsx (or CSV), then drop that');
      }

      // Text-ish: HTML table export, or delimited text (CSV/TSV).
      const text = decodeText(u8);
      if (/^\s*<(?:!doctype|html|table|\?xml)/i.test(text)) {
        return parseHtmlTable(text);
      }
      const csv = getCsvLib();
      if (!csv) throw new Error('spreadsheet: csv reader unavailable');
      return csv.parseCSV(text);
    });
  }

  return { readSpreadsheet: readSpreadsheet, _internals: { parseHtmlTable: parseHtmlTable, stripTags: stripTags } };
});
