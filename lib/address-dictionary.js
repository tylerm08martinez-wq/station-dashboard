'use strict';

// Address Correction Dictionary — builds/merges the accumulating dictionary
// of address corrections (ADR-0012 / issue #295, slice 1 = issue #296,
// slice 4 = issue #299 adds aging + idempotent merge + evidence, slice 5 =
// issue #301 adds the Manual Assignment Detail report as a second source).
//
// SLICE 1 (#296) SCOPE: deterministic mappings only (one original
// consistently -> one corrected canonical address) become trusted entries.
// An original seen mapping to 2+ DISTINCT canonical corrected addresses is
// suppressed (ambiguous: true) rather than guessed.
//
// SLICE 4 (#299) ADDS:
// - Idempotent merge by record identity: re-loading the same export must not
//   double-count. A record's identity is (trackingId, date, source,
//   original-canonical, corrected-canonical) — re-parsing the same file
//   produces the same identity set, so re-merging it is a no-op. A genuinely
//   distinct correction event (different trk#, different date, etc.) still
//   counts. Per-entry identities are tracked in `seenIds` (a set, stored as
//   an object-map for JSON/localStorage friendliness) so merge() can detect
//   and skip already-counted records without needing external de-dup state.
// - lastSeen (the most recent record date contributing to an entry) so
//   trustedEntries() can age out entries unseen within a recency window.
// - trustedEntries(dictionary, options) — options: { recencyWindowDays,
//   minCount, asOf }. Omitting an option preserves the pre-#299 behavior for
//   that dimension (no aging, minCount 1) so existing callers are unaffected.
//
// SLICE 5 (#301) ADDS — Manual Assignment Detail as a second source:
// - merge() also accepts ASSIGNMENT records ({ report: 'assignment',
//   original, workArea, postalCode, source, date, trackingId }). The Manual
//   Assignment Detail report carries ONE address per row (the package's ship
//   address at IB scan) plus the manually assigned work area — it has no
//   original->corrected pair, so an assignment record NEVER creates or
//   changes a corrected-address claim (no correctedVariants / ambiguity
//   involvement). It contributes: an 'assignment' report marker (for the
//   both-report corroboration flag), a work-area tally, a fresh sighting
//   (lastSeen), and an assignmentCount — all evidence, never a suggestion.
// - trustedEntries() joins assignment observations onto correction entries
//   at read time (order-independent across exports): an observation whose
//   canonical key exactly equals the entry's original or corrected key, OR
//   is a leading-token prefix of it AND shares the observation's ZIP5,
//   corroborates the entry. The prefix+ZIP rule exists because the
//   assignment report's ADDRESS column usually lacks city/state/ZIP (ZIP is
//   a separate column) while corrections addresses carry them — exact keys
//   would almost never meet. Bias is to MISS (no corroboration shown), never
//   to fold two genuinely different addresses.
// - Per entry, trustedEntries() now also returns: corroborated (seen in
//   both reports), workArea, and assignmentCount. workArea (issue #448:
//   redefined from "single deterministic area, else blank" to the MAINLY
//   ASSIGNED AREA — the dominant, most-sighted area, always shown when any
//   assignment sighting exists) ships alongside workAreaTally (the full
//   per-area sighting counts), workAreaTotal, and workAreaCount (the
//   dominant area's own count) so a caller can render the evidence — "Area
//   401 · 9 of 11" when not unanimous, bare "Area 401" when it is — rather
//   than trusting a bare number as gospel. See pickDominantArea below.
//
// ADDS-A-UNIT SUPPRESSION (issue #342): an entry whose CORRECTED address
// carries a unit/suite token (#, APT, UNIT, STE, SUITE, LOT, TRLR, RM, BLDG)
// that the ORIGINAL lacks is marked `addsUnit: true` at merge() time and
// excluded by trustedEntries() — same suppression discipline as `ambiguous`.
// Rationale: such a mapping is a person-specific fix (the right unit belongs
// to a recipient, not the street address); suggesting a past package's unit
// for every future package to the complex is a categorical false flag, even
// when the mapping is otherwise deterministic. A mapping where the ORIGINAL
// already carries the unit (a true per-unit standing fix) is unaffected.
// Computed on raw display text via AddressNormalize.hasUnitToken, since the
// canonical key produced by normalizeAddress DROPS the marker token itself
// (see address-normalize.js) — post-normalization text can't tell "had a
// unit" from "never had one."
//
// STANDING-BUSINESS-REDIRECT EXEMPTION (issue #365, follow-up to #342): an
// addsUnit mapping that would otherwise be categorically suppressed is
// EXEMPT (trusted again) when the correction is a wholesale, repeated
// business redirect rather than a person's specific unit guessed onto a
// shared building. See computeDifferentPlace / EXEMPTION_MIN_COUNT /
// isExemptAddsUnit below for the two-part rule (different place AND count
// >= 3, its own fixed bar). Exempted entries are removed from BOTH the
// suppression (trustedEntries includes them again) and the name-matched
// advisory pool (suppressedAddsUnitEntries excludes them) so they never
// double-surface.
//
// DELIVERY-CONFIRMED TRUST SIGNAL (issue #359): a corrections record whose
// Delivered Address (ground truth of where the package actually delivered)
// AGREES with the record's own Corrected Address is stronger evidence than
// a bare seen-count -- the correction demonstrably worked, not merely "was
// applied." merge() computes this per-record via deliveryConfirms() below
// and, when true, increments entry.deliveryConfirmedCount -- tracked under
// the SAME recordIdentity as the rest of the correction event (not a
// separate identity set), so idempotent re-merge of the same export never
// double-counts it, exactly like count/lastSeen.
//
// AGREEMENT RULE (conservative, biased to NOT confirm): normalizeAddress
// the Corrected Address and the Delivered Address, then require the
// CORRECTED key to be a literal character-prefix of the DELIVERED key
// (deliveredKey.indexOf(correctedKey) === 0). This direction
// was chosen deliberately after inspecting the real export
// (reports/source-files/2026-06-24-address-corrections.xlsx): Delivered
// Address rows routinely carry extra digits GLUED directly onto the ZIP
// with no separator (e.g. corrected "...PHOENIX AZ 85027" vs delivered
// "...PHOENIX AZ 85027105047" -- a route/stop-sequence suffix the export
// appends, not a different address), so normalizeAddress's own ZIP token
// ends up literally longer on the delivered side. A plain equality check
// would miss these (undercounting real confirmations); requiring the
// delivered key to start with the corrected key catches them while still
// rejecting a delivered address to a different street/city/ZIP, a blank
// Delivered Address, or a delivered address that's merely a SHORTER prefix
// of the corrected one (the reverse direction is deliberately NOT accepted
// -- that would mean the delivered value is missing information the
// correction claims, a weaker and riskier claim than the chosen direction).
// On the real fixture this rule confirms 2,535 of 2,852 corrected packages
// with a recorded delivery -- see the #359 PR body for the full real-data
// verification (the issue's own quoted 2,326 stat could not be
// reproduced exactly by any tested heuristic; this is the most
// conservative, well-defined, and reproducible rule found -- see PR body).
function deliveryConfirms(correctedRaw, deliveredRaw, normalizeAddress) {
  const correctedKey = normalizeAddress(correctedRaw);
  const deliveredKey = normalizeAddress(deliveredRaw);
  if (!correctedKey || !deliveredKey) return false;
  return deliveredKey.indexOf(correctedKey) === 0;
}

