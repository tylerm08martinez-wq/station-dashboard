'use strict';

// Minimal, zero-dependency .xlsx reader for the Station 849 dashboard tools
// (DSW, issue: dsw-xlsx-support). The FedEx "Inbound and Van Scans" report now
// exports as a real Office Open XML workbook (ZIP of XML), not CSV, so the
// drop-zone tools need to read it directly instead of forcing a manual
// "Save As CSV" step.
//
// Dual-loadable with no build step:
// - Browser: window.XlsxLib.parseXlsx  (inflate via native DecompressionStream)
// - Node:    require('./lib/xlsx').parseXlsx  (inflate via zlib) — for tests
//
// parseXlsx(bytes) -> Promise<rows>, where rows matches CsvLib.parseCSV output:
// an array of row arrays, header row first, fully-blank rows dropped, every
// cell a trimmed string. That shape lets the existing In-Area-12 engine and
// CsvLib header validation consume xlsx and csv identically.
//
// Scope/limitations (deliberate — keep the surface small):
// - Reads the FIRST worksheet only (these reports are single-sheet).
// - Date/time cells come through as their raw Excel serial number (e.g. 46141),
//   NOT a formatted date. No DSW column consumes a date — the engine joins on
//   tracking id + work area — so this is correct for the tool. Convert via
//   styles/numFmt later if a future consumer needs real dates.
// - Handles classic ZIP (deflate method 8 / stored method 0). NOT ZIP64 and
//   NOT the legacy binary .xls (BIFF/OLE2) format — callers detect the PK
//   signature and surface a clear message otherwise.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.XlsxLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function toU8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (typeof ArrayBuffer !== 'undefined' && bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (bytes && bytes.buffer instanceof ArrayBuffer) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    throw new Error('xlsx: expected an ArrayBuffer or Uint8Array');
  }

  // --- raw DEFLATE inflate, env-appropriate -------------------------------
  function inflateRaw(bytes) {
    if (bytes.length === 0) return Promise.resolve(new Uint8Array(0));
    // Node (tests): synchronous zlib.
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        const zlib = require('zlib');
        return Promise.resolve(new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes))));
      } catch (e) { /* fall through to browser path */ }
    }
    // Browser: native streaming inflate.
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('xlsx: this browser lacks DecompressionStream; cannot read .xlsx'));
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Response(bytes).body.pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  // --- ZIP central-directory walk -----------------------------------------
  // Returns a map of entryName -> { method, compSize, localOffset }.
  function readZipEntries(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    // End of Central Directory: signature 0x06054b50, scan backwards (comment
    // may follow, but these workbooks have none — bound the scan anyway).
    const EOCD_SIG = 0x06054b50;
    let eocd = -1;
    const minPos = Math.max(0, u8.length - 22 - 0xffff);
    for (let i = u8.length - 22; i >= minPos; i--) {
      if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('xlsx: not a valid .xlsx (no ZIP end-of-central-directory record)');

    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true); // central directory offset
    const entries = Object.create(null);
    const CEN_SIG = 0x02014b50;
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== CEN_SIG) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = utf8Slice(u8, p + 46, p + 46 + nameLen);
      entries[name] = { method: method, compSize: compSize, localOffset: localOffset };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { dv: dv, entries: entries };
  }

  function utf8Slice(u8, start, end) {
    return new TextDecoder('utf-8').decode(u8.subarray(start, end));
  }

  // Inflate one named entry to a UTF-8 string. Resolves '' if absent.
  function readEntryText(u8, zip, name) {
    const e = zip.entries[name];
    if (!e) return Promise.resolve('');
    const dv = zip.dv;
    // Local file header: name + extra lengths live here (central-dir extra can
    // differ), so recompute the data start from the local header.
    const lh = e.localOffset;
    const nameLen = dv.getUint16(lh + 26, true);
    const extraLen = dv.getUint16(lh + 28, true);
    const dataStart = lh + 30 + nameLen + extraLen;
    const comp = u8.subarray(dataStart, dataStart + e.compSize);
    if (e.method === 0) return Promise.resolve(new TextDecoder('utf-8').decode(comp)); // stored
    if (e.method === 8) return inflateRaw(comp).then(function (out) { return new TextDecoder('utf-8').decode(out); });
    return Promise.reject(new Error('xlsx: unsupported ZIP compression method ' + e.method + ' for ' + name));
  }

  // --- XML helpers ---------------------------------------------------------
  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, function (m, code) {
      switch (code) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        default:
          if (code[0] === '#') {
            const cp = code[1] === 'x' || code[1] === 'X'
              ? parseInt(code.slice(2), 16)
              : parseInt(code.slice(1), 10);
            return isNaN(cp) ? m : String.fromCodePoint(cp);
          }
          return m;
      }
    });
  }

  // <si>…</si> blocks -> array of plain strings (concatenating their <t> runs).
  function parseSharedStrings(xml) {
    const out = [];
    if (!xml) return out;
    const siRe = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>|<(?:\w+:)?si\b[^>]*\/>/g;
    const tRe = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>|<(?:\w+:)?t\b[^>]*\/>/g;
    let m;
    while ((m = siRe.exec(xml)) !== null) {
      const body = m[1] || '';
      let text = '';
      let t;
      tRe.lastIndex = 0;
      while ((t = tRe.exec(body)) !== null) text += (t[1] || '');
      out.push(decodeEntities(text));
    }
    return out;
  }

  // "AB" -> 27 (0-based column index from a cell reference's letters).
  function colToIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break; // stop at the row digits
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  // sheetData rows -> array of row arrays (cells placed at their column index,
  // interior gaps filled with '' so a header-name lookup stays aligned).
  function parseSheet(xml, shared) {
    const rows = [];
    if (!xml) return rows;
    // Tags may carry a namespace prefix — plain OOXML uses <sheetData>/<row>/<c>,
    // but SSRS/"Textbox12" Excel exports (the real FedEx report format) use
    // x:-prefixed <x:sheetData>/<x:row>/<x:c> with inline strings. Match both, or
    // real exports parse to zero rows (#321).
    const body = xml.replace(/^[\s\S]*?<(?:\w+:)?sheetData\b[^>]*>/, '').replace(/<\/(?:\w+:)?sheetData>[\s\S]*$/, '');
    const rowRe = /<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>|<(?:\w+:)?row\b[^>]*\/>/g;
    const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    const vRe = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/;
    const isRe = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
    let rm;
    while ((rm = rowRe.exec(body)) !== null) {
      const rowBody = rm[1] || '';
      const cells = [];
      let cm;
      cellRe.lastIndex = 0;
      while ((cm = cellRe.exec(rowBody)) !== null) {
        const attrs = cm[1] || '';
        const inner = cm[2] || '';
        const refMatch = /r="([A-Z]+)\d+"/.exec(attrs);
        const idx = refMatch ? colToIndex(refMatch[1]) : cells.length;
        const typeMatch = /t="([^"]+)"/.exec(attrs);
        const type = typeMatch ? typeMatch[1] : null;
        let value = '';
        if (type === 's') {
          const v = vRe.exec(inner);
          if (v) { const si = parseInt(v[1], 10); value = (si >= 0 && si < shared.length) ? shared[si] : ''; }
        } else if (type === 'inlineStr') {
          let t; isRe.lastIndex = 0;
          while ((t = isRe.exec(inner)) !== null) value += decodeEntities(t[1] || '');
        } else { // n / b / str / e / default: literal <v>
          const v = vRe.exec(inner);
          if (v) value = decodeEntities(v[1] || '');
        }
        while (cells.length < idx) cells.push('');
        cells[idx] = String(value).trim();
      }
      if (cells.some(function (f) { return f !== ''; })) rows.push(cells);
    }
    return rows;
  }

  // Public: bytes (ArrayBuffer/Uint8Array of an .xlsx) -> Promise<rows>.
  function parseXlsx(bytes) {
    return Promise.resolve().then(function () {
      const u8 = toU8(bytes);
      if (!(u8[0] === 0x50 && u8[1] === 0x4b)) { // "PK"
        throw new Error('xlsx: not an .xlsx file (missing ZIP signature) — if this is an old .xls, re-save it as .xlsx or .csv');
      }
      const zip = readZipEntries(u8);
      // First worksheet is conventionally sheet1.xml; fall back to the first
      // xl/worksheets/*.xml entry if the exporter named it differently.
      let sheetName = 'xl/worksheets/sheet1.xml';
      if (!zip.entries[sheetName]) {
        sheetName = Object.keys(zip.entries).find(function (k) {
          return /^xl\/worksheets\/[^/]+\.xml$/.test(k);
        }) || sheetName;
      }
      return Promise.all([
        readEntryText(u8, zip, 'xl/sharedStrings.xml'),
        readEntryText(u8, zip, sheetName)
      ]).then(function (parts) {
        const shared = parseSharedStrings(parts[0]);
        return parseSheet(parts[1], shared);
      });
    });
  }

  return { parseXlsx: parseXlsx, _internals: { parseSharedStrings: parseSharedStrings, parseSheet: parseSheet, colToIndex: colToIndex, decodeEntities: decodeEntities } };
});
