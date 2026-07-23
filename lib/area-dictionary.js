'use strict';

// Area Dictionary — the standalone address -> Mainly Assigned Area knowledge
// (issue #451, slice 5 of #446). Deliberately a SEPARATE module from
// lib/address-dictionary.js (Tyler's module-decision, confirmed in
// planning): the Address Correction Dictionary answers "what should this
// address BE" (learned from the Address Corrections Report, gated on a
// correction ever existing); this module answers "what AREA does this
// address belong to" (learned from the Manual Assignment Detail at IB Scan
// report alone) and is checked against EVERY inbound package, not just
// correction matches — see CONTEXT.md's Area Dictionary glossary entry.
//
// Keying (mandatory, per the calibration proof — see
// reports/analysis/misroute-calibration.js's streetKey()): Manual Assignment
// Detail's ADDRESS column is usually street-only with the ZIP in a separate
// POSTAL CODE column, while the Inbound and Van Scans report composes a full
// LABEL_ADDRESS1/CITY/STATE/POSTAL_CODE string. Keying on the whole composed
// address string gives ZERO matches between the two reports (proven in the
// 2026-07-07/2026-07-08 calibration runs). streetKey() below is the SAME
// approach the calibration script used (normalized street line + ZIP5),
// reusing AddressNormalize.normalizeAddress rather than reinventing folding.
//
// Misroute Trigger (RECALIBRATED — issue #478, spec #477, map #469; ADR-0019).
// Verified against the real 2026-07-08 exports. A flag fires when BOTH:
//   (1) the address's dominant (Mainly Assigned) area holds >=80% of
//       assignment sightings (MIN_DOMINANCE_PCT); AND
//   (2) the address was manually reassigned to that dominant area on >=2
//       DISTINCT calendar days (MIN_DISTINCT_DAYS, SCAN_DT) — a recurring
//       wrong-plan pocket, not a stale one-off. Two days, not three: the real
//       440->807 Mayo/Princess cluster only reaches two days in the report's
//       ~11-day window.
// ...AND the flag survives the Load Wall exclusion below. Neither the raw
// sighting count nor today's inbound volume is a trigger input anymore.
//
// LOAD WALL EXCLUSION (why the recalibration exists): the operation reassigns
// a fixed set of areas daily to balance the physical load wall
// (LOAD_WALL_AREAS = 1111,1122,1133,1144,4411,4422,4433,4444). A package
// flexed between wall positions is NOT a missort. If EITHER the dominant area
// or today's scanned area is a Load Wall area, no flag. The list is
// hand-maintained (not inferred from the numeric pattern) so the wall roster
// can change without touching detection logic — update LOAD_WALL_AREAS below.
//
// This replaces the old two-track trigger (well-evidenced track-a OR
// thin-history + today's-mass-divergence track-b, LOCKED 2026-07-08 in #451).
// On the 2026-07-08 sort that trigger raised 38 cards / ~1,151 packages and
// FedEx's own compliance data confirmed ~35 of them fine (~99% noise by
// volume): load-wall flexes (e.g. 7700 W Arrowhead, 1144<->4411) and stale
// single-day one-offs. Track-b WAS that false-positive engine; it is gone.
//
// FedEx COMPLIANCE_FLAG is deliberately NOT a detection signal: every
// wrong-plan case in scope is Compliant per FedEx (a wrong SAD MAP plot is
// still "Compliant"), so the flag rests entirely on the strength of the
// manual reassignment history. Physical misloads (Non-Compliant) are out of
// scope — the IBNO Coder handles those; they mean the package is not ours.
//
// No assigner names are ever stored — only area codes, counts, and dates
// (dates only to support aging), per issue #451's hard constraint. The
// who/assigned-by detail lives in the Raw-Data Viewer's raw rows, never
// here. Device-local persistence (ADR-0016's pattern) is owned by the page
// (address-catcher.html), same as lib/address-dictionary.js's dictionary —
// this module is pure and knows nothing about localStorage/IndexedDB.
//
// Dual-loadable with no build step:
// - Browser: window.AreaDictionary
// - Node: require('./lib/area-dictionary')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AreaDictionary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function deps() {
    const AddressNormalize = (root && root.AddressNormalize) ||
      (typeof require === 'function' ? require('./address-normalize') : null);
    if (!AddressNormalize) throw new Error('AreaDictionary dependency unavailable (need AddressNormalize)');
    return { normalizeAddress: AddressNormalize.normalizeAddress };
  }

  // Misroute Trigger constants (see module comment above; ADR-0019).
  const MIN_DOMINANCE_PCT = 0.8;   // dominant area must hold >=80% of sightings
  const MIN_DISTINCT_DAYS = 2;     // ...reassigned on >=2 distinct SCAN_DT days
  // Load Wall areas — hand-maintained (NOT inferred from the numeric pattern).
  // The operation reassigns these daily to balance the physical load wall; a
  // flex between them is never a missort. Update this list when the wall
  // roster changes. A flag is excluded if EITHER the dominant area or today's
  // scanned area is in this set. (issue #478 / ADR-0019.)
  const LOAD_WALL_AREAS = ['1111', '1122', '1133', '1144', '4411', '4422', '4433', '4444'];
  const LOAD_WALL_SET = new Set(LOAD_WALL_AREAS);
  function isLoadWall(area) { return LOAD_WALL_SET.has(String(area == null ? '' : area).trim()); }
  // Default aging window matches the Address Correction Dictionary /
  // ADR-0016's recencyWindowDays (30 days) — one aging discipline across the
  // Address Catcher's two dictionaries.
  const DEFAULT_RECENCY_WINDOW_DAYS = 30;

  function zip5(raw) {
    return String(raw == null ? '' : raw).replace(/\D/g, '').slice(0, 5);
  }

  // streetKey(rawAddress, postalCode) -> 'NORMALIZED STREET LINE|ZIP5'.
  // Mirrors reports/analysis/misroute-calibration.js's streetKey() verbatim
  // (same approach, not a reinvention): normalize, strip a trailing
  // "CITY ST ZIP[+4]" tail if the composed inbound string carries one, then
  // key on the normalized street line + ZIP5. A ZIP embedded in the raw
  // string is used as a fallback when no explicit postalCode is given.
  function streetKey(rawAddress, postalCode) {
    const d = deps();
    let n = d.normalizeAddress(rawAddress || '');
    n = n.replace(/\b[A-Z]{2}\s+\d{2,}(?:\s+\d+)?$/, '').trim();
    const z = zip5(postalCode) || (String(rawAddress == null ? '' : rawAddress).match(/\b(\d{5})\b/) || [])[1] || '';
    return n + '|' + z;
  }

  function cleanDisplay(raw) {
    return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  }

  // isStreetless(key) -> true for a 'NORMALIZED STREET|ZIP5' key whose street
  // line is blank (e.g. '|85027'). Such a key is populated in the dictionary
  // (ZIP-only, for calibration parity) but must NEVER be JOINED against —
  // ZIP-only matching folds every unaddressed package in a ZIP onto one entry
  // (bias to miss, never to a wrong fold). Single source of truth for the
  // street-less test, shared by matchInbound's inboundKey and
  // AddressCatcherSession.areaEvidence (issue #479) so the format lives once.
  function isStreetless(key) {
    return String(key == null ? '' : key).charAt(0) === '|';
  }

  function blankEntry(addressDisplay, postalCode) {
    return {
      addressDisplay: cleanDisplay(addressDisplay),
      postalCode: zip5(postalCode),
      workAreas: Object.create(null),
      // workAreaDays[area] = { <dayKey>: true } — distinct calendar days the
      // address was reassigned to each area (issue #478's >=2-days trigger).
      // A plain object (not a Set) so the dictionary stays JSON-serializable
      // for the page's localStorage persistence.
      workAreaDays: Object.create(null),
      lastSeen: '',
      seenIds: Object.create(null),
    };
  }

  // assignmentIdentity(rec, key) -> stable identity for one assignment
  // sighting, so merge() is idempotent (re-loading the same export is a
  // no-op). Includes the work area (the same trk#/date can legitimately
  // carry two distinct manual assignments — masterlist.js's
  // dedupeAssignments keeps those apart too).
  function assignmentIdentity(rec, key) {
    const trackingId = String(rec.trackingId == null ? '' : rec.trackingId).trim();
    const date = String(rec.date == null ? '' : rec.date).trim();
    const workArea = String(rec.workArea == null ? '' : rec.workArea).trim();
    return [trackingId, date, key, workArea].join('|');
  }

  // touchLastSeen(entry, rec) — keep the NEWER of the two dates by PARSED
  // time, never by string comparison: SCAN_DT is 'M/D/YYYY', which orders
  // wrongly as text across a year boundary ('12/30/2025' > '01/02/2026'
  // lexically), so a lexical compare would freeze lastSeen on the December
  // sighting and passesAging() would silently expire the entry a year early
  // (a missed flag with no error). Fail-open discipline when a side is
  // unparseable: an unparseable incoming date never replaces a stored one;
  // a parseable incoming date always replaces an unparseable stored one;
  // both unparseable keeps the existing value.
  function touchLastSeen(entry, rec) {
    const recDate = String(rec.date == null ? '' : rec.date).trim();
    if (!recDate) return;
    if (!entry.lastSeen) { entry.lastSeen = recDate; return; }
    const recTime = parseEntryDate(recDate);
    if (recTime === null) return; // unparseable incoming — keep what we have
    const curTime = parseEntryDate(entry.lastSeen);
    if (curTime === null || recTime > curTime) entry.lastSeen = recDate;
  }

  function cloneDictionary(dictionary) {
    const src = dictionary || {};
    const out = Object.create(null);
    Object.keys(src).forEach(function (key) {
      const e = src[key] || {};
      const workAreaDays = Object.create(null);
      const srcDays = e.workAreaDays || {};
      Object.keys(srcDays).forEach(function (a) {
        workAreaDays[a] = Object.assign(Object.create(null), srcDays[a] || {});
      });
      out[key] = {
        addressDisplay: e.addressDisplay || '',
        postalCode: e.postalCode || '',
        workAreas: Object.assign(Object.create(null), e.workAreas || {}),
        workAreaDays: workAreaDays,
        lastSeen: e.lastSeen || '',
        seenIds: Object.assign(Object.create(null), e.seenIds || {}),
      };
    });
    return out;
  }

  // merge(dictionary, records) -> new dictionary. Pure — never mutates the
  // input. records: assignment sightings, one per Manual Assignment Detail
  // row: { address (or `original`, matching AddressCatcherSession's
  // parseAssignmentRecords shape), postalCode, workArea, date, trackingId }.
  // A record with no work area contributes nothing (an assignment closure
  // row with a blank area can't teach the dictionary anything), as does one
  // with neither a street line nor a ZIP (key '|' — unkeyable). A record
  // with a ZIP but a BLANK street line IS keyed ('|85027'-style) so the
  // dictionary's population matches the calibration's exactly (1,480
  // distinct keys on the 2026-07-08 export, 35 of them street-less) — but
  // matchInbound() below never JOINS a street-less key: a ZIP-only match
  // would fold every unaddressed package in a ZIP onto one entry. Bias to
  // miss, never to a wrong fold (same discipline as
  // AddressDictionary.observationKeyMatches). Deterministic, idempotent
  // re-merge via seenIds.
  function merge(dictionary, records) {
    const out = cloneDictionary(dictionary);
    (Array.isArray(records) ? records : []).forEach(function (rec) {
      if (!rec) return;
      const address = rec.address != null ? rec.address : rec.original;
      const workArea = String(rec.workArea == null ? '' : rec.workArea).trim();
      if (!workArea) return;
      const key = streetKey(address, rec.postalCode);
      if (!key || key === '|') return; // neither street nor ZIP -> unkeyable
      let entry = out[key];
      if (!entry) entry = out[key] = blankEntry(address, rec.postalCode);
      if (!entry.workAreaDays) entry.workAreaDays = Object.create(null); // pre-#478 entry
      // Record the distinct calendar day BEFORE the seenIds guard. Day-recording
      // is idempotent (a set), so re-seeing a sighting is harmless — and doing
      // it ahead of the guard BACKFILLS workAreaDays for dictionaries built by
      // pre-#478 code (populated seenIds, empty workAreaDays): the next daily
      // MAD re-drop restores distinct days, so the recalibrated trigger isn't
      // silently dead on existing dictionaries after upgrade (issue #478).
      const dk = dayKey(rec.date);
      if (dk) {
        const days = entry.workAreaDays[workArea] || (entry.workAreaDays[workArea] = Object.create(null));
        days[dk] = true;
      }
      const identity = assignmentIdentity(rec, key);
      if (entry.seenIds[identity]) return; // same sighting re-loaded -> don't double-count
      entry.seenIds[identity] = true;
      entry.workAreas[workArea] = (entry.workAreas[workArea] || 0) + 1;
      touchLastSeen(entry, rec);
    });
    return out;
  }

  // pickDominantArea(workAreas) -> { area, count, total, areaCount }. Same
  // tie-break discipline as lib/address-dictionary.js's pickDominantArea
  // (integer-keyed objects iterate ascending numeric order, so the first
  // area to reach the current max deterministically wins ties at the
  // LOWEST-numbered area) — duplicated here (not imported) because this
  // module is deliberately standalone, per the module decision.
  function pickDominantArea(workAreas) {
    const areas = Object.keys(workAreas || {});
    let area = '', count = 0, total = 0;
    areas.forEach(function (a) {
      const c = workAreas[a] || 0;
      total += c;
      if (c > count) { count = c; area = a; }
    });
    return { area: area, count: count, total: total, areaCount: areas.length };
  }

  // parseEntryDate(raw) -> epoch ms or null. Handles the Manual Assignment
  // Detail SCAN_DT shape ('MM/DD/YYYY'), the corrections '1<YY><MMDD>'
  // encoding (in case a caller ever threads that date shape through), plain
  // ISO strings (tests), and falls back to Date.parse. Fails OPEN (returns
  // null -> treated as "keep it") on anything unparseable, same discipline
  // as lib/address-dictionary.js's parseEntryDate.
  function parseEntryDate(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;

    const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (mdy) {
      const t = Date.UTC(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2]));
      if (!isNaN(t)) return t;
    }

    const encoded = /^1(\d{2})(\d{2})(\d{2})$/.exec(s);
    if (encoded) {
      const year = 2000 + Number(encoded[1]);
      const month = Number(encoded[2]);
      const day = Number(encoded[3]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        const t = Date.UTC(year, month - 1, day);
        if (!isNaN(t)) return t;
      }
    }

    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (iso) {
      const t = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
      return isNaN(t) ? null : t;
    }
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  }

  // dayKey(raw) -> a stable per-calendar-day key for distinct-day counting.
  // Normalizes via parseEntryDate to a UTC 'YYYY-MM-DD' so '7/8/2026' and
  // '07/08/2026' collapse to one day; falls back to the trimmed raw string
  // when unparseable (bias to KEEP the sighting's day rather than drop it).
  function dayKey(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    const t = parseEntryDate(s);
    if (t === null) return s;
    return new Date(t).toISOString().slice(0, 10);
  }

  // computeCutoffTime / passesAging — same day-granularity aging discipline
  // as lib/address-dictionary.js (#338): asOf is floored to its UTC calendar
  // date before computing the cutoff, so only the DATE matters, never
  // time-of-day. cutoffTime === null means aging is disabled.
  function computeCutoffTime(opts) {
    if (typeof opts.recencyWindowDays !== 'number' || !isFinite(opts.recencyWindowDays)) return null;
    const asOf = opts.asOf ? new Date(opts.asOf) : new Date();
    if (isNaN(asOf.getTime())) return null;
    const asOfDayMs = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
    return asOfDayMs - opts.recencyWindowDays * 24 * 60 * 60 * 1000;
  }

  function passesAging(lastSeen, cutoffTime) {
    if (cutoffTime === null) return true;
    const t = parseEntryDate(lastSeen);
    if (t === null) return true; // unparseable/missing -> fail open
    return t >= cutoffTime;
  }

  // resolveEntries(dictionary, options?) -> entry[]. Every keyed address
  // with a non-blank dominant area, aged per options.recencyWindowDays/asOf
  // (defaults: 30 days / now), with the recalibrated Misroute Trigger's
  // flagEligible flag and daysCount (distinct reassignment days for the
  // dominant area) precomputed (see module comment; ADR-0019).
  //
  // options:
  //   - recencyWindowDays (default 30): entries whose lastSeen is older are
  //     excluded. Pass null/NaN to disable aging entirely.
  //   - asOf (default: today): reference date for the recency window; tests
  //     pass a fixed ISO date so aging assertions aren't clock-dependent.
  function resolveEntries(dictionary, options) {
    const opts = options || {};
    const recencyWindowDays = 'recencyWindowDays' in opts ? opts.recencyWindowDays : DEFAULT_RECENCY_WINDOW_DAYS;
    const cutoffTime = computeCutoffTime({ recencyWindowDays: recencyWindowDays, asOf: opts.asOf });
    const dict = dictionary || {};
    return Object.keys(dict)
      .map(function (key) {
        const e = dict[key] || {};
        const dominant = pickDominantArea(e.workAreas || {});
        // Distinct calendar days the address was reassigned to its DOMINANT
        // (Mainly Assigned) area — the recurrence signal (issue #478).
        const dominantDays = (e.workAreaDays && e.workAreaDays[dominant.area]) || {};
        const daysCount = Object.keys(dominantDays).length;
        // Recalibrated Misroute Trigger (ADR-0019): dominant area holds >=80%
        // of sightings AND was reassigned on >=2 distinct days. The Load Wall
        // exclusion is applied later, in matchInbound (it needs today's
        // scanned area, not just the dominant one).
        const flagEligible = dominant.total > 0 &&
          (dominant.count / dominant.total) >= MIN_DOMINANCE_PCT &&
          daysCount >= MIN_DISTINCT_DAYS;
        return {
          key: key,
          addressDisplay: e.addressDisplay || '',
          postalCode: e.postalCode || '',
          area: dominant.area,
          areaCount: dominant.count,
          areaTotal: dominant.total,
          daysCount: daysCount,
          workAreaTally: Object.assign({}, e.workAreas || {}),
          flagEligible: flagEligible,
          lastSeen: e.lastSeen || '',
        };
      })
      .filter(function (e) { return !!e.area; })
      .filter(function (e) { return passesAging(e.lastSeen, cutoffTime); });
  }

  function toSet(value) {
    if (!value) return new Set();
    if (value instanceof Set) return value;
    if (Array.isArray(value)) return new Set(value);
    return new Set();
  }

  // ── Area Verdict Loop effects (issue #452, slice 6 of #446) ──────────────
  // areaVerdictKey(areaKey, area) — MUST equal CorrectionLog.mappingKey(areaKey,
  // area) (normalize whitespace + uppercase, join with ' → ') so a promoted
  // Area Verdict Loop override keyed off the entry's street+ZIP5 identity + its
  // mainly-assigned area lines up with the effect map lib/correction-overrides.js
  // emits. Kept as a LOCAL mirror (not an import) because this module is
  // deliberately standalone (the module decision); tests/correction-overrides
  // assert the two agree.
  function areaVerdictKey(areaKey, area) {
    function n(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toUpperCase(); }
    return n(areaKey) + ' → ' + n(area);
  }

  // applyAreaEffects(entries, effects) -> entries[]. Applies PROMOTED Area
  // Verdict Loop effects to RESOLVED entries, AFTER resolveEntries and BEFORE
  // flagging — the SAME staged-override discipline ADR-0018 uses for
  // corrections (nothing auto-applies; effects land only after explicit
  // promotion). effects is a { [areaVerdictKey]: verb } map (or null/empty for
  // an exact no-op) from CorrectionOverrides.areaEffects(). Verbs
  // (CorrectionOverrides.AREA_EFFECT):
  //   - 'strengthen' (Confirmed missort): flagEligible := true — the
  //     mainly-assigned area is trusted even below the >=80%/>=2-days bar,
  //     firing on the confirmed mapping regardless of raw history strength.
  //     Note: daysCount is left at its real value (may be < 2 here), so a
  //     strengthened flag is a HUMAN override, not organic >=2-day evidence —
  //     the #479/#480 "N days" headline should label it as confirmed-by-you
  //     rather than present a sub-2 count as recurrence evidence.
  //   - 'suppress' (Routing changed / history stale): the entry is DROPPED —
  //     no misroute flag and no 999 suggestion; the old area ages out.
  //   - 'demote' (Legitimately multi-area): flagEligible := false — the
  //     mapping falls below the flag bar and cannot fire.
  // An effect keyed to a DIFFERENT area than the entry's current dominant is
  // inert (its key won't match). NEVER fabricates an entry — only drops or
  // clones-and-relabels members of the input (same never-fabricate invariant
  // as CorrectionOverrides.applyToTrustedEntries). Pure; input not mutated.
  function applyAreaEffects(entries, effects) {
    const list = Array.isArray(entries) ? entries : [];
    if (!effects) return list;
    const out = [];
    list.forEach(function (e) {
      const verb = effects[areaVerdictKey(e.key, e.area)];
      if (!verb) { out.push(e); return; }
      if (verb === 'suppress') return; // dropped entirely — no flag, no suggestion
      if (verb === 'strengthen') { out.push(Object.assign({}, e, { flagEligible: true })); return; }
      if (verb === 'demote') { out.push(Object.assign({}, e, { flagEligible: false })); return; }
      out.push(e); // unknown verb -> conservative keep
    });
    return out;
  }

  // matchInbound(dictionary, inboundRecords, options?) -> { matches, suggestions }
  //
  // inboundRecords: [{ trackingId, labelAddress1, postalCode, ibWorkArea,
  //   firmName?, address? }] — labelAddress1/postalCode are REQUIRED for the
  //   street+ZIP5 join (the composed `address`, if given, is display-only —
  //   see module comment on why the composed string can't be the join key).
  //
  // options: recencyWindowDays/asOf (aging, passed to resolveEntries) plus
  //   excludeTrackingIds (Set|array, optional): tracking numbers to skip
  //   entirely — the Address Catcher page passes every trackingId already
  //   surfaced by the Address Correction Dictionary's own matching so a
  //   package matching BOTH dictionaries is never duplicated into the
  //   correct-address section (issue #451 AC). Applied only to the misroute
  //   flagging path, never to 999 suggestions (a 999 has no correction to
  //   have already matched).
  //
  // Single pass over today's inbound: classify each record as a 999
  // suggestion, a flagged misroute (dominant area is flagEligible and neither
  // side is a Load Wall area), a correctly-routed package (silently dropped),
  // or an unflagged divergence (Misroute Trigger not satisfied -> no flag).
  function matchInbound(dictionary, inboundRecords, options) {
    const opts = options || {};
    // Area Verdict Loop (issue #452): apply any PROMOTED area verdict effects
    // (opts.areaEffects) to the resolved entries before flagging. null/empty
    // is an exact no-op (see applyAreaEffects). Effects change WHICH entries
    // flag / suggest — nothing auto-applies; the page only passes effects for
    // verdicts Tyler explicitly promoted.
    const entries = applyAreaEffects(resolveEntries(dictionary, opts), opts.areaEffects);
    if (entries.length === 0) return { matches: [], suggestions: [] };
    const byKey = Object.create(null);
    entries.forEach(function (e) { byKey[e.key] = e; });

    const exclude = toSet(opts.excludeTrackingIds);
    const records = Array.isArray(inboundRecords) ? inboundRecords : [];

    // inboundKey(rec) -> the street+ZIP5 join key, or '' when the record has
    // no street line. A street-less key ('|85027') must never join — see
    // merge()'s comment (ZIP-only matching folds every unaddressed package
    // in a ZIP onto one entry; bias to miss, never to a wrong fold).
    function inboundKey(rec) {
      const key = streetKey(rec.labelAddress1 != null ? rec.labelAddress1 : rec.address, rec.postalCode);
      return isStreetless(key) ? '' : key;
    }

    const matches = [];
    const suggestions = [];
    records.forEach(function (rec) {
      if (!rec) return;
      const key = inboundKey(rec);
      if (!key) return;
      const entry = byKey[key];
      if (!entry) return;
      const trackingId = rec.trackingId || '';
      const displayAddress = rec.address || rec.labelAddress1 || entry.addressDisplay;
      const ib = String(rec.ibWorkArea == null ? '' : rec.ibWorkArea).trim();

      // 999 suggestion — a separate output from misroute flagging (a 999 has
      // no scanned area to diverge from). Never excluded by
      // excludeTrackingIds (see options doc above).
      if (!ib || ib === '999') {
        suggestions.push({
          trackingId: trackingId,
          addressDisplay: entry.addressDisplay,
          suggestedArea: entry.area,
          areaCount: entry.areaCount,
          areaTotal: entry.areaTotal,
          recipient: rec.firmName || '',
          address: displayAddress,
        });
        return;
      }

      if (ib === entry.area) return; // correctly routed -> nothing to surface
      if (exclude.has(trackingId)) return; // already in the correction worklist

      // Load Wall exclusion (issue #478 / ADR-0019): a flex between wall areas
      // is never a missort. Drop when EITHER side is a Load Wall area.
      if (isLoadWall(entry.area) || isLoadWall(ib)) return;
      if (!entry.flagEligible) return; // Misroute Trigger not satisfied -> no flag
      // Every surviving flag is evidenced history (>=80% dominant, >=2 days).
      const track = 'a';

      matches.push({
        trackingId: trackingId,
        // key (street+ZIP5, the resolved entry's stable identity) rides on
        // every match/group so the Area Verdict Loop (issue #452) can key a
        // verdict to it — the addressDisplay alone is display-only and can vary.
        key: entry.key,
        addressDisplay: entry.addressDisplay,
        scannedArea: ib,
        mainlyAssignedArea: entry.area,
        areaCount: entry.areaCount,
        areaTotal: entry.areaTotal,
        // distinct calendar days the address was reassigned to its
        // mainly-assigned area — the recurrence evidence behind the flag
        // (issue #478; surfaced as the "N days" headline in #479/#480).
        daysCount: entry.daysCount,
        workAreaTally: Object.assign({}, entry.workAreaTally),
        track: track,
        recipient: rec.firmName || '',
        address: displayAddress,
      });
    });

    return { matches: matches, suggestions: suggestions };
  }

  // groupAreaMatches(matches) -> group[], one per distinct addressDisplay —
  // mirrors lib/address-match.js's groupMatches() grouping discipline (pure,
  // non-mutating, first-seen order) so the worklist section's card shape is
  // familiar. group.track is always 'a' (every surviving flag is evidenced
  // history since the #478 recalibration); the field is kept for the card UI.
  function groupAreaMatches(matches) {
    const list = Array.isArray(matches) ? matches : [];
    if (list.length === 0) return [];
    const order = [];
    const byAddress = Object.create(null);
    list.forEach(function (m) {
      if (!m) return;
      const key = m.addressDisplay || '';
      let group = byAddress[key];
      if (!group) {
        group = byAddress[key] = {
          key: m.key,
          addressDisplay: m.addressDisplay,
          mainlyAssignedArea: m.mainlyAssignedArea,
          areaCount: m.areaCount,
          areaTotal: m.areaTotal,
          daysCount: m.daysCount,
          workAreaTally: Object.assign({}, m.workAreaTally || {}),
          track: m.track,
          packageCount: 0,
          scannedAreas: [],
          // the tracking numbers of TODAY's flagged packages for this address —
          // the pull-list the review panel copies (issue #479).
          trackingIds: [],
          // recipient/company name for this address (issue #490) — from today's
          // inbound LABEL_FIRM_NAME; the MAD has no firm-name column, so it is
          // an address-level attribute taken from the flagged packages. First
          // non-blank wins (an address is normally one recipient).
          recipient: '',
          matches: [],
        };
        order.push(key);
      }
      group.packageCount++;
      group.matches.push(m);
      if (!group.recipient && m.recipient && String(m.recipient).trim()) group.recipient = String(m.recipient).trim();
      if (m.trackingId && group.trackingIds.indexOf(m.trackingId) === -1) group.trackingIds.push(m.trackingId);
      if (m.scannedArea && group.scannedAreas.indexOf(m.scannedArea) === -1) group.scannedAreas.push(m.scannedArea);
      if (m.track === 'a') group.track = 'a';
    });
    return order.map(function (k) { return byAddress[k]; })
      .sort(function (a, b) { return (b.packageCount || 0) - (a.packageCount || 0); });
  }

  // groupAreaSuggestions(suggestions) -> group[], one per distinct address —
  // same grouping discipline, deliberately separate from groupAreaMatches
  // (a 999 suggestion is never a misroute flag).
  function groupAreaSuggestions(suggestions) {
    const list = Array.isArray(suggestions) ? suggestions : [];
    if (list.length === 0) return [];
    const order = [];
    const byAddress = Object.create(null);
    list.forEach(function (s) {
      if (!s) return;
      const key = s.addressDisplay || '';
      let group = byAddress[key];
      if (!group) {
        group = byAddress[key] = {
          addressDisplay: s.addressDisplay,
          suggestedArea: s.suggestedArea,
          areaCount: s.areaCount,
          areaTotal: s.areaTotal,
          packageCount: 0,
          matches: [],
        };
        order.push(key);
      }
      group.packageCount++;
      group.matches.push(s);
    });
    return order.map(function (k) { return byAddress[k]; })
      .sort(function (a, b) { return (b.packageCount || 0) - (a.packageCount || 0); });
  }

  return {
    streetKey: streetKey,
    // Exported so AddressCatcherSession.areaEvidence (#479) counts distinct
    // days with the SAME normalization the flag's daysCount uses — reuse, not
    // a second date parser that could drift.
    dayKey: dayKey,
    parseEntryDate: parseEntryDate,
    isStreetless: isStreetless,
    merge: merge,
    resolveEntries: resolveEntries,
    applyAreaEffects: applyAreaEffects,
    areaVerdictKey: areaVerdictKey,
    matchInbound: matchInbound,
    groupAreaMatches: groupAreaMatches,
    groupAreaSuggestions: groupAreaSuggestions,
    pickDominantArea: pickDominantArea,
    MIN_DOMINANCE_PCT: MIN_DOMINANCE_PCT,
    MIN_DISTINCT_DAYS: MIN_DISTINCT_DAYS,
    LOAD_WALL_AREAS: LOAD_WALL_AREAS.slice(),
    isLoadWall: isLoadWall,
    DEFAULT_RECENCY_WINDOW_DAYS: DEFAULT_RECENCY_WINDOW_DAYS,
  };
});
