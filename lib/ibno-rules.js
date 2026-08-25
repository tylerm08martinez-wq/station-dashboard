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
  // 100, 200 and 998 appended 2026-08-23 (#791): all three appear on the real
  // daily Post Sort report and were not being routed to Manual Review.
  const DEFAULT_FLAGGED_WORK_AREAS = ['103','2299','302','3399','403','300','400','500','600','999','100','200','998'];
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
      postal:     scan.postalCode,   // raw POSTAL_CODE; the ZIP column and the ISP lookup read this, not the joined address
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

  // isExpress(value) -> true when EXPRESS_TRACK marks the package as Express.
  //
  // Station 849 became a 2.0 station, so Express is worked as a separate process
  // from Ground and the tool splits it into its own lane. Every export seen so
  // far emits only '' or 'Express', so a bare truthy check happens to work today
  // — but it would read 'N' or 'No' or '0' as EXPRESS and quietly route a whole
  // report's ground packages into the express lane. Match the positive value
  // explicitly instead, and treat an explicit negative as ground.
  const EXPRESS_NEGATIVES = ['', 'N', 'NO', 'FALSE', '0', 'GROUND', '-'];
  function isExpress(value) {
    if (value === true) return true;
    if (value === false || value == null) return false;
    const v = String(value).trim().toUpperCase();
    if (EXPRESS_NEGATIVES.indexOf(v) !== -1) return false;
    return v.indexOf('EXPRESS') !== -1;
  }

  // manualLane(row) -> which Needs-Manual-Review section a manual row belongs in:
  //   'ground'        — not express; the ground review section, unchanged
  //   'express'       — express AND Tyler's to work
  //   'express-other' — express, surfaced for review but not his queue
  //
  // Express review is Tyler's own worked list. Three things put an express row
  // in it, and they are all about whether HE acts on the package:
  //   1. it landed in a flagged work area — those are the areas he owns
  //   2. it is an Unassigned Zip — he works every one of those regardless of
  //      where it sorted, because the fix is the same and it is his (2026-08-06)
  //   3. it is an area-grouped category (QA-Intercept / Invalid HazMat) — he
  //      works these himself too, which is the whole reason #602 groups them
  //      into the flagged-area BUCKET (#616, Tyler 2026-08-11)
  // Everything else express (a Priority Overnight that sorted cleanly outside
  // his areas) is still worth surfacing, but it is not his queue, and mixing the
  // two made the section read as a longer list of his work than it was.
  //
  // Rule 3 exists because the lane and the bucket have to agree. Before #616 the
  // lane ignored the category, so an express intercept on an unflagged area
  // landed in "not mine to work" and was THEN grouped under a "Flagged work
  // area" heading inside it — two contradictory labels on one row, on the two
  // categories where being missed matters most. #611 wants that lane hidden by
  // default, which would have made hazmat exceptions invisible.
  //
  // Note what this is NOT keyed on: the reason text. A Priority Overnight IN a
  // flagged area stays in his lane on the strength of the area, not the PLA.
  // Rules 2 and 3 read the CATEGORY, the same field the 65 bucket and the
  // grouping rule read, so the lane and the bucket can never disagree.
  //
  // This is a display split only. Both lanes hold real Manual Review rows with
  // the same columns, the same bucket codes and the same coding controls —
  // nothing is hidden, downgraded, or auto-coded by landing in either one. In
  // particular, rule 3 must never be read as making these codeable: they still
  // carry no suggested code and are still excluded from the bucket's "Apply 33"
  // sweep, which the tool gates on the row's own eligibility (see #604).
  const UNASSIGNED_ZIP = 'Unassigned Zip';
  function manualLane(row) {
    if (!isExpress(row && row.express)) return 'ground';
    if (isWorkAreaFlagged(row && row.ibWork)) return 'express';
    if (row && row.category === UNASSIGNED_ZIP) return 'express';
    if (groupsWithFlaggedArea(row && row.category)) return 'express';
    return 'express-other';
  }

  // Categories that are WORKED alongside flagged-work-area packages and so are
  // grouped into that bucket in Needs Manual Review, even though they sit on an
  // unflagged work area and reach review via the unknown-PLA rule.
  //
  // Grouping ONLY. These carry no suggested code and must never be swept by the
  // bucket's "Apply 33 to N checked" button: 33 is the flagged-work-area code
  // and is not known to be right for an intercept or a hazmat exception. Tyler
  // chose grouping-without-the-code deliberately (2026-08-06) so the two can be
  // worked together without a bulk action writing a code onto them.
  const AREA_GROUPED_CATEGORIES = ['QA-Intercept', 'Invalid HazMat'];
  function groupsWithFlaggedArea(category) {
    return AREA_GROUPED_CATEGORIES.indexOf(String(category == null ? '' : category).trim()) !== -1;
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

    // Express - Priority Overnight (#593) — always MANUAL, never auto-coded.
    //
    // 849 became a 2.0 station, so these are ours to code, but the cascade was
    // written for a Ground-only station and had no branch for this PLA. It fell
    // through to the "rows not in any known PLA category" rule below and was
    // SKIPPED unless it happened to land on the QA belt or a flagged work area.
    // Measured across four real Inbound and Van Scans exports, 12 open,
    // not-delivered express Priority Overnight packages were never surfaced
    // anywhere in the tool — no Ready to Enter, no Manual Review, no Browse.
    //
    // Manual and never auto: surfacing them cannot write a wrong code, and the
    // standard code for this category is not settled yet. The reason is kept
    // free of the "Work area:" phrasing on purpose — that phrasing is what
    // suggestedManualCode reads to offer a one-click 33, and an unsettled
    // category must not come with a suggested code attached. It buckets to
    // "Other, needs review", which is exactly the individual look it needs.
    //
    // Placed ABOVE the 9908 rules deliberately: 9908-on-a-weekend auto-codes 11,
    // which would auto-code an express Priority Overnight package. The
    // already-coded and already-van-scanned skips still win, because they sit
    // above this, and a Delivered package is still suppressed by decideCode's
    // wrapper — a delivered package needs no review.
    if (pla === 'Express - Priority Overnight') {
      const notes = ['Express Priority Overnight, needs review'];
      if (isWorkAreaFlagged(ibWork)) notes.push('flagged WA ' + ibWork);
      return { disposition: 'manual', category: pla, reason: notes.join(' | ') };
    }

    // 9908 vs the area-grouped categories (#619). Placed ABOVE both 9908 rules
    // for the same reason Express - Priority Overnight is placed above them:
    // 9908-on-a-weekend auto-codes 11, and auto-coding a QA intercept or a
    // hazmat exception means nobody ever looks at the package. 9908 is live at
    // 849 and weekend-only (Tyler, 2026-08-11), so that was the live path.
    //
    // The second half matters as much as the first: the 9908 rules below
    // overwrite `category` with the literal '9908 Work Area'. THREE separate
    // guards read that field — the bucket grouping (#602), the express lane
    // rule (#616) and the no-33 guard (#604) — so one overwrite defeated all
    // three at once and the package also stopped displaying as a hazmat.
    // Keeping the PLA here is what lets every one of them keep working.
    //
    // The reason deliberately avoids the 'Work area:' phrasing, which is what
    // suggestedManualCode reads to offer a one-click 33.
    //
    // Note this is independent of which areas are configured as flagged: these
    // categories are never auto-coded and never carry a suggested code, whatever
    // the settings say. Flagged work areas stay user-editable.
    if (ibWork === '9908' && groupsWithFlaggedArea(pla)) {
      return { disposition: 'manual', category: pla, reason: '9908 — ' + pla + ', needs review' };
    }

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
      postal:     fields.postal,
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

  // mainReportScanBarcodeMap(rows) -> { trackingId: SCAN_BARCODE } for EVERY
  // row of the full parsed main report (#649 follow-up fix on PR #650's
  // confirmed-blocking finding), not just the rows that received a coding
  // disposition.
  //
  // `rows` is the SAME raw array processRows/readFields consume — parseCSV
  // shape, preamble and all — e.g. ibno-coder.html's `lastRows`. This walks
  // it directly with findHeaderIndex/columnGetter (the exact header/preamble
  // handling processRows already uses, so the two paths can never drift on
  // where the real header row is) rather than going through decideCode at
  // all: decideCode's skip disposition (already QA-coded, already
  // van-scanned, delivered, etc.) is the CODING answer for whether a
  // package needs Tyler's review, and has nothing to do with whether the
  // report holds that row's SCAN_BARCODE. Most rows on a real Inbound and
  // Van Scans pull are skip-disposition and never become an auto/manual/
  // resolved item at all — building the cross-report barcode map from
  // those items undercounted tier 1 by roughly two orders of magnitude on a
  // real report (2 of 56 resolved instead of 54 of 56, measured against a
  // real 30,343-row pull and a real 56-row Post Sort report in a live
  // browser). This function's job is only "does the report hold a
  // SCAN_BARCODE for this tracking number", independent of disposition.
  //
  // Restricted to SCAN_BARCODE ONLY — deliberately NOT the VAN_SCAN_BARCODE
  // fallback readFields' `scanBarcode` field uses for the copy-mode toggle.
  // The #649 design rests entirely on a SCAN_BARCODE measurement (report-
  // registry.md rows 13-14); VAN_SCAN_BARCODE is a different scan event
  // with no equivalent measurement behind it. Because tier 1 (lib/post-
  // sort-lane.js's applyBarcodeLookup) wins outright and removes a row from
  // the Post Sort lookup-paste batch, presenting an unmeasured van barcode
  // as authoritative would leave no path left to correct a wrong one.
  function mainReportScanBarcodeMap(rows) {
    const map = Object.create(null);
    if (!Array.isArray(rows)) return map;
    const start = findHeaderIndex(rows);
    const sliced = start > 0 ? rows.slice(start) : rows;
    if (sliced.length < 2) return map;
    const get = columnGetter(sliced[0]);
    for (let r = 1; r < sliced.length; r++) {
      const row = sliced[r];
      if (!Array.isArray(row)) continue;
      const trackingId = String(get(row, 'PKG_LABEL_XREF') == null ? '' : get(row, 'PKG_LABEL_XREF')).trim();
      const scanBarcode = String(get(row, 'SCAN_BARCODE') == null ? '' : get(row, 'SCAN_BARCODE')).trim();
      if (trackingId && scanBarcode) map[trackingId] = scanBarcode;
    }
    return map;
  }

  // mainReportDispositionMap(rows) -> { trackingId: { disposition, category,
  //   code, reason } } for EVERY row of the full parsed main report
  // (2026-08-13, issue #651 follow-up; entry shape extended 2026-08-13,
  // issue #664 follow-up). Same `rows` contract and the same
  // findHeaderIndex/columnGetter walk as mainReportScanBarcodeMap above, for
  // the same reason: the two must never drift on where the real header row is.
  //
  // ENTRY SHAPE (#664). Each entry is decideCode's own decision object for
  // that row, augmented with a category fallback:
  //   disposition  'manual' | 'auto' | 'skip' — unchanged from before #664.
  //   category     decision.category when the cascade set one (every 'auto'
  //                and 'manual' branch does); otherwise the raw PLA_LOOKUP
  //                the report carried for this row. A 'skip' decision never
  //                sets category itself (see decideCodeInner), so without
  //                this fallback a skip row — 2,583 of 2,868 on the real
  //                mid-sort pull, and the ONLY rows this map is the sole
  //                record of, since processRows drops them — would report
  //                nothing about what the main report actually saw.
  //   code         decision.code for an 'auto' disposition; '' otherwise. Real
  //                Post Sort pulls carry ~0 auto rows (see
  //                lib/post-sort-lane.js's applyDisposition header comment),
  //                so this is here for completeness, not the common case.
  //   reason       decision.reason for a 'manual' disposition; '' otherwise.
  //                This is what lets a caller run the SAME
  //                lib/ibno-review-plan.js rowPlan/offeredCode a normal
  //                Manual Review row already goes through — reusing that
  //                cascade-derived reason text is what keeps a QA-Intercept
  //                or Invalid HazMat in a flagged Work Area from being
  //                offered a 33 here, with no new code-decision logic
  //                duplicated in this module or lib/post-sort-lane.js.
  //
  // decideCode (NOT decideCodeInner) still runs unmodified and untouched —
  // this only shapes its already-decided output into a richer map entry. The
  // coding cascade itself carries zero new branches for this ticket.
  //
  // WHY THIS EXISTS. The Post Sort lane renders every row of its report and
  // can never say which will be worked, because the two columns decideCode
  // winnows on — PLA_LOOKUP and BELT — are BOTH absent from that report's
  // 35-column schema (lib/post-sort-scans.js). But the main report, which the
  // tool has already loaded and already reads for SCAN_BARCODE, holds the
  // real answer for any label it carries. Measured on a real mid-sort pair
  // (2026-08-13): of 2,868 Post Sort rows, the main report calls 117 manual
  // and 2,583 skip, leaving only 168 genuinely undecidable. That is a 90%
  // reduction in what Tyler has to look at.
  //
  // DELIBERATELY the FULL row set, not processRows' auto/manual arrays.
  // processRows DROPS every skip row, so its output cannot distinguish "this
  // report says skip" from "this report has never seen this package" — and
  // that distinction is the entire point here: the first is safe to fold
  // away, the second must stay in front of Tyler. This is the same trap PR
  // #650 already paid for on the barcode map (2 of 56 instead of 54 of 56);
  // reading dispositioned items instead of raw rows breaks it the same way.
  //
  // NOT a coding decision and never written back: this reports what the main
  // report ALREADY decided, purely so the Post Sort lane can order and fold
  // its own view. No code, category or disposition is written to a Post Sort
  // row by this map — the lane's "never offers a QA Scan Code" guarantee
  // (lib/post-sort-lane.js) is untouched.
  function mainReportDispositionMap(rows) {
    const map = Object.create(null);
    if (!Array.isArray(rows)) return map;
    const start = findHeaderIndex(rows);
    const sliced = start > 0 ? rows.slice(start) : rows;
    if (sliced.length < 2) return map;
    const get = columnGetter(sliced[0]);
    // Same weekday/weekend detection processRows uses — dayType changes real
    // dispositions (9908 weekend auto-codes 11, weekday goes manual), so
    // reading it from anywhere else would make this map disagree with the
    // very lanes it is describing.
    const dayType = getDayType(get(sliced[1], 'INBOUND_DATE'));
    for (let r = 1; r < sliced.length; r++) {
      const row = sliced[r];
      if (!Array.isArray(row)) continue;
      if (row.length < 10) continue; // same structural guard processRows uses
      const fields = readFields(row, get);
      const trackingId = String(fields.label == null ? '' : fields.label).trim();
      if (!trackingId) continue;
      const decision = decideCode(fields, dayType);
      const category = (decision.category != null && decision.category !== '')
        ? decision.category
        : String(fields.pla == null ? '' : fields.pla).trim();
      const entry = {
        disposition: decision.disposition,
        category: category,
        code: decision.disposition === 'auto' ? decision.code : '',
        reason: decision.disposition === 'manual' ? decision.reason : '',
      };
      // First writer wins for 'manual': a tracking number appearing on more
      // than one row must never be downgraded to skip by a later row. The
      // cost of wrongly folding a real manual row away is Tyler not seeing a
      // package he has to work; the cost of wrongly keeping one is one extra
      // row on screen. Those are not symmetric, so this resolves toward
      // showing it.
      if (map[trackingId] && map[trackingId].disposition === 'manual') continue;
      if (map[trackingId] && entry.disposition === 'skip') continue;
      map[trackingId] = entry;
    }
    return map;
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
    isExpress: isExpress,
    AREA_GROUPED_CATEGORIES: AREA_GROUPED_CATEGORIES,
    groupsWithFlaggedArea: groupsWithFlaggedArea,
    manualLane: manualLane,
    decideCode: decideCode,
    processRows: processRows,
    mainReportScanBarcodeMap: mainReportScanBarcodeMap,
    mainReportDispositionMap: mainReportDispositionMap,
    detectRecurring: detectRecurring,
    pruneHistory: pruneHistory,
    historyForSync: historyForSync,
    reattachDetail: reattachDetail,
    historyRows: historyRows,
    repeatHotspots: repeatHotspots,
  };
});