// NAME-MATCHED ADVISORY TIER (issue #358): suppression from trustedEntries()
// is UNCHANGED — an addsUnit entry never becomes a trusted suggestion, full
// stop (no #342 regression). What's new: suppressedAddsUnitEntries() below
// is a SEPARATE reader that surfaces these same suppressed entries — but
// ONLY when the corrections record also carried an Original Name / Corrected
// Name (the real export's ~82%-filled columns) — as raw material for an
// advisory, never a trusted fix. The caller (AddressMatch.matchNameAdvisories)
// additionally requires today's package to carry a LABEL_FIRM_NAME that
// conservatively matches the entry's recorded name before anything surfaces.
// Design constraint (Tyler): even a matching name can legitimately route to
// an office instead of the unit — this is a LEAD to verify, never a trusted
// fix, and it must never be mixed into trustedEntries() or its consumers.
//

// Dual-loadable with no build step:
// - Browser: window.AddressDictionary
// - Node: require('./lib/address-dictionary')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AddressDictionary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function deps() {
    const AddressNormalize = (root && root.AddressNormalize) ||
      (typeof require === 'function' ? require('./address-normalize') : null);
    if (!AddressNormalize) throw new Error('AddressDictionary dependency unavailable (need AddressNormalize)');
    return {
      normalizeAddress: AddressNormalize.normalizeAddress,
      hasUnitToken: AddressNormalize.hasUnitToken,
      stripUnitTokens: AddressNormalize.stripUnitTokens,
      normalizeName: AddressNormalize.normalizeName,
    };
  }

  // recordIdentity(rec, originalKey, correctedKey) -> a stable string key
  // identifying this correction EVENT (not just the mapping). Two records
  // with the same identity are the same real-world event re-observed (e.g.
  // the same export loaded twice) and must count once. Built from the
  // canonical original/corrected keys (not raw display text) plus
  // trackingId/date/source so formatting-only re-exports still de-dupe.
  function recordIdentity(rec, originalKey, correctedKey) {
    const trackingId = String(rec.trackingId == null ? '' : rec.trackingId).trim();
    const date = String(rec.date == null ? '' : rec.date).trim();
    const source = String(rec.source == null ? '' : rec.source).trim().toUpperCase();
    return [trackingId, date, source, originalKey, correctedKey].join('|');
  }

  // assignmentIdentity(rec, key) -> stable identity for an assignment-report
  // record (issue #301). Includes the work area (the same trk# on the same
  // date can be genuinely assigned to two DIFFERENT areas — masterlist.js's
  // dedupeAssignments keeps those apart too) and a 'WA:' marker segment so
  // it can never collide with a corrections recordIdentity (whose 5th
  // segment is a canonical corrected key, never 'WA:'-prefixed). Kept
  // SEPARATE from recordIdentity so pre-#301 persisted seenIds keep
  // de-duping corrections re-loads byte-for-byte.
  function assignmentIdentity(rec, key) {
    const trackingId = String(rec.trackingId == null ? '' : rec.trackingId).trim();
    const date = String(rec.date == null ? '' : rec.date).trim();
    const workArea = String(rec.workArea == null ? '' : rec.workArea).trim();
    return [trackingId, date, 'ASSIGNMENT', key, 'WA:' + workArea].join('|');
  }

  function addReport(entry, report) {
    if (entry.reports.indexOf(report) === -1) entry.reports.push(report);
  }

  function touchLastSeen(entry, rec) {
    const recDate = String(rec.date == null ? '' : rec.date).trim();
    if (recDate && (!entry.lastSeen || recDate > entry.lastSeen)) entry.lastSeen = recDate;
  }

  function blankEntry(originalDisplay) {
    return {
      originalDisplay: cleanDisplay(originalDisplay),
      correctedDisplay: '',
      correctedKey: '',
      count: 0,
      sources: [],
      ambiguous: false,
      addsUnit: false,
      // differentPlace (issue #365): true when, after stripping unit/suite
      // tokens from BOTH sides, the corrected address still differs from the
      // original — i.e. the correction's contribution is NOT merely adding a
      // unit to the same building. Only meaningful when addsUnit is true;
      // computed alongside it (see computeDifferentPlace below). Defaults
      // false so a legacy/blank entry never accidentally exempts.
      differentPlace: false,
      lastSeen: '',
      correctedVariants: Object.create(null),
      seenIds: Object.create(null),
      reports: [],
      assignmentCount: 0,
      workAreas: Object.create(null),
      zips: Object.create(null),
      // originalName/correctedName (issue #358): the corrections record's
      // Original Name / Corrected Name columns, carried on the entry so the
      // name-matched advisory tier can read the recipient name behind a
      // SUPPRESSED adds-a-unit mapping. Display text only — never used for
      // address matching. Kept in sync with whichever correction record most
      // recently set correctedKey (see merge() below), the same "latest
      // single-variant wins" discipline correctedDisplay already follows.
      originalName: '',
      correctedName: '',
      // deliveryConfirmedCount (issue #359): count of correction RECORDS
      // whose Delivered Address agreed with the corrected address under
      // deliveryConfirms() above. Tracked under the same seenIds identity as
      // the rest of the correction event, so idempotent re-merge never
      // double-counts it (see merge() below).
      deliveryConfirmedCount: 0,
      // correctionHistory (issue 484): who/when evidence behind this entry,
      // grouped by PERSON (Employee ID) so an operator can tell "one person
      // corrected this 100 times" from "100 different people independently
      // agree" — a much stronger recurrence signal than the bare count
      // above. Internal shape: { [groupKey]: { emp, source, minDate, maxDate,
      // recipients: {[nameKey]: {display, count}}, trackingSeen: {[trk]:
      // true}, trackingSample: [trk,...] (capped) } } — see mergeHistoryRecord
      // and correctionHistory() (the public reader) below for the full
      // design/storage-bounding rationale.
      correctionHistory: Object.create(null),
    };
  }

  // mergeAssignmentRecord(out, rec, normalizeAddress) — folds one Manual
  // Assignment Detail record into the dictionary (issue #301). Keyed by the
  // record's own canonical address: when that key already belongs to a
  // corrections entry, the sighting enriches it directly; otherwise it lands
  // in a standalone observation entry (correctedKey '') that trustedEntries()
  // joins to full-address entries at read time and NEVER surfaces on its own.
  function mergeAssignmentRecord(out, rec, normalizeAddress) {
    const key = normalizeAddress(rec.original);
    if (!key) return;
    let entry = out[key];
    if (!entry) entry = out[key] = blankEntry(rec.original);

    const identity = assignmentIdentity(rec, key);
    if (entry.seenIds[identity]) return; // same export re-loaded — no-op
    entry.seenIds[identity] = true;

    entry.assignmentCount++;
    addReport(entry, 'assignment');
    const source = String(rec.source == null ? '' : rec.source).trim();
    if (source && entry.sources.indexOf(source) === -1) entry.sources.push(source);
    touchLastSeen(entry, rec);

    const workArea = String(rec.workArea == null ? '' : rec.workArea).trim();
    if (workArea) entry.workAreas[workArea] = (entry.workAreas[workArea] || 0) + 1;
    const zip5 = String(rec.postalCode == null ? '' : rec.postalCode).replace(/\D/g, '').slice(0, 5);
    if (zip5.length === 5) entry.zips[zip5] = true;
    // Deliberately NOT touched: count, correctedVariants, correctedKey,
    // ambiguous — an assignment record carries no corrected-address claim.
  }

  // ── Correction history: who/when evidence, grouped by person (issue 484)
  // ─────────────────────────────────────────────────────────────────────
  //
  // HISTORY_TRACKING_SAMPLE_CAP (8): the per-group cap on how many raw
  // tracking numbers are kept for display. Chosen to match the UI's own
  // truncation rule (address-catcher.html: "a group of <=8 packages shows
  // every tracking number; longer shows the capped sample + '...and N
  // more (T total)'") — a group at or under the cap therefore has a
  // COMPLETE sample (nothing to truncate), and a group over the cap has
  // exactly the sample the UI needs before it says "+N more". This is a
  // deliberate storage bound: an address corrected hundreds of times by
  // one person must not persist hundreds of tracking numbers into
  // localStorage (a known real quota constraint in this repo — see
  // docs/adr and the IBNO localStorage-quota lesson).
  const HISTORY_TRACKING_SAMPLE_CAP = 8;

  // historyGroupKey(rec) -> a stable string key grouping correction
  // records by PERSON. Keyed by Employee ID when the record carries one;
  // falls back to a per-Source bucket ('SRC:<source>' or 'SRC:UNKNOWN')
  // when Employee ID is blank, so blank-employee records from different
  // sources (e.g. Scanner vs ITQA) don't collapse into one
  // undifferentiated group — they're still at least distinguished by
  // which system recorded them.
  function historyGroupKey(rec) {
    const emp = String(rec.employeeId == null ? '' : rec.employeeId).trim();
    if (emp) return 'EMP:' + emp;
    const source = String(rec.source == null ? '' : rec.source).trim();
    return 'SRC:' + (source || 'UNKNOWN');
  }

  function blankHistoryGroup(rec) {
    return {
      emp: String(rec.employeeId == null ? '' : rec.employeeId).trim(),
      source: String(rec.source == null ? '' : rec.source).trim(),
      minDate: '',
      maxDate: '',
      recipients: Object.create(null),
      trackingSeen: Object.create(null),
      trackingSample: [],
    };
  }

  // mergeHistoryRecord(entry, rec) — folds one correction record's
  // who/when evidence into entry.correctionHistory. MUST run
  // UNCONDITIONALLY, BEFORE the recordIdentity/seenIds short-circuit in
  // merge() below (this is the migration-backfill rule this repo learned
  // the hard way on issue #478 — see CLAUDE.md's Dictionary migration
  // backfill note): a dictionary persisted before this field shipped
  // already has seenIds populated for every record it has ever seen, so
  // gating history-writing behind that guard would mean an EXISTING
  // dictionary never backfills correction history on re-merge — a silent
  // dead feature for every operator who already has a dictionary built up.
  //
  // Idempotent on its OWN terms even though it runs unconditionally:
  // dedupes by trackingId within the group (trackingSeen), so re-merging
  // the same export twice (or backfilling an old-shape dictionary with the
  // SAME records it was already built from) never inflates a group's
  // count — the count is always Object.keys(trackingSeen).length, i.e.
  // "distinct packages", the same identity granularity the issue asks for
  // ("Counts dedupe by tracking-id identity").
  //
  // trackingSeen itself is NOT capped (every distinct tracking id must be
  // remembered so the dedupe stays correct forever) — only trackingSample
  // (the display list) is capped, mirroring entry.seenIds' own
  // uncapped-by-design precedent elsewhere in this file.
  function mergeHistoryRecord(entry, rec) {
    const trackingId = String(rec.trackingId == null ? '' : rec.trackingId).trim();
    if (!trackingId) return; // no package identity — nothing to attribute history to
    if (!entry.correctionHistory) entry.correctionHistory = Object.create(null);
    const groupKey = historyGroupKey(rec);
    let group = entry.correctionHistory[groupKey];
    if (!group) group = entry.correctionHistory[groupKey] = blankHistoryGroup(rec);

    if (group.trackingSeen[trackingId]) return; // already counted — idempotent re-merge
    group.trackingSeen[trackingId] = true;

    if (group.trackingSample.length < HISTORY_TRACKING_SAMPLE_CAP) group.trackingSample.push(trackingId);

    const date = String(rec.date == null ? '' : rec.date).trim();
    if (date) {
      if (!group.minDate || date < group.minDate) group.minDate = date;
      if (!group.maxDate || date > group.maxDate) group.maxDate = date;
    }

    // recipients: distinct corrected names (falling back to the original
    // name when the record carries no corrected name) with per-name
    // counts, so a group with one dominant recipient reads as uniform and
    // a group spanning many recipients can summarize "N recipients".
    const recipientDisplay = cleanDisplay(rec.correctedName) || cleanDisplay(rec.originalName);
    if (recipientDisplay) {
      const rKey = recipientDisplay.toUpperCase();
      const r = group.recipients[rKey] || (group.recipients[rKey] = { display: recipientDisplay, count: 0 });
      r.count++;
    }
  }

  // displayDate(raw) -> 'YYYY-MM-DD', or the raw string unchanged if it
  // can't be parsed. Reuses parseEntryDate (this file's ONE date-parsing
  // implementation for the corrections report's encoded '1<YY><MMDD>'
  // dates — see that function's doc comment) rather than adding a second,
  // so the history date range decodes exactly the same way lastSeen/aging
  // already do.
  function displayDate(raw) {
    if (!raw) return '';
    const t = parseEntryDate(raw);
    if (t === null) return raw;
    const d = new Date(t);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  // correctionHistory(entry) -> group[] (issue 484's public read). `entry`
  // is a dictionary entry as returned by trustedEntries() /
  // suppressedIdentityEntries() / reviewEntries(), or looked up directly
  // by canonical key. One row per PERSON group (see historyGroupKey
  // above), each: { emp, source, dateRange: {start, end}, count,
  // recipients: [{name, count}, ...] (busiest first), trackingSample:
  // [trk,...] (capped, see HISTORY_TRACKING_SAMPLE_CAP) }. Sorted busiest
  // group first (count desc) so the operator sees the person who corrected
  // this the most, first. dateRange.start/end are decoded to 'YYYY-MM-DD'
  // via displayDate() above — display-ready, not the raw encoded value.
  function correctionHistory(entry) {
    const groups = (entry && entry.correctionHistory) || {};
    return Object.keys(groups).map(function (key) {
      const g = groups[key];
      const count = Object.keys(g.trackingSeen || {}).length;
      const recipients = Object.keys(g.recipients || {})
        .map(function (rk) { return g.recipients[rk]; })
        .sort(function (a, b) { return b.count - a.count; })
        .map(function (r) { return { name: r.display, count: r.count }; });
      return {
        emp: g.emp || '',
        source: g.source || '',
        dateRange: { start: displayDate(g.minDate), end: displayDate(g.maxDate) },
        count: count,
        recipients: recipients,
        trackingSample: (g.trackingSample || []).slice(),
      };
    }).sort(function (a, b) { return b.count - a.count; });
  }

  // merge(dictionary, records) -> new dictionary. Pure — does not mutate the
  // input dictionary; returns a fresh object so callers can persist the
  // result and compare before/after. `records` is an array of
  // { original, corrected, source, date, trackingId } (shape produced by
  // address-catcher.html's corrections-report parse). A record with a blank
  // canonical original or corrected address is skipped — no dictionary entry
  // can be built from it. A record whose identity was already merged
  // (idempotent re-load of the same export) is skipped without incrementing
  // count or touching lastSeen.
  //
  // Dictionary shape: { [canonicalOriginalKey]: {
  //   originalDisplay, correctedDisplay, correctedKey,
  //   count, sources: [..], ambiguous: bool, lastSeen: 'YYYY-MM-DD'|raw date|'',
  //   correctedVariants: { [canonicalCorrectedKey]: displayString },
  //   seenIds: { [recordIdentity]: true }
  // } }
  function merge(dictionary, records) {
    const d = deps();
    const out = cloneDictionary(dictionary);
    const list = Array.isArray(records) ? records : [];

    list.forEach(function (rec) {
      if (!rec) return;
      if (rec.report === 'assignment') {
        mergeAssignmentRecord(out, rec, d.normalizeAddress);
        return;
      }
      const originalKey = d.normalizeAddress(rec.original);
      const correctedKey = d.normalizeAddress(rec.corrected);
      if (!originalKey || !correctedKey) return; // can't build an entry from a blank side

      let entry = out[originalKey];
      if (!entry) {
        entry = out[originalKey] = blankEntry(rec.original);
        entry.correctedDisplay = cleanDisplay(rec.corrected);
        entry.correctedKey = correctedKey;
        entry.addsUnit = computeAddsUnit(rec.original, rec.corrected, d.hasUnitToken);
        entry.differentPlace = computeDifferentPlace(rec.original, rec.corrected, d.stripUnitTokens);
        setEntryNames(entry, rec);
      }

      // Correction history (issue 484): recorded UNCONDITIONALLY, before the
      // seenIds guard below — see mergeHistoryRecord's doc comment for why
      // (the #478 migration-backfill lesson: an existing dictionary already
      // has seenIds populated for every record it's seen, so gating history
      // behind that guard would mean it never backfills).
      mergeHistoryRecord(entry, rec);

      // Idempotent merge: a record identity already recorded for this entry
      // is the same correction event re-observed (e.g. the export re-loaded)
      // — skip it so count/lastSeen aren't double-counted. A never-seen
      // identity still goes through even if it shares a trackingId (a real
      // repeat correction on a different date is a genuinely new event).
      const identity = recordIdentity(rec, originalKey, correctedKey);
      if (entry.seenIds[identity]) return;
      entry.seenIds[identity] = true;

      entry.count++;
      addReport(entry, 'corrections');
      const source = String(rec.source == null ? '' : rec.source).trim();
      if (source && entry.sources.indexOf(source) === -1) entry.sources.push(source);

      touchLastSeen(entry, rec);

      // Delivery-confirmed trust signal (issue #359): computed against THIS
      // record's own corrected/delivered pair (not the entry's possibly
      // multi-variant correctedKey) so a delivery only ever confirms the
      // exact correction it was actually recorded against.
      if (deliveryConfirms(rec.corrected, rec.deliveredAddress, d.normalizeAddress)) {
        entry.deliveryConfirmedCount++;
      }

      entry.correctedVariants[correctedKey] = cleanDisplay(rec.corrected);
      const distinctCorrected = Object.keys(entry.correctedVariants);
      if (distinctCorrected.length > 1) {
        entry.ambiguous = true;
      } else {
        // Still a single distinct corrected key — keep the display/key in
        // sync with the (possibly first-seen) variant so trustedEntries()
        // shows a real corrected address, not a stale one from an earlier
        // differently-cased record.
        entry.correctedKey = correctedKey;
        entry.correctedDisplay = entry.correctedVariants[correctedKey];
        entry.addsUnit = computeAddsUnit(rec.original, rec.corrected, d.hasUnitToken);
        entry.differentPlace = computeDifferentPlace(rec.original, rec.corrected, d.stripUnitTokens);
        setEntryNames(entry, rec);
      }
    });

    return out;
  }

  // computeAddsUnit(originalRaw, correctedRaw, hasUnitToken) -> boolean
  // (issue #342). True when the CORRECTED address carries a unit/suite token
  // that the ORIGINAL lacks — a person-specific fix (the right unit belongs
  // to a recipient, not the street address), so suggesting it for every
  // future package to that street is a categorical false flag. Mappings
  // where the original ALREADY carries a unit (a true per-unit standing fix)
  // are unaffected, even if the corrected side also carries one — the
  // asymmetry (original: no unit, corrected: has unit) is what makes a
  // mapping untrustworthy, not the mere presence of a unit token. Computed
  // on the RAW display strings (never the canonical key, which drops marker
  // tokens entirely — see address-normalize.js's hasUnitToken comment).
  function computeAddsUnit(originalRaw, correctedRaw, hasUnitToken) {
    if (typeof hasUnitToken !== 'function') return false;
    return !hasUnitToken(originalRaw) && hasUnitToken(correctedRaw);
  }

  // computeDifferentPlace(originalRaw, correctedRaw, stripUnitTokens) ->
  // boolean (issue #365, criterion 1 of the standing-business-redirect
  // exemption). True when, after stripping unit/suite tokens from BOTH
  // sides, the corrected address's stripped key still differs from the
  // original's stripped key — i.e. the correction changes the street/city/
  // ZIP, not merely adds a unit onto the same building. Computed on the RAW
  // display strings (stripUnitTokens does its own normalization/folding
  // internally, same discipline as computeAddsUnit above). Only meaningful
  // for addsUnit entries; a mapping that doesn't add a unit doesn't need this
  // exemption path at all (it's already trusted).
  //
  // Real examples (from the issue): `18850 N 56TH ST` -> `2401 W Behrend Dr
  // STE 55` strips to `18850 N 56TH ST` vs `2401 W BEHREND DR` — DIFFERENT
  // place. `1 EASY ST` -> `1 EASY ST UNIT 19` strips to `1 EASY ST` on both
  // sides — SAME place (stays suppressed regardless of count, per Tyler's
  // confirmed false-flag class).
  function computeDifferentPlace(originalRaw, correctedRaw, stripUnitTokens) {
    if (typeof stripUnitTokens !== 'function') return false;
    const originalStripped = stripUnitTokens(originalRaw);
    const correctedStripped = stripUnitTokens(correctedRaw);
    if (!originalStripped || !correctedStripped) return false;
    return originalStripped !== correctedStripped;
  }

  // setEntryNames(entry, rec) (issue #358) — records the corrections record's
  // Original Name / Corrected Name display text on the entry, IF the record
  // carries one (~82% filled in the real export, so many records won't). A
  // blank rec.originalName/correctedName never clobbers a name already
  // recorded on the entry — an earlier record for the same original/
  // corrected pair that DID carry a name stays authoritative rather than
  // being erased by a later, name-blank re-observation of the same mapping.
  // Display text only; never used for address-matching (that stays the
  // canonical-key path in AddressNormalize.normalizeAddress).
  function setEntryNames(entry, rec) {
    const originalName = cleanDisplay(rec.originalName);
    const correctedName = cleanDisplay(rec.correctedName);
    if (originalName) entry.originalName = originalName;
    if (correctedName) entry.correctedName = correctedName;
  }

  const DEFAULT_MIN_COUNT = 1; // pre-#299 behavior: a single occurrence qualifies

  // STANDING-BUSINESS-REDIRECT EXEMPTION (issue #365, follow-up to #342): an
  // addsUnit mapping is EXEMPT from suppression -- trusted again, as a normal
  // match -- when BOTH:
  //   1. differentPlace: stripping unit tokens from both sides, the
  //      corrected address still differs from the original (computed at
  //      merge() time -- see computeDifferentPlace above).
  //   2. Strong, deterministic evidence: count >= EXEMPTION_MIN_COUNT (its
  //      OWN fixed bar, independent of the caller's minCount/live-threshold
  //      option) with a single corrected variant -- i.e. not ambiguous
  //      (ambiguous is already filtered before this check ever runs).
  //
  // Real examples (issue #365, 2026-06-24 export): `18850 N 56TH ST` ->
  // `2401 W Behrend Dr STE 55` (Compass Group, 29x, corroborated) and
  // `34975 N. North Valley Pkwy` -> `2209 W Melinda Ln STE A` (AirFiber
  // WISP, 8x) are standing business redirects -- a wholesale correction that
  // repeats identically, not a person's specific unit guessed onto a shared
  // building. Same-street adds-unit mappings (`1 EASY ST` -> `1 EASY ST UNIT
  // 19`) stay suppressed at ANY count -- that is Tyler's confirmed
  // false-flag class and differentPlace is false for them, so they never
  // reach the count check at all.
  //
  // The bar is fixed at 3, NOT tied to trustedEntries' own minCount option,
  // because minCount governs the live-threshold control for ordinary
  // mappings; the exemption is a categorically stronger claim ("safe to
  // un-suppress a mapping the addsUnit rule would otherwise block") and
  // needs its own independent, non-configurable evidence bar so lowering the
  // live threshold can never accidentally loosen this safety check too.
  const EXEMPTION_MIN_COUNT = 3;

  function isExemptAddsUnit(e) {
    return !!e.differentPlace && e.count >= EXEMPTION_MIN_COUNT;
  }

  // trustedEntries(dictionary, options?) -> entry[]. Only non-ambiguous
  // entries, carrying the canonical original key so a caller
  // (address-match.js) can look up an incoming package's normalized address
  // directly.
  //
  // options:
  //   - minCount (default 1): entries with count below this are excluded.
  //   - recencyWindowDays (default: none/disabled): when set, an entry whose
  //     lastSeen is more than this many days before `asOf` is excluded (aged
  //     out). Omitting this option disables aging entirely — existing
  //     callers that don't pass it keep the pre-#299, no-aging behavior.
  //   - asOf (default: today, ISO 'YYYY-MM-DD'): the reference "now" for the
  //     recency window. Accepts anything `new Date()` parses; tests pass a
  //     fixed ISO date so aging assertions aren't clock-dependent.
  //
  // DAY-GRANULARITY AGING (#338): lastSeen is a day-granular value (the
  // corrections report's `1YYMMDD` date, decoded to UTC midnight by
  // parseEntryDate below), but `asOf` can carry a time-of-day (e.g.
  // `new Date()` at whatever moment trustedEntries() is called) and a caller
  // in any local timezone. Comparing a ms-precision `asOf` against a
  // day-granular lastSeen made the aging boundary drift within the same
  // calendar day — the exact same corrections export produced a different
  // trusted count in the afternoon vs. the evening. Fixed by flooring `asOf`
  // to its UTC calendar date (matching parseEntryDate's own UTC-midnight
  // convention for lastSeen) before computing the cutoff, so only the DATE
  // of `asOf` matters, never the time-of-day or the caller's local timezone.
  // Boundary is explicit and inclusive: an entry last seen exactly
  // `recencyWindowDays` days before `asOf`'s date is still trusted (cutoff
  // day = asOfDay - recencyWindowDays; lastSeenDay >= cutoffDay passes).
  // computeCutoffTime(options) -> epoch ms cutoff, or null (aging disabled).
  // Shared by trustedEntries and suppressedAddsUnitEntries (#358) so both
  // apply the SAME day-granularity aging discipline (#338) rather than two
  // independently-drifting implementations.
  function computeCutoffTime(opts) {
    if (typeof opts.recencyWindowDays !== 'number' || !isFinite(opts.recencyWindowDays)) return null;
    const asOf = opts.asOf ? new Date(opts.asOf) : new Date();
    if (isNaN(asOf.getTime())) return null;
    const asOfDayMs = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
    return asOfDayMs - opts.recencyWindowDays * 24 * 60 * 60 * 1000;
  }

  function passesAging(e, cutoffTime) {
    if (cutoffTime === null) return true; // aging disabled
    // effectiveLastSeenTime already folds in assignment sightings — a
    // recently manually-assigned address is still live evidence.
    if (e.effectiveLastSeenTime === null) return true; // no/unparseable date — fail open
    return e.effectiveLastSeenTime >= cutoffTime;
  }

  // enrichedEntries(dictionary) -> { all, observations } — the shared
  // enrichment base both trustedEntries and suppressedAddsUnitEntries build
  // on: every entry carrying a corrected address, joined with #301
  // assignment-observation evidence. Splitting this out (#358) means the two
  // readers can never drift on how corroboration/workArea/lastSeen are
  // computed.
  function enrichedEntries(dictionary) {
    const d = deps();
    const dict = dictionary || {};
    const all = Object.keys(dict)
      .map(function (key) { return Object.assign({ originalKey: key }, dict[key]); });

    // #301: assignment-only observations (no corrected address — nothing to
    // suggest) are split out and joined onto real correction entries below;
    // they NEVER surface as suggestions themselves.
    const observations = all.filter(function (e) {
      return !e.correctedKey && (e.assignmentCount || 0) > 0;
    });

    const withCorrections = all
      .filter(function (e) { return !!e.correctedKey; })
      .map(function (e) { return enrichWithObservations(e, observations); })
      // disposition (#483): apply / suppress / review — see computeDisposition
      // above. Computed here, once, so every reader (trustedEntries,
      // suppressedIdentityEntries, reviewEntries) shares the identical rule.
      .map(function (e) { return Object.assign({}, e, { disposition: computeDisposition(e, d.normalizeName) }); });

    return withCorrections;
  }

  // isIdentityEntry(e) -> boolean (issue #476, Path A tracer slice of the
  // identity-suppression spec #481). True when the entry's original and
  // corrected canonical keys are the SAME string — a no-op "correction"
  // where AddressNormalize.normalizeAddress (already applied to both sides
  // in merge(), around line 292 above) has collapsed away every difference:
  // byte-identical addresses, or ones differing only by casing,
  // punctuation, ZIP+4, or street-type abbreviation (`Place` vs `PL`, `ST`
  // vs `ST.`). No NEW normalization is performed here — this only compares
  // the keys normalizeAddress already produced. A blank originalKey/
  // correctedKey never counts as identity (guards a legacy/blank entry from
  // matching '' === '').
  function isIdentityEntry(e) {
    return !!e.originalKey && e.originalKey === e.correctedKey;
  }

  // ── Recipient-name-aware disposition (issue #483, Path A of the
  // identity-suppression spec #481) ──────────────────────────────────────
  //
  // trustedEntries()/suppressedIdentityEntries() (#476/#482) treated
  // identity no-ops as a single bucket: original/corrected address collapse
  // to the same canonical key, so ALWAYS safe to suppress. That's wrong when
  // the correction ALSO carries a substantive recipient-name change (e.g.
  // "Kai Yao" -> "Applied Materials" at the same address) — that's not a
  // cosmetic no-op, it's a company/person re-route the operator needs to see,
  // never silently hidden and never silently trusted either.
  //
  // Every enriched entry now carries a three-way `disposition`:
  //   - 'apply'    originalKey !== correctedKey — a genuinely different
  //                address. Name doesn't matter; trustedEntries() is exactly
  //                this set (zero regression from the pre-#483 behavior,
  //                since isIdentityEntry(e) === false is the same condition).
  //   - 'suppress' identity address AND a trivial/no name change — the
  //                pre-#483 suppressedIdentityEntries() behavior, now scoped
  //                by classifyNameChange below instead of being the whole
  //                identity set.
  //   - 'review'   identity address AND a SUBSTANTIVE name change — surfaced
  //                for the operator's call (reviewEntries() below); never
  //                folded into trustedEntries() (not a trusted correction —
  //                the address didn't change) NOR suppressedIdentityEntries()
  //                (not safe to hide — the name did change).
  //
  // NAME-CHANGE CLASSIFICATION reuses AddressNormalize.normalizeName as-is
  // (uppercase, strip punctuation to spaces, collapse whitespace) — no new
  // normalizer is added. classifyNameChange only adds a thin, LOCAL
  // post-processing step (title-stripped token-SET comparison) on top of
  // that existing normalization; normalizeName itself is untouched.
  function classifyNameChange(originalNameRaw, correctedNameRaw, normalizeName) {
    const normOriginal = normalizeName(originalNameRaw);
    const normCorrected = normalizeName(correctedNameRaw);
    if (!normOriginal && !normCorrected) return 'trivial'; // both blank
    if (normOriginal === normCorrected) return 'trivial'; // identical after normalizeName
    if (!normOriginal || !normCorrected) return 'trivial'; // pure add or pure remove of a name
    // Both sides non-empty and differ as plain normalized strings. Before
    // calling this substantive, check a TOKEN-SET comparison (order-
    // independent, honorific-title-blind): this catches the labeled case
    // "CHRISTENSEN, TROY" -> "Dr. Troy Christensen" — normalizeName folds
    // the comma to a space (no reordering), so the two strings land as
    // "CHRISTENSEN TROY" vs "DR TROY CHRISTENSEN": same two name tokens,
    // reordered, plus one added honorific ("DR"). That's a reformat, not a
    // different recipient — Tyler's confirmed labeled case requires
    // 'suppress' here, not 'review'. Stripping a small, fixed set of English
    // honorific titles before the set compare (DR/MR/MRS/MS/MISS/PROF/MX) is
    // the narrowest rule that satisfies the labeled case without weakening
    // "Kai Yao" -> "Applied Materials" (wholly different token sets even
    // after stripping — correctly stays substantive).
    if (nameTokenSetKey(normOriginal) === nameTokenSetKey(normCorrected)) return 'trivial';
    return 'substantive';
  }

  const HONORIFIC_TITLES = { DR: 1, MR: 1, MRS: 1, MS: 1, MISS: 1, PROF: 1, MX: 1 };

  // nameTokenSetKey(normalized) -> a canonical, order-independent key for a
  // normalizeName()'d string: split on spaces, drop honorific titles, sort,
  // rejoin. Two names that reduce to the same key are the same person's name
  // reformatted/reordered, not a different name.
  function nameTokenSetKey(normalized) {
    const tokens = normalized ? normalized.split(' ').filter(Boolean) : [];
    return tokens.filter(function (t) { return !HONORIFIC_TITLES[t]; }).sort().join('|');
  }

  // computeDisposition(e, normalizeName) -> 'apply' | 'suppress' | 'review'.
  // See the disposition doc block above for the full rule.
  function computeDisposition(e, normalizeName) {
    if (!isIdentityEntry(e)) return 'apply';
    const nameClass = classifyNameChange(e.originalName, e.correctedName, normalizeName);
    return nameClass === 'trivial' ? 'suppress' : 'review';
  }

  function trustedEntries(dictionary, options) {
    const opts = options || {};
    const minCount = typeof opts.minCount === 'number' ? opts.minCount : DEFAULT_MIN_COUNT;
    const cutoffTime = computeCutoffTime(opts);

    return enrichedEntries(dictionary)
      .filter(function (e) { return !e.ambiguous; })
      // addsUnit entries are excluded UNLESS they qualify for the
      // standing-business-redirect exemption (issue #365) -- see
      // isExemptAddsUnit above. A non-addsUnit entry is unaffected either way.
      .filter(function (e) { return !e.addsUnit || isExemptAddsUnit(e); })
      // identity no-op entries are excluded (issue #476) -- see
      // isIdentityEntry above. Suppressed separately via
      // suppressedIdentityEntries() below, mirroring the addsUnit/
      // suppressedAddsUnitEntries precedent: a separate pile, never mixed
      // into trustedEntries(). #483: this is exactly disposition === 'apply'
      // (originalKey !== correctedKey) -- filtering on disposition here keeps
      // trustedEntries() byte-for-byte the pre-#483 apply set, since name
      // never affects a genuinely different address's disposition.
      .filter(function (e) { return e.disposition === 'apply'; })
      .filter(function (e) { return e.count >= minCount; })
      .filter(function (e) { return passesAging(e, cutoffTime); })
      // Delivery-confirmed trust signal (issue #359): a stronger trust
      // signal than raw seen-count, so it's the PRIMARY sort key ahead of
      // count -- a delivery-confirmed mapping seen fewer times still sorts
      // above an unconfirmed mapping seen more times. Membership/suppression
      // (the filters above) are entirely unaffected -- this only reorders.
      .sort(function (a, b) {
        if (a.deliveryConfirmed !== b.deliveryConfirmed) return a.deliveryConfirmed ? -1 : 1;
        return b.count - a.count;
      });
  }

  // suppressedAddsUnitEntries(dictionary, options?) -> entry[] (issue #358).
  // The counterpart to trustedEntries() for the name-matched advisory tier:
  // returns entries that ARE addsUnit-suppressed (never trustedEntries
  // output, per #342 — no regression there) but that carry BOTH an
  // originalName and correctedName recorded from the corrections report, so
  // the caller (AddressMatch.matchNameAdvisories) has something to
  // conservatively compare against today's package's LABEL_FIRM_NAME. An
  // addsUnit entry that is ALSO ambiguous is excluded (per #342 discipline,
  // ambiguous is disqualifying on its own regardless of addsUnit). Same
  // minCount/aging options as trustedEntries, applied identically — an
  // advisory built on a stale or one-off mapping is no more trustworthy than
  // a stale trusted suggestion would be.
  //
  // EXEMPTED ENTRIES ARE EXCLUDED HERE TOO (issue #365): an addsUnit entry
  // that qualifies for the standing-business-redirect exemption is no longer
  // "suppressed" -- it's a normal trustedEntries() match now (see
  // isExemptAddsUnit above) -- so it must stop appearing in this advisory
  // pool as well. Otherwise an exempted mapping would double-surface: once
  // as a trusted match, once as a "verify this" advisory, which is exactly
  // the double-surfacing the issue's acceptance criteria rules out.
  function suppressedAddsUnitEntries(dictionary, options) {
    const opts = options || {};
    const minCount = typeof opts.minCount === 'number' ? opts.minCount : DEFAULT_MIN_COUNT;
    const cutoffTime = computeCutoffTime(opts);

    return enrichedEntries(dictionary)
      .filter(function (e) { return !e.ambiguous; })
      .filter(function (e) { return !!e.addsUnit; })
      .filter(function (e) { return !isExemptAddsUnit(e); })
      .filter(function (e) { return !!(e.originalName && e.correctedName); })
      .filter(function (e) { return e.count >= minCount; })
      .filter(function (e) { return passesAging(e, cutoffTime); })
      .sort(function (a, b) { return b.count - a.count; });
  }

  // suppressedIdentityEntries(dictionary, options?) -> entry[] (issue #476,
  // Path A tracer slice of the identity-suppression spec #481; narrowed in
  // #483). The counterpart to trustedEntries() for identity no-op
  // "corrections" — entries where isIdentityEntry(e) is true (original and
  // corrected keys are the same canonical string; see isIdentityEntry above)
  // AND the recorded recipient-name change (if any) is trivial (disposition
  // === 'suppress'; see computeDisposition above). #483 splits what used to
  // be the WHOLE identity set into two piles: this one (safe to hide) and
  // reviewEntries() below (identity address but a SUBSTANTIVE name change —
  // surfaced, not hidden). These are EXCLUDED from trustedEntries() and
  // surfaced here instead, so a UI ticket (#482) can render the auditable
  // pile — same discipline as suppressedAddsUnitEntries (#358): a separate
  // pile, never mixed into trustedEntries() or its consumers. An identity
  // entry that is ALSO ambiguous is excluded (ambiguous is disqualifying on
  // its own, regardless of the identity shape of whichever variant happened
  // to be seen last). Same minCount/aging options as trustedEntries, applied
  // identically.
  function suppressedIdentityEntries(dictionary, options) {
    const opts = options || {};
    const minCount = typeof opts.minCount === 'number' ? opts.minCount : DEFAULT_MIN_COUNT;
    const cutoffTime = computeCutoffTime(opts);

    return enrichedEntries(dictionary)
      .filter(function (e) { return !e.ambiguous; })
      .filter(function (e) { return e.disposition === 'suppress'; })
      .filter(function (e) { return e.count >= minCount; })
      .filter(function (e) { return passesAging(e, cutoffTime); })
      .sort(function (a, b) { return b.count - a.count; });
  }

  // reviewEntries(dictionary, options?) -> entry[] (issue #483, Path A of the
  // identity-suppression spec #481). The third disposition pile: an identity
  // no-op address (originalKey === correctedKey — nothing about WHERE this
  // ships changed) whose recorded recipient-name change is SUBSTANTIVE
  // (disposition === 'review'; see classifyNameChange/computeDisposition
  // above) — e.g. "Kai Yao" -> "Applied Materials" at the same address. Never
  // folded into trustedEntries() (the address didn't change, so it's not a
  // correction to apply) NOR suppressedIdentityEntries() (the name DID
  // change, so it isn't safe to hide) — surfaced on its own so an operator
  // can make the call. Same ambiguous/minCount/aging discipline as the other
  // two readers.
  function reviewEntries(dictionary, options) {
    const opts = options || {};
    const minCount = typeof opts.minCount === 'number' ? opts.minCount : DEFAULT_MIN_COUNT;
    const cutoffTime = computeCutoffTime(opts);

    return enrichedEntries(dictionary)
      .filter(function (e) { return !e.ambiguous; })
      .filter(function (e) { return e.disposition === 'review'; })
      .filter(function (e) { return e.count >= minCount; })
      .filter(function (e) { return passesAging(e, cutoffTime); })
      .sort(function (a, b) { return b.count - a.count; });
  }

  // pickDominantArea(workAreas) -> { area, count, total } (issue #448). The
  // MAINLY ASSIGNED AREA is the dominant (most-sighted) work area, not
  // necessarily unanimous — CONTEXT.md's Mainly Assigned Area glossary term
  // is explicit that this is presented "with its assignment tally as
  // evidence... never as gospel," which is a deliberate WIDENING of the
  // pre-#448 "conflicting areas blank the display" discipline (workArea used
  // to require unanimity, or come back ''). The tally (workAreaTally,
  // returned alongside on the entry — see enrichWithObservations) is what
  // keeps this honest: the caller renders "Area 401 · 9 of 11" for a
  // non-unanimous area rather than a bare number that reads as certain.
  //
  // Tie-break: JS objects with integer-like string keys (area codes are
  // always numeric, e.g. "401") iterate in ascending numeric order
  // regardless of insertion order (ECMA-262 OrdinaryOwnPropertyKeys) — so
  // scanning Object.keys(workAreas) in order and keeping the FIRST area to
  // reach the current max count deterministically resolves a tie to the
  // LOWEST-numbered area, every time, on any engine. Documented rather than
  // left implicit so a future refactor doesn't accidentally make this
  // order-dependent on insertion order instead.
  function pickDominantArea(workAreas) {
    const areas = Object.keys(workAreas);
    let area = '';
    let count = 0;
    let total = 0;
    areas.forEach(function (a) {
      const c = workAreas[a] || 0;
      total += c;
      if (c > count) { count = c; area = a; }
    });
    return { area: area, count: count, total: total };
  }

  // enrichWithObservations(entry, observations) -> entry with the #301
  // evidence fields computed: corroborated, workArea, assignmentCount, and
  // effectiveLastSeenTime (for aging). Joins any observation whose canonical
  // key corroborates this entry's original or corrected key (see
  // observationKeyMatches for the conservative rule).
  function enrichWithObservations(entry, observations) {
    const reports = (entry.reports || (entry.count > 0 ? ['corrections'] : [])).slice();
    const workAreas = Object.assign(Object.create(null), entry.workAreas || {});
    let assignmentCount = entry.assignmentCount || 0;
    const lastSeenTimes = [parseEntryDate(entry.lastSeen)];

    observations.forEach(function (o) {
      const zips = Object.keys(o.zips || {});
      const hits = observationKeyMatches(entry.originalKey, o.originalKey, zips) ||
        observationKeyMatches(entry.correctedKey, o.originalKey, zips);
      if (!hits) return;
      if (reports.indexOf('assignment') === -1) reports.push('assignment');
      assignmentCount += o.assignmentCount || 0;
      Object.keys(o.workAreas || {}).forEach(function (area) {
        workAreas[area] = (workAreas[area] || 0) + o.workAreas[area];
      });
      lastSeenTimes.push(parseEntryDate(o.lastSeen));
    });

    // Mainly Assigned Area + full tally (issue #448): dominant area plus
    // its evidence, so a caller can render both "Area 401" (unanimous) and
    // "Area 401 · 9 of 11" (non-unanimous, still the best evidence, never
    // gospel) from the SAME fields without re-deriving the tally itself.
    const dominant = pickDominantArea(workAreas);
    const times = lastSeenTimes.filter(function (t) { return t !== null; });
    return Object.assign({}, entry, {
      reports: reports,
      corroborated: reports.indexOf('corrections') !== -1 && reports.indexOf('assignment') !== -1,
      workArea: dominant.area,
      workAreaTally: Object.assign({}, workAreas),
      workAreaTotal: dominant.total,
      workAreaCount: dominant.count,
      assignmentCount: assignmentCount,
      effectiveLastSeenTime: times.length ? Math.max.apply(null, times) : null,
      // Delivery-confirmed trust signal (issue #359): true when at least one
      // merged correction record's Delivered Address agreed with its
      // corrected address (see deliveryConfirms() above / merge()). Defaults
      // to 0 (not "confirmed false", just "unknown/none seen") for a
      // dictionary entry persisted before this slice — same discipline as
      // the reports/assignmentCount defaulting in cloneDictionary.
      deliveryConfirmedCount: entry.deliveryConfirmedCount || 0,
      deliveryConfirmed: (entry.deliveryConfirmedCount || 0) > 0,
    });
  }

  // observationKeyMatches(entryKey, obsKey, obsZips) — the conservative
  // cross-report join (#301): TRUE only when the keys are byte-equal, or the
  // entry key begins with the observation key as a whole leading token run
  // AND one of the observation's ZIP5s appears as a whole token in the entry
  // key. The prefix case covers the real report shape (assignment ADDRESS is
  // street-only; corrections addresses carry city/state/ZIP). No ZIP, no
  // prefix join — bias to miss, never to a wrong fold.
  function observationKeyMatches(entryKey, obsKey, obsZips) {
    if (!entryKey || !obsKey) return false;
    if (entryKey === obsKey) return true;
    if (!obsZips.length) return false;
    if (entryKey.lastIndexOf(obsKey + ' ', 0) !== 0) return false;
    return obsZips.some(function (zip) {
      // Whole-token only: ' 85050 ' mid-key or ' 85050' at the end — never a
      // substring of a longer number.
      return entryKey.indexOf(' ' + zip + ' ') !== -1 ||
        entryKey.slice(-(zip.length + 1)) === ' ' + zip;
    });
  }

  // parseEntryDate(raw) -> epoch ms, or null if unparseable. Handles:
  //   - the Address Corrections Report's encoded '1<YY><MMDD>' Date column
  //     (e.g. '1260612' -> 2026-06-12, per CONTEXT.md) — this is the format
  //     that actually flows through in production;
  //   - plain ISO-ish strings ('2026-06-24'), used by tests and any future
  //     caller that already has a normal date;
  //   - falls back to Date.parse for anything else.
  // Deliberately forgiving so an unrecognized date string doesn't crash
  // aging — it just fails open (keeps the entry active) rather than silently
  // hiding evidence.
  function parseEntryDate(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;

    const encoded = /^1(\d{2})(\d{2})(\d{2})$/.exec(s);
    if (encoded) {
      const year = 2000 + Number(encoded[1]);
      const month = Number(encoded[2]);
      const day = Number(encoded[3]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        const t = Date.UTC(year, month - 1, day);
        if (!isNaN(t)) return t;
      }
      // Falls through to generic parsing if the digits don't form a
      // plausible month/day (e.g. a coincidental 7-digit tracking-style id).
    }

    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (iso) {
      const t = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
      return isNaN(t) ? null : t;
    }
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  }

  // cloneHistoryGroups(groups) -> deep clone of entry.correctionHistory
  // (issue 484), same discipline as cloneDictionary's other per-entry
  // Object.create(null) maps below. A legacy entry with no
  // correctionHistory at all (persisted before this field shipped)
  // defaults to {} — mergeHistoryRecord backfills it on next merge (see
  // that function's doc comment).
  function cloneHistoryGroups(groups) {
    const src = groups || {};
    const out = Object.create(null);
    Object.keys(src).forEach(function (key) {
      const g = src[key] || {};
      const recipients = Object.create(null);
      Object.keys(g.recipients || {}).forEach(function (rk) {
        const r = g.recipients[rk] || {};
        recipients[rk] = { display: r.display || '', count: r.count || 0 };
      });
      out[key] = {
        emp: g.emp || '',
        source: g.source || '',
        minDate: g.minDate || '',
        maxDate: g.maxDate || '',
        recipients: recipients,
        trackingSeen: Object.assign(Object.create(null), g.trackingSeen || {}),
        trackingSample: (g.trackingSample || []).slice(),
      };
    });
    return out;
  }

  function cloneDictionary(dictionary) {
    const src = dictionary || {};
    const out = Object.create(null);
    Object.keys(src).forEach(function (key) {
      const e = src[key];
      out[key] = {
        originalDisplay: e.originalDisplay,
        correctedDisplay: e.correctedDisplay,
        correctedKey: e.correctedKey,
        count: e.count,
        sources: (e.sources || []).slice(),
        ambiguous: !!e.ambiguous,
        addsUnit: !!e.addsUnit,
        // #365 field, defaulted false for dictionaries persisted before this
        // slice — a legacy entry has no recorded differentPlace verdict yet,
        // and false means "not exempt" (stays suppressed until re-merged
        // recomputes it), the safe fail-closed default for a mis-route
        // hazard module.
        differentPlace: !!e.differentPlace,
        lastSeen: e.lastSeen || '',
        correctedVariants: Object.assign(Object.create(null), e.correctedVariants || {}),
        seenIds: Object.assign(Object.create(null), e.seenIds || {}),
        // #301 fields, defaulted for dictionaries persisted before slice 5:
        // a legacy entry was built solely from the corrections report, so a
        // missing `reports` on a counted entry means ['corrections'].
        reports: Array.isArray(e.reports) ? e.reports.slice() : (e.count > 0 ? ['corrections'] : []),
        assignmentCount: typeof e.assignmentCount === 'number' ? e.assignmentCount : 0,
        workAreas: Object.assign(Object.create(null), e.workAreas || {}),
        zips: Object.assign(Object.create(null), e.zips || {}),
        // #358 fields, defaulted '' for dictionaries persisted before this
        // slice — a legacy entry simply has no recorded name yet.
        originalName: e.originalName || '',
        correctedName: e.correctedName || '',
        // #359 field, defaulted 0 for dictionaries persisted before this
        // slice — a legacy entry simply has no recorded delivery-confirmation
        // evidence yet (not "confirmed false", just "unknown/none seen").
        deliveryConfirmedCount: typeof e.deliveryConfirmedCount === 'number' ? e.deliveryConfirmedCount : 0,
        // correctionHistory (issue 484), defaulted {} for dictionaries
        // persisted before this slice — a legacy entry has no recorded
        // who/when groups yet; mergeHistoryRecord backfills them the next
        // time this entry's records are re-merged (see that function's doc
        // comment for why this is safe/required to run unconditionally).
        correctionHistory: cloneHistoryGroups(e.correctionHistory),
      };
    });
    return out;
  }

  // cleanDisplay(raw) -> trimmed, whitespace-collapsed display string
  // (title-preserving — unlike normalizeAddress, this keeps the original
  // casing/punctuation for what the human sees on screen).
  function cleanDisplay(raw) {
    return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  }

  return {
    merge: merge,
    trustedEntries: trustedEntries,
    suppressedAddsUnitEntries: suppressedAddsUnitEntries,
    suppressedIdentityEntries: suppressedIdentityEntries,
    // reviewEntries (#483): identity address + substantive recipient-name
    // change — surfaced for the operator's call, neither applied nor hidden.
    reviewEntries: reviewEntries,
    // correctionHistory (issue 484): who/when evidence behind a dictionary
    // entry, grouped by person (Employee ID) — see its doc comment above.
    correctionHistory: correctionHistory,
    // classifyNameChange (#483): exported so the name-comparison rule (used
    // by computeDisposition above) has direct unit coverage independent of
    // building a full dictionary entry through merge().
    classifyNameChange: classifyNameChange,
    // Exported for the Address Catcher's Raw-Data Viewer filtered-jump
    // (issue #449): the viewer must select raw Manual Assignment Detail rows
    // with the SAME conservative street+ZIP5 join this module uses to fold
    // observations into an entry — a raw substring of the display string is
    // NOT that join (real 2026-06-11 divergence: dictionary original
    // "16340 WSANTA FE DR ..." fused vs raw ADDRESS "16340 W SANTA FE DR"
    // spaced — textually different, same entry, empty viewer). Exporting the
    // one implementation keeps the two joins from ever drifting apart.
    observationKeyMatches: observationKeyMatches,
  };
});
