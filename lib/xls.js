'use strict';

// Minimal, zero-dependency reader for the legacy binary .xls format (an OLE2
// compound file holding a BIFF8 "Workbook" stream). Built for the FedEx
// "Time Off / Submitted Requests Detail" export, which only comes as .xls.
//
// Dual-loadable with no build step:
// - Browser: window.XlsLib.parseXls   (only pages that load this file)
// - Node:    require('./lib/xls').parseXls   (for tests)
//
// parseXls(bytes) -> string[][], synchronously. Same shape XlsxLib.parseXlsx
// resolves to: one array per row, one trimmed string per cell, '' for an
// interior empty cell, fully blank rows dropped, numbers rendered by String()
// (8, not 8.0). Rows end at their last non-empty cell.
//
// Scope, settled by parsing the real export (see PR #1128):
// - OLE2 version 3 or 4, stream in the regular FAT or the mini stream, FAT
//   sectors listed in the header or a DIFAT chain.
// - BIFF8 only. The first worksheet only.
// - Cells: LABEL and LABELSST strings (shared string table including CONTINUE
//   records, compressed or UTF-16, rich text and phonetic blocks skipped),
//   NUMBER, RK and MULRK numbers, BOOLERR. BLANK and MULBLANK carry no value.
// - No formulas, no styles, no dates (a date cell reads as its serial number).
//
// Anything it cannot read fully throws an Error whose message starts "xls:".
// It never returns a partial table.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.XlsLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const ENDOFCHAIN = 0xFFFFFFFE;
  const FREESECT = 0xFFFFFFFF;
  const MAXREGSECT = 0xFFFFFFFA;

  function fail(msg) { throw new Error('xls: ' + msg); }

  function toU8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (typeof ArrayBuffer !== 'undefined' && bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (bytes && bytes.buffer instanceof ArrayBuffer) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    fail('expected an ArrayBuffer or Uint8Array');
  }

  function u16(b, p) { return b[p] | (b[p + 1] << 8); }
  function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }

  // --- OLE2 compound file ---------------------------------------------------

  const SIGNATURE = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

  function readCompoundStream(u8) {
    if (u8.length < 512) fail('not a legacy .xls file (too short)');
    for (let i = 0; i < 8; i++) if (u8[i] !== SIGNATURE[i]) fail('not a legacy .xls file (no OLE2 signature)');
    const shift = u16(u8, 30);
    if (shift !== 9 && shift !== 12) fail('unsupported sector size');
    const secSize = 1 << shift;
    if (u16(u8, 32) !== 6) fail('unsupported mini sector size');
    const miniSize = 64;
    const numFat = u32(u8, 44);
    const dirStart = u32(u8, 48);
    const miniCutoff = u32(u8, 56);
    const miniFatStart = u32(u8, 60);
    const difatStart = u32(u8, 68);
    const numDifat = u32(u8, 72);
    const totalSecs = Math.floor((u8.length - secSize) / secSize) + 1; // upper bound for cycle checks

    // A FAT cannot list more sectors than the file holds; refuse before any loop.
    if (numFat > totalSecs || numDifat > totalSecs) fail('the file is damaged (its header lists more FAT sectors than the file holds)');

    function sectorOffset(s) {
      const off = (s + 1) * secSize;
      if (s >= MAXREGSECT || off + secSize > u8.length) fail('the file is truncated or damaged (sector ' + s + ' is missing)');
      return off;
    }

    // FAT sector list: 109 in the header, the rest down the DIFAT chain.
    const fatSecs = [];
    for (let i = 0; i < 109 && fatSecs.length < numFat; i++) fatSecs.push(u32(u8, 76 + i * 4));
    let d = difatStart, hops = 0;
    while (fatSecs.length < numFat) {
      if (d >= MAXREGSECT || hops++ > numDifat) fail('the file is damaged (short DIFAT chain)');
      const off = sectorOffset(d);
      const per = secSize / 4 - 1;
      for (let i = 0; i < per && fatSecs.length < numFat; i++) fatSecs.push(u32(u8, off + i * 4));
      d = u32(u8, off + per * 4);
    }
    const fat = [];
    for (const s of fatSecs) {
      const off = sectorOffset(s);
      for (let i = 0; i < secSize / 4; i++) fat.push(u32(u8, off + i * 4));
    }

    function chain(start, table, limit) {
      const out = [];
      let s = start;
      while (s !== ENDOFCHAIN) {
        if (s >= MAXREGSECT || s >= table.length) fail('the file is truncated or damaged (broken sector chain)');
        if (out.length > limit) fail('the file is damaged (sector chain loops)');
        out.push(s);
        s = table[s];
      }
      return out;
    }

    function readRegular(start, size) {
      const secs = chain(start, fat, Math.max(totalSecs, fat.length));
      const out = new Uint8Array(secs.length * secSize);
      secs.forEach(function (s, i) { const off = sectorOffset(s); out.set(u8.subarray(off, off + secSize), i * secSize); });
      if (size != null) {
        if (out.length < size) fail('the file is truncated (stream shorter than its stated size)');
        return out.subarray(0, size);
      }
      return out;
    }

    // Directory: a flat scan for the workbook stream is enough here.
    const dir = readRegular(dirStart, null);
    let root = null, book = null;
    for (let p = 0; p + 128 <= dir.length; p += 128) {
      const nameLen = u16(dir, p + 64);
      if (nameLen < 2 || nameLen > 64) continue;
      let name = '';
      for (let i = 0; i < nameLen - 2; i += 2) name += String.fromCharCode(u16(dir, p + i));
      const type = dir[p + 66];
      const entry = { name: name, type: type, start: u32(dir, p + 116), size: u32(dir, p + 120) };
      if (type === 5 && !root) root = entry;
      const up = name.toUpperCase();
      if (type === 2 && up === 'WORKBOOK') book = entry;
      else if (type === 2 && up === 'BOOK' && !book) book = entry;
    }
    if (!book) fail('no Workbook stream found (this is not an Excel workbook)');

    if (book.size >= miniCutoff) return readRegular(book.start, book.size);

    // Small stream: it lives in the mini stream, which is the root entry's data.
    if (!root) fail('the file is damaged (no root entry)');
    const miniStream = readRegular(root.start, root.size);
    const miniFatBytes = miniFatStart === ENDOFCHAIN ? new Uint8Array(0) : readRegular(miniFatStart, null);
    const miniFat = [];
    for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(u32(miniFatBytes, i));
    const secs = chain(book.start, miniFat, miniFat.length);
    const out = new Uint8Array(secs.length * miniSize);
    secs.forEach(function (s, i) {
      const off = s * miniSize;
      if (off + miniSize > miniStream.length) fail('the file is truncated (mini stream too short)');
      out.set(miniStream.subarray(off, off + miniSize), i * miniSize);
    });
    if (out.length < book.size) fail('the file is truncated (stream shorter than its stated size)');
    return out.subarray(0, book.size);
  }

  // --- BIFF8 records --------------------------------------------------------

  function records(s) {
    const out = [];
    let p = 0;
    while (p + 4 <= s.length) {
      const id = u16(s, p), len = u16(s, p + 2);
      if (p + 4 + len > s.length) fail('the file is truncated (a record runs past the end of the stream)');
      out.push({ id: id, pos: p, data: s.subarray(p + 4, p + 4 + len) });
      p += 4 + len;
    }
    return out;
  }

  function decodeChars(b, p, n, wide) {
    let t = '';
    if (wide) for (let i = 0; i < n; i++) t += String.fromCharCode(u16(b, p + i * 2));
    else for (let i = 0; i < n; i++) t += String.fromCharCode(b[p + i]);
    return t;
  }

  // Shared string table. segs = [SST body, CONTINUE body, ...]. A string's
  // characters may break across a CONTINUE; the new record then opens with a
  // fresh flag byte that can switch between compressed and UTF-16. Run and
  // phonetic blocks may also break, and carry no flag byte.
  function parseSst(segs) {
    let si = 0, p = 0;
    function need(n) {
      while (si < segs.length && p >= segs[si].length) { si++; p = 0; }
      if (si >= segs.length) fail('the shared string table is truncated');
      if (p + n > segs[si].length) fail('the shared string table is damaged (a field crosses a record)');
    }
    function rd8() { need(1); return segs[si][p++]; }
    function rd16() { need(2); const v = u16(segs[si], p); p += 2; return v; }
    function rd32() { need(4); const v = u32(segs[si], p); p += 4; return v; }
    function skip(n) {
      while (n > 0) {
        while (si < segs.length && p >= segs[si].length) { si++; p = 0; }
        if (si >= segs.length) fail('the shared string table is truncated');
        const k = Math.min(n, segs[si].length - p);
        p += k; n -= k;
      }
    }
    rd32(); // total references
    const unique = rd32();
    const out = [];
    for (let n = 0; n < unique; n++) {
      const cch = rd16();
      const flags = rd8();
      let wide = (flags & 1) === 1;
      const runs = (flags & 8) ? rd16() : 0;
      const ext = (flags & 4) ? rd32() : 0;
      let text = '', left = cch;
      while (left > 0) {
        if (si < segs.length && p >= segs[si].length) {
          si++; p = 0;
          if (si >= segs.length) fail('the shared string table is truncated');
          wide = (segs[si][p++] & 1) === 1; // fresh flag byte after a CONTINUE
        }
        if (si >= segs.length) fail('the shared string table is truncated');
        const room = segs[si].length - p;
        const take = Math.min(left, Math.floor(room / (wide ? 2 : 1)));
        if (take === 0) fail('the shared string table is damaged (a character crosses a record)');
        text += decodeChars(segs[si], p, take, wide);
        p += take * (wide ? 2 : 1);
        left -= take;
      }
      skip(runs * 4 + ext);
      out.push(text);
    }
    return out;
  }

  // RK: a compressed number. Bit 0 = divide by 100, bit 1 = 30-bit integer,
  // otherwise the top 30 bits of an IEEE double.
  function rkValue(v) {
    let n;
    if (v & 2) n = (v | 0) >> 2;
    else {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setUint32(0, 0, true);
      dv.setUint32(4, (v & 0xFFFFFFFC) >>> 0, true);
      n = dv.getFloat64(0, true);
    }
    return (v & 1) ? n / 100 : n;
  }

  function f64(b, p) {
    return new DataView(b.buffer, b.byteOffset + p, 8).getFloat64(0, true);
  }

  function num(n) {
    return Number.isFinite(n) ? String(n) : '';
  }

  const ERRORS = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0F: '#VALUE!', 0x17: '#REF!', 0x1D: '#NAME?', 0x24: '#NUM!', 0x2A: '#N/A' };

  function parseWorkbook(stream) {
    const recs = records(stream);
    if (!recs.length || recs[0].id !== 0x0809) fail('the Workbook stream does not start with a BOF record');
    const ver = u16(recs[0].data, 0);
    if (ver !== 0x0600) fail('only Excel 97-2003 (BIFF8) workbooks are supported');

    // Globals: up to the first EOF.
    let i = 1, sst = [];
    const sheets = [];
    for (; i < recs.length && recs[i].id !== 0x000A; i++) {
      const r = recs[i];
      if (r.id === 0x002F) fail('the workbook is password protected');
      if (r.id === 0x0085 && r.data.length >= 6) sheets.push({ pos: u32(r.data, 0), type: r.data[5] });
      if (r.id === 0x00FC) {
        const segs = [r.data];
        while (i + 1 < recs.length && recs[i + 1].id === 0x003C) segs.push(recs[++i].data);
        sst = parseSst(segs);
      }
    }
    if (i >= recs.length) fail('the file is truncated (workbook globals have no EOF)');

    // First worksheet: the first BOUNDSHEET of type worksheet, else the next
    // worksheet BOF in stream order.
    let start = -1;
    const ws = sheets.find(function (s) { return s.type === 0; });
    if (ws) start = recs.findIndex(function (r) { return r.pos === ws.pos && r.id === 0x0809; });
    if (start === -1) start = recs.findIndex(function (r, k) { return k > i && r.id === 0x0809 && u16(r.data, 2) === 0x0010; });
    if (start === -1) fail('no worksheet found');
    if (u16(recs[start].data, 2) !== 0x0010) fail('the first sheet is not a worksheet');

    const grid = [];
    function put(row, col, val) {
      if (col > 255) fail('a cell sits past column 255 (the file is damaged)');
      (grid[row] || (grid[row] = []))[col] = val;
    }
    let ended = false;
    for (let k = start + 1; k < recs.length; k++) {
      const r = recs[k], d = r.data;
      if (r.id === 0x000A) { ended = true; break; }
      if (r.id === 0x0809) fail('the worksheet is damaged (nested BOF)');
      switch (r.id) {
        case 0x00FD: { // LABELSST
          if (d.length < 10) fail('a LABELSST record is too short');
          const isst = u32(d, 6);
          if (isst >= sst.length) fail('a cell points past the shared string table');
          put(u16(d, 0), u16(d, 2), sst[isst]);
          break;
        }
        case 0x0204: { // LABEL
          if (d.length < 9) fail('a LABEL record is too short');
          const cch = u16(d, 6), wide = (d[8] & 1) === 1;
          if (9 + cch * (wide ? 2 : 1) > d.length) fail('a LABEL record is truncated');
          put(u16(d, 0), u16(d, 2), decodeChars(d, 9, cch, wide));
          break;
        }
        case 0x0203: // NUMBER
          if (d.length < 14) fail('a NUMBER record is too short');
          put(u16(d, 0), u16(d, 2), num(f64(d, 6)));
          break;
        case 0x027E: // RK
          if (d.length < 10) fail('an RK record is too short');
          put(u16(d, 0), u16(d, 2), num(rkValue(u32(d, 6))));
          break;
        case 0x00BD: { // MULRK
          if (d.length < 12 || (d.length - 6) % 6 !== 0) fail('a MULRK record is malformed');
          const row = u16(d, 0), first = u16(d, 2), n = (d.length - 6) / 6;
          for (let c = 0; c < n; c++) put(row, first + c, num(rkValue(u32(d, 4 + c * 6 + 2))));
          break;
        }
        case 0x0205: { // BOOLERR
          if (d.length < 8) fail('a BOOLERR record is too short');
          const v = d[6];
          put(u16(d, 0), u16(d, 2), d[7] ? (ERRORS[v] || '#ERR') : (v ? 'TRUE' : 'FALSE'));
          break;
        }
        case 0x0006: case 0x0406: // FORMULA
          fail('formula cells are not supported');
          break;
        case 0x00D6: // RSTRING (rich label, BIFF5 era)
          fail('rich text label cells are not supported');
          break;
        default: // BLANK, MULBLANK, formatting and everything else: no value
      }
    }
    if (!ended) fail('the file is truncated (the worksheet has no EOF)');

    const rows = [];
    for (let r = 0; r < grid.length; r++) {
      const src = grid[r];
      if (!src) continue;
      const cells = [];
      for (let c = 0; c < src.length; c++) cells.push(src[c] == null ? '' : String(src[c]).trim());
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (cells.length) rows.push(cells);
    }
    return rows;
  }

  function parseXls(bytes) {
    const u8 = toU8(bytes);
    return parseWorkbook(readCompoundStream(u8));
  }

  return { parseXls: parseXls, _internals: { readCompoundStream: readCompoundStream, parseSst: parseSst, rkValue: rkValue } };
});
