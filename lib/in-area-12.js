'use strict';

// In-Area 12 / MDVS-prevention detection engine for the Station 849 dashboard
// (PRD #184, slice #185). Domain terms live in CONTEXT.md: a **12** is a row
// where the VSA or STAR status code is 12; an **In-Area 12** is a 12 whose WA#
// matches the leading number of its Vision Label (a suspicious missort — the
// package was coded 12 in the very area Vision assigned it to); a **Correct 12**
// (WA# != Vision lead) is a legitimate missort and excluded. A candidate is
// flagged when it inbounds again today to the same area it was 12'd in
// yesterday — catching it before it becomes a Multi-Day Van Scan.
//
// Dual-loadable, no build step (mirrors lib/csv.js, lib/ibno-rules.js):
// - Browser: window.InArea12
// - Node: require('./lib/in-area-12')
//
// The filename tracks the domain term, not the tool's working name ("DSW"),
// which is still being finalized — so renaming the tool won't churn this module.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.InArea12 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // Reuse the single-source CSV column reader (mirrors lib/ibno-rules.js).
  function resolveColumnGetter() {
    if (root && root.CsvLib && typeof root.CsvLib.columnGetter === 'function') return root.CsvLib.columnGetter;
    if (root && typeof root.columnGetter === 'function') return root.columnGetter;
    if (typeof require === 'function') return require('./csv').columnGetter;
    throw new Error('columnGetter unavailable: load lib/csv.js before lib/in-area-12.js');
  }
  const columnGetter = resolveColumnGetter();

  // Coded-report column headers. CONFIRMED 2026-06-10 (issue #187) against the
  // real "Package Level Detail Table" export (PackageLevelDetails): these names
  // match exactly — the export just prepends a FedEx/Generated title block above
  // the header, which stripCodedPreamble removes. Reading by header name (not
  // index) tolerates the column order changing.
  const COL = {
    tracking: 'Tracking ID',
    wa: 'WA#',
    vision: 'Vision Label',
    provider: 'Service Provider',
    address: 'Destination Address',
    vsa: 'VSA Status Code',
    star: 'STAR Status Code',
    // Audit-only display columns: read opportunistically (blank if absent) so
    // they enrich the worksheet without being required for detection — keeping
    // CODED_HEADERS (validation) to the columns the logic actually needs.
    workAreaName: 'Work Area Name',
    psaCsa: 'PSA/CSA',
    vehicle: 'Vehicle #',
  };
  // Inbound and Van Scans report columns (same as the IBNO Coder). scanTime and
  // the LABEL_* address fields are audit-only (not required for detection). The
  // coded report's "Destination Address" is one smushed field, but the inbound
  // report carries the recipient/address SEPARATED — and every flagged package
  // is in the inbound report — so we source a clean Recipient + Address here.
  const INBOUND_COL = {
    tracking: 'PKG_LABEL_XREF', area: 'IB_WORK_AREA', scanTime: 'IB_SCAN_TIME',
    recipient: 'LABEL_FIRM_NAME', addr1: 'LABEL_ADDRESS1', addr2: 'LABEL_ADDRESS2',
    city: 'LABEL_CITY', state: 'LABEL_STATE', zip: 'POSTAL_CODE',
    // Audit-only (slice #274): SORT_SID joins IB_WORK_AREA as today's equivalent
    // of the Vision Label (IB_WORK_AREA-SORT_SID — mirrors the IBNO Coder's
    // workSort), and VAN_SCAN_TIME tells whether the package is already on the
    // truck today. Both are opportunistic reads — blank if the column is absent.
    sortSid: 'SORT_SID',
    vanScanTime: 'VAN_SCAN_TIME', vanScanName: 'VAN_SCAN_NAME', vanWorkArea: 'VAN_WORK_AREA',
  };

  // A package is "on the truck today" if it has been van-scanned at all today —
  // ANY of the van-scan fields populated on ANY of its inbound rows. The van
  // scan is often recorded on a separate scan row (a different IB_WORK_AREA)
  // than the same-area inbound that flagged the package, so we must look across
  // all of the tracking's scans, not just the matched same-area one.
  function hasVanScan(scan) {
    return String(scan.vanScanTime || '').trim() !== '' ||
           String(scan.vanScanName || '').trim() !== '' ||
           String(scan.vanWorkArea || '').trim() !== '';
  }

  // Today's Vision Label: IB_WORK_AREA-SORT_SID (the raw inbound work area, not
  // the leading-zero-normalized one, to mirror the report and the IBNO Coder's
  // workSort). Blank SORT_SID → bare work area, no trailing dash.
  function todaysVisionLabel(ibArea, sortSid) {
    return [String(ibArea == null ? '' : ibArea).trim(),
            String(sortSid == null ? '' : sortSid).trim()].filter(Boolean).join('-');
  }

  // Street line from the two address fields, skipping a blank one:
  // "6525 W HAPPY VALLEY RD" or "WATER PRODUCTION, DEERE VALY WTR TRTMNT PLT".
  // City / State / Zip stay separate columns for auditing.
  function composeStreet(a1, a2) { return [a1, a2].filter(Boolean).join(', '); }

  // A row counts as a 12 if EITHER the VSA Status Code OR the STAR Status Code
  // is 12 (Tyler: "its either/or — if its vsa or star its considered a 12").
  function isTwelve(rec) {
    return String(rec.vsa).trim() === '12' || String(rec.star).trim() === '12';
  }

  // The Vision Label is formatted "<work-area>-<sequence> <timestamp>"
  // (e.g. "144-7007 2026-...", or "7708- 2026-..." with no sequence). The work
  // area Vision assigned is the token before the first dash.
  function visionLeadArea(label) {
    const str = String(label == null ? '' : label).trim();
    const dash = str.indexOf('-');
    return (dash === -1 ? str.split(/\s/)[0] : str.slice(0, dash)).trim();
  }

  // Strip leading zeros so 0359 and 359 compare equal. Keep as a string so it
  // works for purely-numeric and any unexpected non-numeric area codes alike.
  function normalizeArea(value) {
    const str = String(value == null ? '' : value).trim();
    const stripped = str.replace(/^0+/, '');
    return stripped === '' ? str : stripped; // all-zeros → keep original
  }

  // From the previous-day coded report (raw parsed rows, header first), keep the
  // rows that are both a 12 and an In-Area 12 (WA# == Vision lead). These are the
  // suspicious-missort candidates; Correct 12s (WA# != Vision lead) are dropped.
  function findCandidates(rows) {
    if (!Array.isArray(rows) || rows.length < 2) return [];
    const get = columnGetter(rows[0]);
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const rec = {
        tracking: get(row, COL.tracking),
        wa: get(row, COL.wa),
        serviceProvider: get(row, COL.provider),
        address: get(row, COL.address),
        vsa: get(row, COL.vsa),
        star: get(row, COL.star),
        visionLabel: get(row, COL.vision),
        workAreaName: get(row, COL.workAreaName),
        psaCsa: get(row, COL.psaCsa),
        vehicle: get(row, COL.vehicle),
      };
      if (!isTwelve(rec)) continue;
      if (normalizeArea(rec.wa) !== normalizeArea(visionLeadArea(rec.visionLabel))) continue;
      out.push(rec);
    }
    return out;
  }

  // Given candidates and today's Inbound and Van Scans report (raw parsed rows),
  // flag the candidates that inbounded again to the SAME area they were 12'd in
  // (today's IB_WORK_AREA == previous-day WA#, leading zeros ignored). Candidates
  // absent from the inbound report, or that inbounded to a different area, are
  // dropped. Returns the structured records the Teams list is built from.
  function flagRecurring(candidates, inboundRows) {
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    if (!Array.isArray(inboundRows) || inboundRows.length < 2) return [];
    const get = columnGetter(inboundRows[0]);

    // tracking → list of today's inbound scans { area, time } (a package may
    // have more than one inbound scan). We keep the times so the worksheet can
    // show WHEN it scanned back into the same area, for auditing.
    const inboundScans = Object.create(null);
    for (let r = 1; r < inboundRows.length; r++) {
      const row = inboundRows[r];
      if (!row) continue;
      const tracking = get(row, INBOUND_COL.tracking);
      if (!tracking) continue;
      const area = normalizeArea(get(row, INBOUND_COL.area));
      const time = get(row, INBOUND_COL.scanTime);
      const recipient = get(row, INBOUND_COL.recipient);
      const street = composeStreet(get(row, INBOUND_COL.addr1), get(row, INBOUND_COL.addr2));
      const city = get(row, INBOUND_COL.city);
      const stateCode = get(row, INBOUND_COL.state);
      const zip = get(row, INBOUND_COL.zip);
      const rawArea = get(row, INBOUND_COL.area);
      const sortSid = get(row, INBOUND_COL.sortSid);
      const vanScanTime = get(row, INBOUND_COL.vanScanTime);
      const vanScanName = get(row, INBOUND_COL.vanScanName);
      const vanWorkArea = get(row, INBOUND_COL.vanWorkArea);
      (inboundScans[tracking] || (inboundScans[tracking] = [])).push({
        area: area, time: time, recipient: recipient, street: street, city: city, state: stateCode, zip: zip,
        rawArea: rawArea, sortSid: sortSid,
        vanScanTime: vanScanTime, vanScanName: vanScanName, vanWorkArea: vanWorkArea,
      });
    }

    const flagged = [];
    for (const c of candidates) {
      const scans = inboundScans[c.tracking];
      if (!scans) continue;
      const matched = scans.filter(function (s) { return s.area === normalizeArea(c.wa); });
      if (matched.length === 0) continue;
      const times = matched.map(function (s) { return s.time; }).filter(Boolean);
      const m = matched[0];
      // On truck today: any van scan across ALL of this tracking's scans today
      // (the van-scan row is often a different IB_WORK_AREA than the matched one).
      const onTruck = scans.some(hasVanScan);
      flagged.push({
        tracking: c.tracking,
        area: c.wa,
        workAreaName: c.workAreaName,
        visionLabel: c.visionLabel,
        todaysVisionLabel: todaysVisionLabel(m.rawArea, m.sortSid),
        onTruck: onTruck,
        vsa: c.vsa,
        star: c.star,
        psaCsa: c.psaCsa,
        serviceProvider: c.serviceProvider,
        vehicle: c.vehicle,
        inboundScanTime: times.join('; '),
        recipient: m.recipient,
        // Street from the inbound report's clean label fields; fall back to the
        // coded report's smushed Destination Address if they're blank.
        street: m.street || c.address,
        city: m.city,
        state: m.state,
        zip: m.zip,
      });
    }
    return flagged;
  }

  // Header validation for the DSW page (slice #186): reading columns by name
  // means an unexpected header silently yields empty cells and a falsely-empty
  // flagged list, so each drop zone must check its file's header row up front.
  // The generic set-difference lives in lib/csv.js (CsvLib.missingHeaders);
  // this module only owns WHICH columns each report must have.
  function resolveMissingHeaders() {
    if (root && root.CsvLib && typeof root.CsvLib.missingHeaders === 'function') return root.CsvLib.missingHeaders;
    if (typeof require === 'function') return require('./csv').missingHeaders;
    throw new Error('missingHeaders unavailable: load lib/csv.js before lib/in-area-12.js');
  }
  const missingHeaders = resolveMissingHeaders();

  const CODED_HEADERS = [COL.tracking, COL.wa, COL.vision, COL.provider, COL.address, COL.vsa, COL.star];
  const INBOUND_HEADERS = [INBOUND_COL.tracking, INBOUND_COL.area];

  function missingCodedHeaders(headerRow) { return missingHeaders(headerRow, CODED_HEADERS); }
  function missingInboundHeaders(headerRow) { return missingHeaders(headerRow, INBOUND_HEADERS); }

  // Some report exports (the SSRS "Inbound and Van Scans - Full Detail by Date"
  // is the one we've seen) prepend a title/Facility/Sort-Date preamble ABOVE the
  // real CSV header, so rows[0] is junk like "Textbox12" and header validation
  // would fail on a perfectly good file. Find the first row that contains EVERY
  // column the report must have — a preamble line never does — and slice the
  // preamble off so rows[0] is the real header. No match -> rows unchanged, so
  // a genuinely wrong file still fails loudly. Mirrors ibno-rules.findHeaderIndex.
  function findHeaderIndex(rows, signature) {
    if (!Array.isArray(rows)) return 0;
    const want = (Array.isArray(signature) ? signature : []).map(function (s) { return String(s).trim().toUpperCase(); });
    if (want.length === 0) return 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      const cells = row.map(function (c) { return String(c == null ? '' : c).trim().toUpperCase(); });
      if (want.every(function (w) { return cells.indexOf(w) !== -1; })) return i;
    }
    return 0;
  }
  function stripPreamble(rows, signature) {
    const i = findHeaderIndex(rows, signature);
    return i > 0 && Array.isArray(rows) ? rows.slice(i) : rows;
  }
  function stripCodedPreamble(rows) { return stripPreamble(rows, CODED_HEADERS); }
  function stripInboundPreamble(rows) { return stripPreamble(rows, INBOUND_HEADERS); }

  return {
    isTwelve: isTwelve,
    visionLeadArea: visionLeadArea,
    normalizeArea: normalizeArea,
    findCandidates: findCandidates,
    flagRecurring: flagRecurring,
    missingCodedHeaders: missingCodedHeaders,
    missingInboundHeaders: missingInboundHeaders,
    findHeaderIndex: findHeaderIndex,
    stripCodedPreamble: stripCodedPreamble,
    stripInboundPreamble: stripInboundPreamble,
  };
});
