'use strict';

// Address Catcher session — the DOM-free core behind address-catcher.html
// (ADR-0012 / issue #295, slice 1 = issue #296). Mirrors lib/ibno-session.js:
// composes the deep modules (address-normalize, address-dictionary,
// address-match) plus report parsing into one testable interface. No DOM, no
// localStorage, no network — the page passes state in and owns persistence
// (mirroring the ibno-session.js pattern note).
//
// SCOPE:
// - Address Corrections Report: read via SpreadsheetLib/XlsxLib (reused, not
//   reimplemented) — columns confirmed against the real export
//   (reports/source-files/2026-06-24-address-corrections.xlsx): Date,
//   Tracking id, Original Address, Corrected Address, Source (+ others
//   ignored here).
// - Inbound and Van Scans report: parsed via the shared lib/inbound-scans.js
//   (issue #297, slice 2 of #295) — the SAME parser the IBNO Coder uses
//   (lib/ibno-rules.js), so both tools read the report identically and don't
//   drift (ADR-0012). Slice 1 (#296) shipped a minimal local parser here;
//   this module now consumes the extracted one instead.
// - Recurring-IBNO annotation (issue #300, slice 7): recurringIbnoTrackingIds
//   below builds the annotation set from the IBNO Coder's Repeat History
//   (lib/ibno-rules.js historyRows) — see that function's comment for the
//   data-source rationale. IbnoRules is an OPTIONAL dependency (unlike the
//   others in deps()): the Address Catcher must keep working standalone even
//   when the IBNO Coder's lib isn't loaded or its history is empty/absent.
// - Manual Assignment Detail at IB Scan (issue #301, slice 5): parsed by
//   REUSING lib/masterlist.js's parseAssignmentRows (the MasterList
//   Builder's own parser — never a second parser for the same report, per
//   the repo's consolidation rule), then mapped to assignment records
//   ({ report: 'assignment', original, workArea, postalCode, ... }) and
//   merged as the dictionary's second source: work-area capture +
//   both-report corroboration. MasterlistLib is resolved lazily inside
//   parseAssignmentRecords so the other entry points keep working when
//   lib/masterlist.js isn't loaded.
// - Misroute flagging (issue #302, slice 6): parseInboundRows now threads
//   ibWorkArea (IB_WORK_AREA) through on each inbound record so
//   AddressMatch.matchInbound can compare it against the entry's known true
//   work area and set `misroute` on the match. This module does no
//   comparison itself — see lib/address-match.js for the flagging logic.
// - Worklist rebuild + real flag signals (issue #357): the itqaFlagged read
//   is REMOVED — the real Inbound and Van Scans report has no ITQA flag
//   column, so it always read false (a dead signal, not a real one).
//   parseInboundRows now threads statusCodes (STATUS_CODES1) and
//   vanScanTime (VAN_SCAN_TIME1) through instead, via the shared
//   lib/inbound-scans.js's additive extension — see lib/address-match.js for
//   how they become the CODED/ON TRUCK pills. inboundSortDate(rows) derives
//   the loaded report's own sort date (INBOUND_DATE, mode across rows) for
//   the worklist's done-state persistence key — address-catcher.html owns
//   the actual localStorage read/write, this module only computes the key.
//
// Dual-loadable with no build step:
// - Browser: window.AddressCatcherSession (deps already on root)
// - Node: require('./lib/address-catcher-session')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AddressCatcherSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function deps() {
    const columnGetter = (root && root.CsvLib && root.CsvLib.columnGetter) ||
      (root && root.columnGetter) ||
      (typeof require === 'function' ? require('./csv').columnGetter : null);
    const AddressDictionary = (root && root.AddressDictionary) ||
      (typeof require === 'function' ? require('./address-dictionary') : null);
    const AddressMatch = (root && root.AddressMatch) ||
      (typeof require === 'function' ? require('./address-match') : null);
    const InboundScans = (root && root.InboundScans) ||
      (typeof require === 'function' ? require('./inbound-scans') : null);
    if (typeof columnGetter !== 'function' || !AddressDictionary || !AddressMatch || !InboundScans) {
      throw new Error('AddressCatcherSession dependencies unavailable (need CsvLib, AddressDictionary, AddressMatch, InboundScans)');
    }
    // IbnoRules is OPTIONAL (see module comment): the Recurring-IBNO
    // annotation degrades to "no annotations" rather than throwing when the
    // IBNO Coder's lib isn't present.
    const IbnoRules = (root && root.IbnoRules) ||
      (typeof require === 'function' ? safeRequireIbnoRules() : null);
    // CorrectionOverrides is OPTIONAL, same degrade-gracefully shape as
    // IbnoRules (issue #426): a caller that never passes options.correctionLog
    // gets the pre-#426 behavior with no dependency required at all.
    const CorrectionOverrides = (root && root.CorrectionOverrides) ||
      (typeof require === 'function' ? safeRequireCorrectionOverrides() : null);
    return {
      columnGetter: columnGetter,
      AddressDictionary: AddressDictionary,
      AddressMatch: AddressMatch,
      InboundScans: InboundScans,
      IbnoRules: IbnoRules,
      CorrectionOverrides: CorrectionOverrides,
    };
  }

  function safeRequireIbnoRules() {
    try { return require('./ibno-rules'); } catch (e) { return null; }
  }

  function safeRequireCorrectionOverrides() {
    try { return require('./correction-overrides'); } catch (e) { return null; }
  }

  // Address Corrections Report header signature — confirmed against the real
  // export (see module comment above). The report has no preamble rows (the
  // header is rows[0]), unlike the coded/inbound reports.
  const CORRECTIONS_HEADER_SIGNATURE = ['Tracking id', 'Original Address', 'Corrected Address'];

  function findCorrectionsHeaderIndex(rows) {
    if (!Array.isArray(rows)) return 0;
    const wantKeys = CORRECTIONS_HEADER_SIGNATURE.map(headerKey);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      const keys = row.map(headerKey);
      if (wantKeys.every(function (k) { return keys.indexOf(k) !== -1; })) return i;
    }
    return 0;
  }

  function headerKey(name) {
    return String(name == null ? '' : name).trim().toUpperCase();
  }

  // parseCorrectionsRows(rows) -> record[]
  // rows in parseCSV/parseXlsx shape (header row + data rows). One record per
  // data row: { original, corrected, source, date, trackingId, originalName,
  // correctedName }. A row with no tracking id, no original, and no
  // corrected address (fully blank, or a trailing filter-summary footer row
  // the real export appends) is skipped; address-dictionary.js itself
  // separately drops any record whose original or corrected canonicalizes to
  // blank, so a tracking-id-only row cannot build a bogus entry.
  //
  // originalName/correctedName (issue #358): the real export's Original
  // Name / Corrected Name columns (~82% filled — confirmed against
  // reports/source-files/2026-06-24-address-corrections.xlsx), threaded
  // through ADDITIVELY so the dictionary can carry the recipient name behind
  // a suppressed adds-a-unit mapping for the name-matched advisory tier. Never
  // affects the address-matching path — only the advisory read.
  // deliveredAddress (issue #359): the real export's Delivered Address
  // column -- ground truth of where the package actually delivered,
  // threaded through ADDITIVELY so the dictionary can record per-mapping
  // delivery-confirmation evidence (see lib/address-dictionary.js merge()).
  // Many rows leave it blank (no delivery recorded yet); a blank value
  // simply means no confirmation evidence from that record, never an error.
  // employeeId (issue 484): the real export's Employee ID column -- who made
  // the correction -- threaded through ADDITIVELY so the dictionary can build
  // a per-flag correction history grouped by person (see
  // lib/address-dictionary.js correctionHistory()). Frequently blank (not
  // every Source records an operator); a blank value just means that
  // occurrence carries no employee attribution, never an error.
  function parseCorrectionsRows(rows) {
    const d = deps();
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const headerIdx = findCorrectionsHeaderIndex(rows);
    const get = d.columnGetter(rows[headerIdx]);
    const out = [];
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      const trackingId = get(row, 'Tracking id');
      const original = get(row, 'Original Address');
      const corrected = get(row, 'Corrected Address');
      if (!trackingId && !original && !corrected) continue; // fully blank row
      out.push({
        trackingId: trackingId,
        original: original,
        corrected: corrected,
        source: get(row, 'Source'),
        date: get(row, 'Date'),
        originalName: get(row, 'Original Name'),
        correctedName: get(row, 'Corrected Name'),
        deliveredAddress: get(row, 'Delivered Address'),
        employeeId: get(row, 'Employee ID'),
      });
    }
    return out;
  }

  // Inbound and Van Scans report — parsed via the shared lib/inbound-scans.js
  // (issue #297, slice 2 of #295): the SAME parser the IBNO Coder uses
  // (lib/ibno-rules.js), replacing this module's prior local parser so both
  // tools read the report identically and don't drift (ADR-0012).

  // parseInboundRows(rows) -> record[]
  // One record per data row carrying a non-blank PKG_LABEL_XREF:
  // { trackingId, address, ibWorkArea, statusCodes, vanScanTime,
  //   inboundDate, firmName }. `address` joins LABEL_ADDRESS1, LABEL_CITY,
  // LABEL_STATE, POSTAL_CODE (skips LABEL_ADDRESS2/suite — matches the
  // minimal-normalization scope established in slice 1). ibWorkArea
  // (slice 6, #302) is passed straight through from the shared parser's own
  // IB_WORK_AREA read — the raw inbound work area AddressMatch.matchInbound
  // compares against the entry's known true work area to flag a misroute.
  //
  // itqaFlagged is REMOVED (issue #357): the real Inbound and Van Scans
  // report has no ITQA flag column, so the prior ITQA_FLAG/ITQA-column read
  // never found anything and every record's itqaFlagged was always false —
  // a dead read producing a constant, not a signal. statusCodes
  // (STATUS_CODES1) and vanScanTime (VAN_SCAN_TIME1) — read via the shared
  // lib/inbound-scans.js's additive extension — replace it with the real
  // CODED/ON TRUCK signals (see lib/address-match.js for how they're used).
  // inboundDate (INBOUND_DATE, normalized to ISO via IbnoRules.toIsoDate when
  // available) is threaded through for inboundSortDate() below — the
  // worklist's done-state persistence key (issue #357).
  //
  // firmName (LABEL_FIRM_NAME, issue #358) is threaded through additively —
  // the recipient name on today's package label, used only by the name-match
  // advisory tier (see lib/address-match.js's matchNameAdvisories). Never
  // affects address matching.
  function parseInboundRows(rows) {
    const d = deps();
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const scans = d.InboundScans.parseInboundScans(rows);
    const headerIdx = d.InboundScans.findHeaderIndex(rows);
    const get = d.columnGetter(rows[headerIdx]);
    const dateByTrackingId = Object.create(null);
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      const trackingId = get(row, 'PKG_LABEL_XREF');
      if (!trackingId) continue;
      dateByTrackingId[trackingId] = get(row, 'INBOUND_DATE') || '';
    }
    return scans.map(function (rec) {
      const address = [rec.labelAddress1, rec.labelCity, rec.labelState, rec.postalCode]
        .filter(Boolean).join(' ');
      return {
        trackingId: rec.trackingId,
        address: address,
        ibWorkArea: rec.ibWorkArea || '',
        statusCodes: rec.statusCodes || '',
        vanScanTime: rec.vanScanTime || '',
        inboundDate: toIsoDate(dateByTrackingId[rec.trackingId] || ''),
        firmName: rec.firmName || '',
      };
    });
  }

  // toIsoDate(dateStr) -> 'YYYY-MM-DD' or ''. Delegates to the IBNO Coder's
  // own normalizer (lib/ibno-rules.js) when it's loaded — never a second
  // date-parsing implementation (this repo's consolidation rule). IbnoRules
  // is an OPTIONAL dependency here (same as elsewhere in this module): when
  // it isn't present, an unparseable date just means inboundSortDate() below
  // can't derive a key, which its own caller (address-catcher.html) treats
  // as "don't persist done-state" rather than throwing.
  function toIsoDate(dateStr) {
    const d = deps();
    if (d.IbnoRules && typeof d.IbnoRules.toIsoDate === 'function') return d.IbnoRules.toIsoDate(dateStr);
    return '';
  }

  // inboundSortDate(rows) -> 'YYYY-MM-DD' or ''. The loaded inbound report's
  // own sort date (INBOUND_DATE), used as the localStorage key for the
  // worklist's done-state persistence (issue #357 AC: same-day reload keeps
  // it, a different day's inbound resets it). Takes the MODE (most common)
  // ISO date across all data rows rather than just the first — a report is
  // expected to carry one sort date, but this is robust to a stray
  // mis-dated row without needing every row to agree. Returns '' when no
  // row yields a parseable date (rows empty/malformed) — the caller must
  // treat '' as "no key, don't persist" rather than using it as a real key.
  function inboundSortDate(rows) {
    const d = deps();
    if (!Array.isArray(rows) || rows.length === 0) return '';
    const headerIdx = d.InboundScans.findHeaderIndex(rows);
    const get = d.columnGetter(rows[headerIdx]);
    const counts = Object.create(null);
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      const trackingId = get(row, 'PKG_LABEL_XREF');
      if (!trackingId) continue;
      const iso = toIsoDate(get(row, 'INBOUND_DATE'));
      if (!iso) continue;
      counts[iso] = (counts[iso] || 0) + 1;
    }
    let best = '';
    let bestCount = 0;
    Object.keys(counts).forEach(function (iso) {
      if (counts[iso] > bestCount) { best = iso; bestCount = counts[iso]; }
    });
    return best;
  }

  function masterlistLib() {
    const MasterlistLib = (root && root.MasterlistLib) ||
      (typeof require === 'function' ? require('./masterlist') : null);
    if (!MasterlistLib || typeof MasterlistLib.parseAssignmentRows !== 'function') {
      throw new Error('AddressCatcherSession dependency unavailable (need MasterlistLib for the Manual Assignment Detail report)');
    }
    return MasterlistLib;
  }

  // parseAssignmentRecords(rows) -> assignment record[] for
  // AddressDictionary.merge (issue #301). One record per Manual Assignment
  // Detail row carrying a tracking id AND a non-blank address (closure rows
  // with no address can't feed an address dictionary): { report:
  // 'assignment', original, workArea, postalCode, trackingId, date, source }.
  // `original` is the report's single ADDRESS column — the package's ship
  // address at IB scan (usually street-only; POSTAL CODE rides separately so
  // the dictionary's conservative prefix+ZIP join can land it on the
  // full-address corrections entries).
  function parseAssignmentRecords(rows) {
    const assignments = masterlistLib().parseAssignmentRows(rows);
    const out = [];
    assignments.forEach(function (a) {
      if (!a || !a.address || !String(a.address).trim()) return;
      out.push({
        report: 'assignment',
        original: a.address,
        workArea: a.workArea,
        postalCode: a.postalCode,
        trackingId: a.trackingId,
        date: a.scanDate,
        source: 'Manual Assignment',
      });
    });
    return out;
  }

  // learnAssignments(dictionary, rows) -> new dictionary. Parses a freshly
  // loaded Manual Assignment Detail at IB Scan report and merges it into the
  // accumulating dictionary as the second source (work area + corroboration).
  // Pure — mirrors learnCorrections.
  function learnAssignments(dictionary, rows) {
    const d = deps();
    return d.AddressDictionary.merge(dictionary || {}, parseAssignmentRecords(rows));
  }

  // learnCorrections(dictionary, rows) -> new dictionary. Parses a freshly
  // loaded Address Corrections Report and merges it into the accumulating
  // dictionary. Pure — mirrors IbnoSession.applyRows composing parse + rules.
  function learnCorrections(dictionary, rows) {
    const d = deps();
    const records = parseCorrectionsRows(rows);
    return d.AddressDictionary.merge(dictionary || {}, records);
  }

  // ── Area Dictionary (issue #451, slice 5 of #446) ────────────────────────
  // The standalone address -> Mainly Assigned Area knowledge (lib/
  // area-dictionary.js), fed from the SAME Manual Assignment Detail drop as
  // learnAssignments above but into its OWN dictionary — independent of
  // corrections, checked against EVERY inbound package. AreaDictionary is
  // resolved lazily (like masterlistLib) so the other entry points keep
  // working when lib/area-dictionary.js isn't loaded.
  function areaDictionaryLib() {
    const AreaDictionary = (root && root.AreaDictionary) ||
      (typeof require === 'function' ? require('./area-dictionary') : null);
    if (!AreaDictionary || typeof AreaDictionary.merge !== 'function') {
      throw new Error('AddressCatcherSession dependency unavailable (need AreaDictionary for the Area Dictionary)');
    }
    return AreaDictionary;
  }

  // parseAreaRecords(rows) -> area sighting[] for AreaDictionary.merge. Rows
  // are DEDUPED via MasterlistLib.dedupeAssignments first (scan-gun
  // double-hits must not inflate an area's sighting count — the calibration
  // script did the same, and the pinned real-export counts assume it).
  // Unlike parseAssignmentRecords above, a row with a BLANK address but a
  // postal code is KEPT — the Area Dictionary keys it by ZIP alone for
  // population-accounting parity with the calibration; its own matchInbound
  // never joins a street-less key (see lib/area-dictionary.js merge()).
  // No USER_NAME is ever threaded through — area codes, counts, dates only.
  function parseAreaRecords(rows) {
    const ml = masterlistLib();
    const deduped = ml.dedupeAssignments(ml.parseAssignmentRows(rows)).kept;
    return deduped.map(function (a) {
      return {
        address: a.address,
        postalCode: a.postalCode,
        workArea: a.workArea,
        date: a.scanDate,
        trackingId: a.trackingId,
      };
    });
  }

  // learnAreas(areaDictionary, rows) -> new area dictionary. Pure — mirrors
  // learnAssignments, but targets the standalone Area Dictionary.
  function learnAreas(areaDictionary, rows) {
    return areaDictionaryLib().merge(areaDictionary || {}, parseAreaRecords(rows));
  }

  // areaEvidence(rows) -> { [streetKey]: { key, mainlyAssignedArea, sightings[],
  // days, total, people } }. The WHO/WHEN evidence behind each misroute flag
  // (issue #479), derived by RE-PARSING the raw Manual Assignment Detail rows
  // in memory — NOT from the persisted Area Dictionary, which is deliberately
  // name-free (USER_NAME must never be persisted, issue #451). Keyed by the
  // SAME AreaDictionary.streetKey the flags use, so evidence[group.key] joins
  // 1:1 with a flagged group; a street-less (ZIP-only) key is dropped because
  // it never joins a flag (matchInbound rejects it too — shared isStreetless).
  //
  // Each sighting: { date (SCAN_DT), time (SCAN_TM), area (WORK_AREA),
  // userName (USER_NAME — the person who reassigned it), originalScan,
  // trackingId }. Rows are DEDUPED first (same trackingId+area+date is one
  // reassignment, matching the dictionary's tally). ALL sightings are kept for
  // the #480 detail table (including the occasional minority-area row).
  //
  // The HEADLINE counts (days/total/people) are scoped to the DOMINANT (Mainly
  // Assigned) area — the same area the flag rests on (via the shared
  // AreaDictionary.pickDominantArea + dayKey) — so the card's "N days" equals
  // the flag's daysCount and "M times" equals its "N of M" tally, rather than
  // overstating recurrence by counting unrelated minority-area reassignments.
  function areaEvidence(rows) {
    const ml = masterlistLib();
    const AreaDictionary = areaDictionaryLib();
    const deduped = ml.dedupeAssignments(ml.parseAssignmentRows(rows)).kept;
    const index = Object.create(null);
    deduped.forEach(function (a) {
      const key = AreaDictionary.streetKey(a.address, a.postalCode);
      if (!key || AreaDictionary.isStreetless(key)) return; // never joins a flag
      const e = index[key] || (index[key] = { key: key, mainlyAssignedArea: '', sightings: [], workAreas: Object.create(null), days: 0, total: 0, people: 0 });
      const area = String(a.workArea == null ? '' : a.workArea).trim();
      if (area) e.workAreas[area] = (e.workAreas[area] || 0) + 1;
      e.sightings.push({
        date: a.scanDate,
        time: a.scanTime,
        area: a.workArea,
        userName: a.userName,
        originalScan: a.originalScan,
        trackingId: a.trackingId,
      });
    });
    Object.keys(index).forEach(function (k) {
      const e = index[k];
      // Dominant area, picked the SAME way the dictionary does (most sightings,
      // lowest-numbered area on ties) so it matches the flag's mainlyAssignedArea.
      e.mainlyAssignedArea = AreaDictionary.pickDominantArea(e.workAreas).area;
      const days = Object.create(null);
      const people = Object.create(null);
      let total = 0;
      e.sightings.forEach(function (s) {
        if (String(s.area == null ? '' : s.area).trim() !== e.mainlyAssignedArea) return; // headline = belongs-area recurrence only
        total++;
        const dk = AreaDictionary.dayKey(s.date);
        if (dk) days[dk] = true;
        const p = String(s.userName == null ? '' : s.userName).trim();
        if (p) people[p] = true;
      });
      e.days = Object.keys(days).length;
      e.total = total;
      e.people = Object.keys(people).length;
      delete e.workAreas; // internal tally — not part of the public shape
      // Newest reassignment first (parsed date, then clock time as a tie-break
      // so same-day rows stay ordered); unparseable dates sink to the bottom.
      e.sightings.sort(function (x, y) {
        const tx = AreaDictionary.parseEntryDate(x.date);
        const ty = AreaDictionary.parseEntryDate(y.date);
        if (tx !== ty) return (ty == null ? -Infinity : ty) - (tx == null ? -Infinity : tx);
        return String(y.time || '').localeCompare(String(x.time || ''));
      });
    });
    return index;
  }

  // matchLiveAreas(areaDictionary, rows, options?) -> { matches, suggestions }
  // (see AreaDictionary.matchInbound). Parses the SAME freshly loaded
  // Inbound and Van Scans report via the shared lib/inbound-scans.js, but
  // — unlike parseInboundRows above, which composes the full display
  // address — hands AreaDictionary the SEPARATE labelAddress1 + postalCode
  // fields, because the Area Dictionary joins on street + ZIP5 (keying the
  // whole composed string gives zero matches — the #451 calibration proof).
  // options.recencyWindowDays/asOf age the dictionary (default 30 days,
  // matching DEFAULT_TRUST_OPTIONS); options.excludeTrackingIds carries the
  // tracking numbers already surfaced by the correction worklist so a
  // package matching BOTH dictionaries is never duplicated.
  function matchLiveAreas(areaDictionary, rows, options) {
    const d = deps();
    const AreaDictionary = areaDictionaryLib();
    const scans = d.InboundScans.parseInboundScans(rows);
    const records = scans.map(function (rec) {
      return {
        trackingId: rec.trackingId,
        labelAddress1: rec.labelAddress1,
        postalCode: rec.postalCode,
        ibWorkArea: rec.ibWorkArea || '',
        firmName: rec.firmName || '',
        address: [rec.labelAddress1, rec.labelCity, rec.labelState, rec.postalCode]
          .filter(Boolean).join(' '),
      };
    });
    const opts = Object.assign({ recencyWindowDays: DEFAULT_TRUST_OPTIONS.recencyWindowDays }, options || {});
    // Area Verdict Loop (issue #452, slice 6 of #446): apply any PROMOTED area
    // verdicts from options.correctionLog before flagging — the SAME staged
    // log->promote mechanism the correction side uses (see
    // trustedEntriesWithOverrides). Omitted/empty log (or no CorrectionOverrides
    // lib loaded) is an EXACT no-op: opts.areaEffects stays undefined and
    // AreaDictionary.matchInbound behaves byte-for-byte as before #452.
    if (d.CorrectionOverrides && Array.isArray(opts.correctionLog) && opts.correctionLog.length) {
      const promotedArea = d.CorrectionOverrides.promotedAreaOverrides(opts.correctionLog);
      if (promotedArea.length) opts.areaEffects = d.CorrectionOverrides.areaEffects(promotedArea);
    }
    return AreaDictionary.matchInbound(areaDictionary || {}, records, opts);
  }

  // Sensible defaults for trustedEntries()'s aging/threshold options (#299,
  // raised #343). 30 days mirrors the IBNO Coder's Repeat History retention
  // window (lib/ibno-archive.js ARCHIVE_DAYS / IbnoRules.HISTORY_DAYS) — the
  // established recency precedent in this repo. minCount default raised
  // 1 -> 2 (#343, live-use finding 2026-07-02): a single-occurrence
  // correction is too often a one-off forward, not a standing pattern worth
  // surfacing mid-sort — 670 of 777 real matches on the 2026-07-01 inbound
  // rested on a single past correction. address-catcher.html's on-page
  // threshold control (choices 1/2/3, default 2) lets this be tightened or
  // loosened live without re-dropping files; see its wiring for the
  // persisted-override shape. The real-fixture guard
  // (tests/manual-assignment-real-fixture.test.js) intentionally still pins
  // minCount: 1 explicitly — that test is about parser correctness, not
  // this UX default, so it stays unaffected by this change by design.
  const DEFAULT_TRUST_OPTIONS = { recencyWindowDays: 30, minCount: 2 };

  // recurringIbnoTrackingIds(ibnoHistory) -> Set(trackingId). Builds the
  // Recurring-IBNO annotation set (issue #300) by reusing the IBNO Coder's
  // OWN recurring-detection logic (lib/ibno-rules.js historyRows), never
  // reimplementing "what counts as recurring" here. `ibnoHistory` is the
  // raw persisted shape from IbnoRules.HISTORY_KEY in localStorage
  // (trackingNumber -> { dates, category } — see ADR-0001/ADR-0007);
  // historyRows() already filters to entries with at least one date inside
  // the 30-day window, and this function narrows further to
  // timesSeen >= 2 — the exact "Recurring IBNO" threshold historyRows'
  // callers use elsewhere (e.g. the Repeat History viewer). Returns an
  // empty Set (never throws) when IbnoRules isn't loaded or history is
  // empty/absent — the annotation is additive, not a hard dependency.
  function recurringIbnoTrackingIds(ibnoHistory) {
    const d = deps();
    if (!d.IbnoRules || typeof d.IbnoRules.historyRows !== 'function') return new Set();
    if (!ibnoHistory || typeof ibnoHistory !== 'object') return new Set();
    const rows = d.IbnoRules.historyRows(ibnoHistory) || [];
    const out = new Set();
    rows.forEach(function (row) {
      if (row && row.timesSeen >= 2 && row.tracking) out.add(row.tracking);
    });
    return out;
  }

  // trustedEntriesWithOverrides(dictionary, trustOptions, correctionLog) ->
  // { entries, demoted, misrouteSuppressKeys, promoted } (issue #426). Shared
  // by matchLiveInbound and matchLiveDemoted so both derive the SAME override
  // set from the SAME correctionLog on every call — never separately
  // recomputed, so they can't drift. `correctionLog` is the raw log array
  // (address-catcher.html's `correctionLog` variable); omitted/empty is an
  // EXACT no-op (entries pass through unchanged, demoted is empty, the
  // misroute-suppress set is empty) — this is CorrectionOverrides.
  // promotedOverrides()'s own no-op guarantee, just surfaced here so a caller
  // with no CorrectionOverrides lib loaded at all (or no log yet) never pays
  // for or depends on the feature.
  function trustedEntriesWithOverrides(dictionary, trustOptions, correctionLog) {
    const d = deps();
    const trusted = d.AddressDictionary.trustedEntries(dictionary || {}, trustOptions);
    if (!d.CorrectionOverrides || !Array.isArray(correctionLog) || correctionLog.length === 0) {
      return { entries: trusted, demoted: [], misrouteSuppressKeys: new Set(), promoted: [] };
    }
    const promoted = d.CorrectionOverrides.promotedOverrides(correctionLog);
    if (promoted.length === 0) {
      return { entries: trusted, demoted: [], misrouteSuppressKeys: new Set(), promoted: [] };
    }
    const applied = d.CorrectionOverrides.applyToTrustedEntries(trusted, promoted);
    const misrouteSuppressKeys = d.CorrectionOverrides.misrouteSuppressKeys(trusted, promoted);
    return { entries: applied.entries, demoted: applied.demoted, misrouteSuppressKeys: misrouteSuppressKeys, promoted: promoted };
  }

  // matchLiveInbound(dictionary, rows, options?) -> match[]. Parses a freshly
  // loaded Inbound and Van Scans report and matches it against the
  // dictionary's trusted entries. Pure. `options` overrides the default
  // recency window / minimum count (see DEFAULT_TRUST_OPTIONS) — a caller
  // that wants every entry regardless of age can pass
  // { recencyWindowDays: null }. `options.ibnoHistory`, when provided, turns
  // on the Recurring-IBNO annotation (issue #300) via
  // recurringIbnoTrackingIds() above; omitted, matches simply come back with
  // recurring: false (lib/address-match.js's own graceful default).
  // `options.correctionLog` (issue #426), when provided, applies any
  // PROMOTED Correction Feedback Loop overrides before matching — see
  // trustedEntriesWithOverrides() above; omitted, behavior is byte-for-byte
  // what it was before #426.
  function matchLiveInbound(dictionary, rows, options) {
    const d = deps();
    const inboundRecords = parseInboundRows(rows);
    const opts = options || {};
    const trustOptions = Object.assign({}, DEFAULT_TRUST_OPTIONS, opts);
    const withOverrides = trustedEntriesWithOverrides(dictionary, trustOptions, opts.correctionLog);
    const recurringIbnoSet = recurringIbnoTrackingIds(opts.ibnoHistory);
    return d.AddressMatch.matchInbound(inboundRecords, withOverrides.entries,
      { recurringIbnoSet: recurringIbnoSet, misrouteSuppressKeys: withOverrides.misrouteSuppressKeys });
  }

  // matchLiveDemoted(dictionary, rows, options?) -> match[] (issue #426). The
  // "manually-demoted" verify-first tier: mappings whose logged reject was
  // promoted with the "not always right / context-dependent" category. A
  // SEPARATE, PARALLEL path to matchLiveInbound — mirrors how
  // matchLiveNameAdvisories is parallel to matchLiveInbound for the (also
  // verify-first, but name-gated) Name-match Advisory tier. Requires
  // `options.correctionLog`; without it (or with no promoted "not always
  // right" rejects) this simply returns [] — the tier is additive, never a
  // hard dependency.
  function matchLiveDemoted(dictionary, rows, options) {
    const d = deps();
    const inboundRecords = parseInboundRows(rows);
    const opts = options || {};
    const trustOptions = Object.assign({}, DEFAULT_TRUST_OPTIONS, opts);
    const withOverrides = trustedEntriesWithOverrides(dictionary, trustOptions, opts.correctionLog);
    if (withOverrides.demoted.length === 0) return [];
    const recurringIbnoSet = recurringIbnoTrackingIds(opts.ibnoHistory);
    return d.AddressMatch.matchInbound(inboundRecords, withOverrides.demoted, { recurringIbnoSet: recurringIbnoSet });
  }

  // matchLiveNameAdvisories(dictionary, rows, options?) -> advisory[] (issue
  // #358). Parses the SAME freshly loaded Inbound and Van Scans report and
  // matches it against the dictionary's SUPPRESSED adds-a-unit entries (never
  // trustedEntries) via AddressDictionary.suppressedAddsUnitEntries() +
  // AddressMatch.matchNameAdvisories — the "Name match — verify" advisory
  // tier. Pure, mirrors matchLiveInbound's option-composition shape
  // (same trustOptions() aging/minCount discipline) so the two never drift on
  // what "recent enough / seen enough" means, even though they read
  // different entry sets.
  function matchLiveNameAdvisories(dictionary, rows, options) {
    const d = deps();
    const inboundRecords = parseInboundRows(rows);
    const opts = options || {};
    const trustOptions = Object.assign({}, DEFAULT_TRUST_OPTIONS, opts);
    const suppressed = d.AddressDictionary.suppressedAddsUnitEntries(dictionary || {}, trustOptions);
    return d.AddressMatch.matchNameAdvisories(inboundRecords, suppressed);
  }

  // ── Persistence: device-local dictionary storage ────────────────────────
  // The page owns the actual localStorage calls (mirrors ibno-session.js
  // snapshot/restore split) — these helpers own the persisted SHAPE.
  const STORAGE_KEY = 'address_catcher_dictionary';
  // Area Dictionary (issue #451): its own device-local key, separate from the
  // Address Correction Dictionary above — two dictionaries, two lifecycles
  // (ADR-0016's device-local posture applies to both; neither ever syncs).
  const AREA_STORAGE_KEY = 'address_catcher_area_dictionary';

  function snapshot(dictionary) {
    return dictionary || {};
  }

  // restore(stored) -> a usable dictionary object, or {} when the stored
  // value is missing/malformed. Never throws on bad JSON-parsed input.
  function restore(stored) {
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return stored;
  }

  return {
    // Exported so lib/report-clean.js can reuse this report's own header-finder
    // for the Clean Excel-ready export (#386) instead of duplicating the
    // corrections preamble signature — the Address Corrections report has no
    // SSRS preamble (header is row 0), so this normally returns 0.
    findCorrectionsHeaderIndex: findCorrectionsHeaderIndex,
    parseCorrectionsRows: parseCorrectionsRows,
    parseAssignmentRecords: parseAssignmentRecords,
    parseInboundRows: parseInboundRows,
    inboundSortDate: inboundSortDate,
    learnCorrections: learnCorrections,
    learnAssignments: learnAssignments,
    parseAreaRecords: parseAreaRecords,
    learnAreas: learnAreas,
    areaEvidence: areaEvidence,
    matchLiveAreas: matchLiveAreas,
    matchLiveInbound: matchLiveInbound,
    matchLiveDemoted: matchLiveDemoted,
    matchLiveNameAdvisories: matchLiveNameAdvisories,
    recurringIbnoTrackingIds: recurringIbnoTrackingIds,
    snapshot: snapshot,
    restore: restore,
    STORAGE_KEY: STORAGE_KEY,
    AREA_STORAGE_KEY: AREA_STORAGE_KEY,
    // Exported so callers displaying "N trusted mappings" (e.g.
    // address-catcher.html's header count) can apply the SAME aging/minCount
    // defaults matchLiveInbound uses — otherwise the displayed count and what
    // actually surfaces during live matching silently drift apart.
    DEFAULT_TRUST_OPTIONS: DEFAULT_TRUST_OPTIONS,
  };
});
