'use strict';

// Shared IBNO rule engine for the Station 849 IBNO Coder.
//
// Dual-loadable with no build step:
// - Browser: window.IbnoRules and legacy globals used by ibno-coder.html
// - Node: require('./lib/ibno-rules')
//
// CSV parsing is single-sourced in lib/csv.js. This module obtains parseCSV
// from that module/global and does not redeclare a parser.
//
// SHAPE (architecture review candidate 1 — classify/project split): the coding rulebook lives
// in decideCode(fields, dayType) — one pure decision per package, returned as
// { disposition: 'auto' | 'manual' | 'skip', code?, category, reason? }. The
// display row is assembled once in buildRow(fields, decision); the 12 shared
// row fields are built a single time in baseRow(). processRows is a dumb loop:
// read a row's fields, decideCode, and (unless skipped) buildRow into the right
// list. Rule PRIORITY ORDER inside decideCode is load-bearing — each package
// takes the first matching rule and stops — so the order must not change.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.IbnoRules = api;
    root.isWorkAreaFlagged = api.isWorkAreaFlagged;
    root.is12Digits = api.is12Digits;
    root.has849 = api.has849;
    root.getDayType = api.getDayType;
    root.processRows = api.processRows;
    root.detectRecurring = api.detectRecurring;
    root.pruneHistory = api.pruneHistory;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  function resolveParseCSV() {
    if (root && root.CsvLib && typeof root.CsvLib.parseCSV === 'function') return root.CsvLib.parseCSV;
    if (root && typeof root.parseCSV === 'function') return root.parseCSV;
    if (typeof require === 'function') return require('./csv').parseCSV;
    return null;
  }

  function resolveColumnGetter() {
    if (root && root.CsvLib && typeof root.CsvLib.columnGetter === 'function') return root.CsvLib.columnGetter;
    if (root && typeof root.columnGetter === 'function') return root.columnGetter;
    if (typeof require === 'function') return require('./csv').columnGetter;
    return null;
  }

  // Shared "Inbound and Van Scans" field reader (issue #297 / ADR-0012): the
  // narrow trk#/label-address/work-area field set is read via
  // lib/inbound-scans.js's readScanFields so this module and the Address
  // Catcher can never drift on what those five columns mean. Optional at
  // resolve time (mirrors the other lib resolvers here) so a page that hasn't
  // loaded inbound-scans.js yet doesn't hard-crash; readFields falls back to
  // reading the columns directly in that case (matches the pre-extraction
  // behavior exactly).
  function resolveInboundScans() {
    if (root && root.InboundScans) return root.InboundScans;
    if (typeof require === 'function') {
      try { return require('./inbound-scans'); } catch (e) { return null; }
    }
    return null;
  }

  const parseCSV = resolveParseCSV();
  const columnGetter = resolveColumnGetter();
  const InboundScans = resolveInboundScans();
  const DEFAULT_FLAGGED_WORK_AREAS = ['103','2299','302','3399','403','300','400','500','600','999'];
  const HISTORY_KEY  = 'ibno_ibno_history';
  const HISTORY_DAYS = 30;
  let flaggedWorkAreas = DEFAULT_FLAGGED_WORK_AREAS.slice();

  function setFlaggedWorkAreas(areas) {
    flaggedWorkAreas = (Array.isArray(areas) ? areas : DEFAULT_FLAGGED_WORK_AREAS)
      .map(function (area) { return String(area).trim(); })
      .filter(function (area) { return area.length > 0; });
    return flaggedWorkAreas.slice();
  }

  function getFlaggedWorkAreas() {
    return flaggedWorkAreas.slice();
  }

  function isWorkAreaFlagged(ibWork) {
    if (!ibWork) return false;
    // A "CLOSED - NNN" value is a Closure Portal designation, NOT a sort work
    // area — its trailing number must not be matched against the flagged
    // work-area list. Flagged "500" was matching "CLOSED - 500" via the \b
    // regex and wrongly pulling Closure Portal packages to manual review, while
    // "CLOSED - 200" (not flagged) auto-coded — same package type, split only by
    // the number. Closure Portal is handled by its own rule. (Tyler, 2026-06-10)
    if (/^\s*CLOSED\b/i.test(ibWork)) return false;
    return flaggedWorkAreas.some(function (area) {
      return new RegExp('\\b' + area + '\\b').test(ibWork);
    });
  }

  // Some report exports ("Inbound and Van Scans - Full Detail by Date") prepend
  // a title/compliance block ABOVE the real CSV header. The two columns below
  // appear in every IBNO-compatible export and never in a preamble line, so the
  // first row containing BOTH is the real header. findHeaderIndex returns that
  // row's index; callers slice the preamble off before building the column map.
  // No match (e.g. a malformed file) -> 0, preserving the legacy rows[0] header.
  const HEADER_SIGNATURE = ['PKG_LABEL_XREF', 'INBOUND_DATE'];

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

  // ── Ready-to-Enter (auto-coded) view filter ─────────────────────────────────
  // The auto table can run to hundreds of rows. Filter chips let the user slice
  // the VIEW by code and/or category. These helpers are pure and view-only: they
  // describe the facets and test membership; exports still read the full model,
  // so filtering never changes what gets entered into the system.

  // autoFilterFacets(items) -> { codes: [{value,count}], categories: [{value,count}] }.
  // Codes sorted numerically; categories kept in first-seen order. Blank codes /
  // categories and falsy items are ignored.
  function autoFilterFacets(items) {
    const codeCounts = new Map();
    const catCounts = new Map();
    (Array.isArray(items) ? items : []).forEach(function (it) {
      if (!it) return;
      if (it.code) codeCounts.set(it.code, (codeCounts.get(it.code) || 0) + 1);
      if (it.category) catCounts.set(it.category, (catCounts.get(it.category) || 0) + 1);
    });
    const codes = Array.from(codeCounts.keys())
      .sort(function (a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true }); })
      .map(function (v) { return { value: v, count: codeCounts.get(v) }; });
    const categories = Array.from(catCounts.keys())
      .map(function (v) { return { value: v, count: catCounts.get(v) }; });
    return { codes: codes, categories: categories };
  }

  // autoItemMatchesFilter(item, active) -> bool.
  //   active = { codes: [], categories: [] }.
  // Empty/absent code/category group = no constraint (all pass). Within a group
  // selections are OR'd; the two groups are AND'd. A falsy item never matches.
  // This drives ONLY the on-screen VIEW — the export / entry path reads the full
  // model (records domain).
  function autoItemMatchesFilter(item, active) {
    if (!item) return false;
    active = active || {};
    const codes = active.codes || [];
    const cats = active.categories || [];
    const codeOk = codes.length === 0 || codes.indexOf(item.code) !== -1;
    const catOk = cats.length === 0 || cats.indexOf(item.category) !== -1;
    return codeOk && catOk;
  }

  // Label must be exactly 12 numeric digits, nothing else
  function is12Digits(label) {
    return /^\d{12}$/.test(label);
  }

  // IB_DEST_IORG_NBR must match station "849" or alt code "3849" as whole tokens
  function has849(ibDest) {
    return ibDest && /\b(849|3849)\b/.test(ibDest);
  }

  // Normalize an INBOUND_DATE cell to ISO YYYY-MM-DD. Reports come in two
  // formats: ISO ("Manual Assignment Detail at IB Scan") and US M/D/YYYY
  // ("Inbound and Van Scans - Full Detail by Date"), either optionally followed
  // by a time. Everything downstream (day-typing, the 30-day recurrence prune,
  // lexical date compares) assumes ISO, so normalize at the boundary. An
  // unrecognized value returns '' so callers can fall back deliberately.
  function toIsoDate(dateStr) {
    if (!dateStr) return '';
    const s = String(dateStr).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);            // ISO (optional time)
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);          // US M/D/YYYY (optional time)
    if (m) {
      const mm = m[1].length === 1 ? '0' + m[1] : m[1];
      const dd = m[2].length === 1 ? '0' + m[2] : m[2];
      return m[3] + '-' + mm + '-' + dd;
    }
    return '';
  }

  // Determine weekend vs weekday from the INBOUND_DATE field of the report.
  // Parses ISO and US date formats (toIsoDate); an unparseable / missing date
  // falls back to today so the tool still produces a result.
  function getDayType(dateStr) {
    const iso = toIsoDate(dateStr);
    let d = iso ? new Date(iso + 'T00:00:00') : null;
    if (!d || isNaN(d)) d = new Date();
    const day = d.getDay(); // 0=Sun, 6=Sat
    return (day === 0 || day === 6) ? 'weekend' : 'weekday';
  }

  // readFields(row, get) -> the package's fields as a flat object. `get` is a
  // header-indexed accessor (built once per report from the column map). The
  // composed `address` is assembled here so decideCode and buildRow share one
  // definition instead of each rebuilding it.
  //
  // The trk# / label-address / work-area subset (PKG_LABEL_XREF,
  // LABEL_ADDRESS1, LABEL_CITY, LABEL_STATE, POSTAL_CODE, IB_WORK_AREA) is
  // read via the shared lib/inbound-scans.js's readScanFields (#297 /
  // ADR-0012) instead of directly here, so this module and the Address
  // Catcher read those columns identically. LABEL_ADDRESS2 is not part of the
  // shared subset (the Address Catcher's address join deliberately skips it —
  // see lib/inbound-scans.js), so it is still read directly here.
  function readFields(row, get) {
    const scan = InboundScans ? InboundScans.readScanFields(row, get) : {
      trackingId: get(row, 'PKG_LABEL_XREF'),
      labelAddress1: get(row, 'LABEL_ADDRESS1'),
      labelCity: get(row, 'LABEL_CITY'),
      labelState: get(row, 'LABEL_STATE'),
      postalCode: get(row, 'POSTAL_CODE'),
      ibWorkArea: get(row, 'IB_WORK_AREA'),
    };
    // Full scan barcode for the copy-mode toggle (#copy-mode). SCAN_BARCODE is the
    // ~34-char barcode that ENDS with the 12-digit tracking (PKG_LABEL_XREF);
    // VAN_SCAN_BARCODE is the van-scan equivalent. Fall back through the van barcode
    // to the 12-digit tracking so a barcode-mode copy is NEVER empty. (IB_BARCODE_SCANNED
    // is just '1D' — a scan-type flag, NOT the barcode — so it is deliberately unused.)
    const scanBarcode = [get(row, 'SCAN_BARCODE'), get(row, 'VAN_SCAN_BARCODE'), scan.trackingId]
      .map(function (v) { return String(v == null ? '' : v).trim(); })
      .find(function (v) { return v !== ''; }) || '';
    const addr2 = get(row, 'LABEL_ADDRESS2');
    const address = [scan.labelAddress1, addr2].filter(Boolean).join(' ') +
                    (scan.labelCity  ? ', ' + scan.labelCity  : '') +
                    (scan.labelState ? ', ' + scan.labelState : '') +
                    (scan.postalCode ? ' '  + scan.postalCode : '');
    return {
      pla:        get(row, 'PLA_LOOKUP'),
      belt:       get(row, 'BELT'),
      vanArea:    get(row, 'VAN_WORK_AREA'),
      status:     get(row, 'STATUS_CODES1'),
      deliveryOutcome: get(row, 'DELIVERY_OUTCOME1'),
      ibScanTime: get(row, 'IB_SCAN_TIME'),
      inboundDateRaw: get(row, 'INBOUND_DATE'), // as-printed, for display fallback when toIsoDate can't normalize
      label:      scan.trackingId,
      inboundDate: toIsoDate(get(row, 'INBOUND_DATE')), // normalize US/ISO -> ISO

      ibDest:     get(row, 'IB_DEST_IORG_NBR'),
      ibWork:     scan.ibWorkArea,
      scanBarcode: scanBarcode,           // full barcode for the copy-mode toggle (falls back to tracking)
      firm:       get(row, 'LABEL_FIRM_NAME'),
      issueType:  get(row, 'ISSUE_TYPE'),
      sortSid:    get(row, 'SORT_SID'),
      ibScanName: get(row, 'IB_SCAN_NAME'),
      vanTime:    get(row, 'VAN_SCAN_TIME1'),
      vanName:    get(row, 'VAN_SCAN_NAME1'),
      weight:     get(row, 'PKG_WEIGHT'),
      express:    get(row, 'EXPRESS_TRACK'),
      address:    address,
    };
  }

  // decideCode(fields, dayType) -> the coding decision for ONE package. Pure
  // given the currently configured flagged work areas. Returns:
  //   { disposition: 'skip' }                                  — not coded, not surfaced
  //   { disposition: 'auto',   code, category }                — Auto-code
  //   { disposition: 'manual', category, reason }              — Manual Review
  // The rules are a strict priority cascade: the FIRST match wins. This order is
  // the same one the loop used to run inline; do not reorder it.
  //
  // Public wrapper: a DELIVERED package needs no MANUAL review (Tyler's audit:
  // "if they're delivered they don't need to be reviewed") — but if it
  // AUTO-codes (e.g. Closure Portal → 59), still code it and surface it in Ready
  // to Enter. Delivered only suppresses review, never auto-coding. (Refined
  // 2026-06-10 after delivered Closure Portal packages went missing entirely
  // when the delivered check sat at the top of the cascade and skipped autos too.)
  function decideCode(fields, dayType) {
    const decision = decideCodeInner(fields, dayType);
    if (decision.disposition === 'manual' && fields.deliveryOutcome === 'Delivered') {
      return { disposition: 'skip' };
    }
    return decision;
  }

  function decideCodeInner(fields, dayType) {
    const pla     = fields.pla;
    const belt    = fields.belt;
    const vanArea = fields.vanArea;
    const status  = fields.status;
    const label   = fields.label;
    const ibDest  = fields.ibDest;
    const ibWork  = fields.ibWork;

    const isHoldToMatch = pla === 'Hold to Match - 1' || pla === 'Hold to Match - 2';
    const isMisload     = pla === 'Misload';
    const isClosure     = pla === 'Closure Portal';
    const isUnassigned  = pla === 'Unassigned Zip';
    const isSWAK        = pla === 'Preload SWAK';
    const inPlaCategory = isHoldToMatch || isMisload || isClosure || isUnassigned || isSWAK;

    // Skip if already has a QA scan code applied.
    if (status !== '') return { disposition: 'skip' };
    // Skip if already scanned to a van.
    if (vanArea !== '') return { disposition: 'skip' };

    // 9908 weekend — code 11 unless work area is flagged.
    if (ibWork === '9908' && dayType === 'weekend') {
      if (isWorkAreaFlagged(ibWork)) {
        return { disposition: 'manual', category: '9908 Work Area', reason: 'Work area: ' + ibWork };
      }
      return { disposition: 'auto', code: '11', category: '9908 Work Area' };
    }

    // 9908 weekday — route to manual for review.
    if (ibWork === '9908' && dayType === 'weekday') {
      return { disposition: 'manual', category: '9908 Work Area', reason: '9908 — weekday, needs review' };
    }

    // Flagged work area catch-all — manual regardless of PLA or belt.
    if (isWorkAreaFlagged(ibWork) && !inPlaCategory) {
      return { disposition: 'manual', category: pla || '—', reason: 'Work area: ' + ibWork };
    }

    // Rows not in any known PLA category — only surface if on QA belt.
    if (!inPlaCategory) {
      if (pla !== '' && belt === 'QA') {
        return { disposition: 'manual', category: pla, reason: 'Unknown PLA: ' + pla };
      }
      return { disposition: 'skip' };
    }

    // Belt filter: Hold to Match bypasses; all others must be BELT = QA.
    if (!isHoldToMatch && belt !== 'QA') {
      return { disposition: 'manual', category: pla, reason: 'Belt not QA: ' + belt };
    }

    // Hold to Match 1 & 2 — always code 94. A Hold to Match goes to the Match
    // Trailer regardless of work area, so the flagged-area check is bypassed
    // the same way the belt=QA filter is (issue #511).
    if (isHoldToMatch) {
      return { disposition: 'auto', code: '94', category: pla };
    }

    // Work area flag applies to all remaining categories.
    const workFlagged = isWorkAreaFlagged(ibWork);

    // Misload — 65 if 12-digit label; otherwise flag.
    if (isMisload) {
      const flags = [];
      if (workFlagged)        flags.push('Work area: ' + ibWork);
      if (!is12Digits(label)) flags.push('Label not 12 digits');
      if (flags.length > 0) {
        return { disposition: 'manual', category: pla, reason: flags.join(' | ') };
      }
      return { disposition: 'auto', code: '65', category: pla };
    }

    // Closure Portal — 11 weekend / 59 weekday (default assume 1-day).
    if (isClosure) {
      if (workFlagged) {
        return { disposition: 'manual', category: pla, reason: 'Work area: ' + ibWork };
      }
      return { disposition: 'auto', code: dayType === 'weekend' ? '11' : '59', category: pla };
    }

    // Unassigned Zip / Preload SWAK — 65 if 12-digit label & no 849.
    if (isUnassigned || isSWAK) {
      const flags = [];
      if (workFlagged)        flags.push('Work area: ' + ibWork);
      if (!is12Digits(label)) flags.push('Label not 12 digits');
      if (has849(ibDest))     flags.push('IB_DEST has 849/3849');
      if (flags.length > 0) {
        return { disposition: 'manual', category: pla, reason: flags.join(' | ') };
      }
      return { disposition: 'auto', code: '65', category: pla };
    }

    // Unreachable in practice (inPlaCategory implies one of the above), but a
    // package with no matching rule is simply not surfaced.
    return { disposition: 'skip' };
  }

  // baseRow(fields, category) -> the 12 row fields shared by Auto-code and
  // Manual Review rows. Built ONCE here instead of being respelled at every rule.
  function baseRow(fields, category) {
    return {
      label:      fields.label,
      category:   category,
      inboundDate: fields.inboundDate || fields.inboundDateRaw, // ISO when parseable, else as-printed
      ibScanTime: fields.ibScanTime,
      firm:       fields.firm,
      address:    fields.address,
      express:    fields.express,
      issueType:  fields.issueType,
      sortSid:    fields.sortSid,
      ibScanName: fields.ibScanName,
      vanTime:    fields.vanTime,
      vanWork:    fields.vanArea,
      vanName:    fields.vanName,
      weight:     fields.weight,
      scanBarcode: fields.scanBarcode, // full barcode, so the copy-mode toggle can copy it per row
    };
  }

  // buildRow(fields, decision) -> the display row for an auto or manual package.
  // Exact divergent shapes preserved: auto rows carry `code`; manual rows carry
  // `ibWork`, `ibDest`, and `reason`. Never called for a 'skip' decision.
  function buildRow(fields, decision) {
    const row = baseRow(fields, decision.category);
    if (decision.disposition === 'auto') {
      row.code = decision.code;
    } else {
      row.ibWork = fields.ibWork;
      row.ibDest = fields.ibDest;
      row.reason = decision.reason;
    }
    return row;
  }

  function processRows(rows) {
    // Strip any preamble block so rows[0] is the real header (see findHeaderIndex).
    const start = findHeaderIndex(rows);
    if (start > 0) rows = rows.slice(start);
    if (rows.length < 2) return { auto: [], manual: [], dayType: 'weekday' };

    const get = columnGetter(rows[0]);

    // Detect weekend/weekday from first data row.
    const firstDate = rows.length > 1 ? get(rows[1], 'INBOUND_DATE') : '';
    const dayType = getDayType(firstDate);

    const auto = [];
    const manual = [];

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.length < 10) continue; // structural guard — unreadable row

      const fields = readFields(row, get);
      const decision = decideCode(fields, dayType);
      if (decision.disposition === 'skip') continue;
      if (decision.disposition === 'auto') auto.push(buildRow(fields, decision));
      else manual.push(buildRow(fields, decision));
    }

    return { auto, manual, dayType };
  }

  // Repeat History entry shape (ADR-0007): { dates: [...], category }. A legacy
  // bare-array entry (pre-ADR-0007) reads as an unknown-category record, so old
  // stored history keeps working with no migration step.
  // `detail` (#287) is an OPTIONAL device-local enrichment (firm/address/area/
  // scan time/last date) for the Repeat History viewer. It is preserved through
  // normalize/prune but is NEVER part of the cross-device sync payload — see
  // historyForSync. Recurrence (dates/category) is unaffected by its presence.
  function normalizeEntry(entry) {
    if (Array.isArray(entry)) return { dates: entry.slice(), category: '' };
    if (entry && Array.isArray(entry.dates)) {
      const out = { dates: entry.dates.slice(), category: entry.category || '' };
      if (entry.detail) out.detail = entry.detail;
      return out;
    }
    return { dates: [], category: '' };
  }

  // Local YYYY-MM-DD `days` before `today` — the lower bound of the window.
  function cutoffStr(days, today) {
    const c = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    c.setDate(c.getDate() - days);
    return c.toISOString().slice(0, 10);
  }

  // Drop inbound dates older than `days` before `today`; drop tracking numbers
  // left with no dates; preserve each entry's category. Pure - returns a new
  // object in the { dates, category } shape.
  function pruneHistory(history, days = HISTORY_DAYS, today = new Date()) {
    const cutoff = cutoffStr(days, today);
    const pruned = {};
    for (const label in history) {
      const norm = normalizeEntry(history[label]);
      const kept = norm.dates.filter(function (d) { return d >= cutoff; });
      if (kept.length > 0) {
        pruned[label] = { dates: kept, category: norm.category };
        if (norm.detail) pruned[label].detail = norm.detail;
      }
    }
    return pruned;
  }

  // Project the history map to the cross-device sync shape: { dates, category }
  // ONLY. Strips the device-local `detail` so recipient/address never leave the
  // device (#287 privacy guard). Pure; returns a fresh map.
  function historyForSync(history) {
    const out = {};
    for (const label in history) {
      const norm = normalizeEntry(history[label]);
      out[label] = { dates: norm.dates, category: norm.category };
    }
    return out;
  }

  // After a sync merge (which carries only dates/category), copy each label's
  // device-local `detail` back from the pre-merge local map, for labels still
  // present in the merged result. Keeps detail durable across sync round-trips.
  function reattachDetail(merged, local) {
    const out = {};
    const loc = local || {};
    for (const label in merged) {
      const norm = normalizeEntry(merged[label]);
      out[label] = { dates: norm.dates, category: norm.category };
      const localNorm = loc[label] ? normalizeEntry(loc[label]) : null;
      const detail = (norm.detail) || (localNorm && localNorm.detail);
      if (detail) out[label].detail = detail;
    }
    return out;
  }

  // historyRows(history, windowDays, refDate) -> viewer rows for the Repeat
  // History panel (#166). One row per tracking number with at least one inbound
  // date inside the window: { tracking, dates, category, timesSeen, lastSeen }.
  // Returns ALL tracked numbers (so search spans single-appearance ones too);
  // the caller filters the browse list to timesSeen >= 2 (Recurring IBNOs).
  // Sorted worst-first (most inbound dates, then most recent).
  function historyRows(history, windowDays, refDate) {
    const today = refDate ? new Date(refDate) : new Date();
    const cutoff = cutoffStr(windowDays == null ? HISTORY_DAYS : windowDays, today);
    const rows = [];
    for (const label in history) {
      const norm = normalizeEntry(history[label]);
      const inWin = norm.dates.filter(function (d) { return d >= cutoff; }).sort();
      if (inWin.length === 0) continue;
      rows.push({
        tracking: label,
        dates: inWin,
        category: norm.category,
        timesSeen: inWin.length,
        lastSeen: inWin[inWin.length - 1],
        detail: norm.detail || null,
      });
    }
    rows.sort(function (a, b) {
      if (b.timesSeen !== a.timesSeen) return b.timesSeen - a.timesSeen;
      return a.lastSeen < b.lastSeen ? 1 : (a.lastSeen > b.lastSeen ? -1 : 0);
    });
    return rows;
  }

  // Pure: roll up Recurring IBNOs by work area — the "Repeat Hotspot" view
  // (#306, ADR-0013). `rows` is historyRows output the caller has already
  // filtered to Recurring IBNOs (timesSeen >= 2). Groups by the package's
  // device-local `detail.ibWork`; rows with no captured area fall under a single
  // "Unknown area" bucket rather than being dropped. Returns
  // [{ area, count, packages: [row...] }] ranked worst-first by package count,
  // ties broken by area name so the order is stable. This is decision support —
  // it points attention at the area that keeps generating repeats; it does not
  // attribute fault (that needs the coded report's In-Area 12 signal, #322).
  var UNKNOWN_AREA = 'Unknown area';
  function repeatHotspots(rows) {
    if (!Array.isArray(rows)) return [];
    const byArea = {};
    for (const row of rows) {
      if (!row) continue;
      const area = (row.detail && row.detail.ibWork) ? String(row.detail.ibWork) : UNKNOWN_AREA;
      if (!byArea[area]) byArea[area] = [];
      byArea[area].push(row);
    }
    const out = Object.keys(byArea).map(function (area) {
      return { area: area, count: byArea[area].length, packages: byArea[area] };
    });
    out.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return a.area < b.area ? -1 : (a.area > b.area ? 1 : 0);
    });
    return out;
  }

  // Pure: given parsed rows and existing history, returns the recurring map for
  // this report plus the updated history to persist. A sighting is recorded for
  // every row that has NOT been delivered (no van scan). Coded rows (a
  // STATUS_CODES1 value) ARE recorded: "times seen" counts distinct sort days a
  // package is on the list, INCLUDING the day it was coded — otherwise a package
  // coded one day and back the next never accumulates 2 sightings and never
  // earns its x2 pill (issue #305; keyed on INBOUND_DATE = the report's sort
  // date, so reruns and re-uploaded old exports dedupe/date correctly).
  function detectRecurring(rows, history, today = new Date()) {
    const empty = { recurringMap: {}, updatedHistory: pruneHistory(history, HISTORY_DAYS, today) };
    // Strip any preamble block so rows[0] is the real header (see findHeaderIndex).
    const start = findHeaderIndex(rows);
    if (start > 0) rows = rows.slice(start);
    if (rows.length < 2) return empty;

    const get = columnGetter(rows[0]);

    // The 30-day retention window is also the detection window.
    const base = pruneHistory(history, HISTORY_DAYS, today);

    // seen: label -> { set: Set(dates), category }. Category is carried from
    // history and refreshed from today's row so the persisted record keeps it.
    const seen = {};
    for (const label in base) seen[label] = { set: new Set(base[label].dates), category: base[label].category };

    const todays = {};
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.length < 10) continue;
      const fields = readFields(row, get);
      if (fields.vanArea !== '') continue; // delivered — left the building, not a recurrence
      if (!fields.label || !fields.inboundDate) continue;

      if (!seen[fields.label]) seen[fields.label] = { set: new Set(), category: '' };
      seen[fields.label].set.add(fields.inboundDate);
      if (fields.pla) seen[fields.label].category = fields.pla; // latest known category

      if (!todays[fields.label]) {
        todays[fields.label] = {
          category: fields.pla,
          firm:     fields.firm,
          address:  fields.address,
          // Device-local detail for the Repeat History viewer (#287). Latest
          // seen wins (first row per label in this report). NOT synced.
          detail: {
            firm:     fields.firm,
            address:  fields.address,
            ibWork:   fields.ibWork,
            category: fields.pla,
            scanTime: fields.ibScanTime,
            lastDate: fields.inboundDate,
          },
        };
      }
    }

    const recurringMap = {};
    for (const label in todays) {
      const dates = [...seen[label].set].sort();
      if (dates.length >= 2) {
        recurringMap[label] = {
          inboundDates: dates,
          timesSeen: dates.length,
          category: todays[label].category,
          firm: todays[label].firm,
          address: todays[label].address,
        };
      }
    }

    const merged = {};
    for (const label in seen) {
      merged[label] = { dates: [...seen[label].set].sort(), category: seen[label].category };
      // Attach detail: fresh from today's row if seen today, else carry the
      // prior device-local detail from history (so it persists across days).
      if (todays[label]) merged[label].detail = todays[label].detail;
      else if (base[label] && base[label].detail) merged[label].detail = base[label].detail;
    }

    return { recurringMap, updatedHistory: pruneHistory(merged, HISTORY_DAYS, today) };
  }

  return {
    parseCSV: parseCSV,
    DEFAULT_FLAGGED_WORK_AREAS: DEFAULT_FLAGGED_WORK_AREAS,
    HISTORY_KEY: HISTORY_KEY,
    HISTORY_DAYS: HISTORY_DAYS,
    getFlaggedWorkAreas: getFlaggedWorkAreas,
    setFlaggedWorkAreas: setFlaggedWorkAreas,
    isWorkAreaFlagged: isWorkAreaFlagged,
    is12Digits: is12Digits,
    has849: has849,
    getDayType: getDayType,
    toIsoDate: toIsoDate,
    findHeaderIndex: findHeaderIndex,
    autoFilterFacets: autoFilterFacets,
    autoItemMatchesFilter: autoItemMatchesFilter,
    readFields: readFields,
    decideCode: decideCode,
    processRows: processRows,
    detectRecurring: detectRecurring,
    pruneHistory: pruneHistory,
    historyForSync: historyForSync,
    reattachDetail: reattachDetail,
    historyRows: historyRows,
    repeatHotspots: repeatHotspots,
  };
});
