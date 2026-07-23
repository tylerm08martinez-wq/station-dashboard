'use strict';

// Live inbound matching against the Address Correction Dictionary — the
// during-sort half of the Address Catcher (ADR-0012 / issue #295, slice 1 =
// issue #296).
//
// SLICE 1 SCOPE (per #296): match trk# + pre-filled correction + evidence.
//
// Work area + corroboration (slice 5, issue #301): each match now also
// carries `workArea` (the corrected address's proper work area, when the
// Manual Assignment Detail report supplied a single deterministic one — ''
// otherwise) and `corroborated` (true when the mapping was seen in BOTH the
// Address Corrections Report and the Manual Assignment Detail report). Both
// are computed by AddressDictionary.trustedEntries(); this module just
// passes them through onto the match.
//
// Misroute flagging (slice 6, issue #302): a match also carries `misroute`
// (boolean). True when the inbound record's `ibWorkArea` (IB_WORK_AREA from
// the live Inbound and Van Scans report, threaded through by the caller —
// see address-catcher-session.js's parseInboundRows) disagrees with the
// entry's known true work area (`entry.workArea`, from slice 5). Per #302's
// AC, a match is NOT flagged when either side is unknown/blank (nothing to
// disagree with) or when both sides agree once trimmed — only an actual,
// known disagreement is a misroute. Comparison is a plain trimmed string
// equality: work area codes are exact tokens (e.g. "401"), not addresses, so
// no normalization beyond whitespace trimming is warranted here.
//
// Recurring-IBNO annotation (slice 7, issue #300): matchInbound's optional
// third argument, `opts.recurringIbnoSet`, marks a match as recurring when
// its trackingId is also a Recurring IBNO. Data-source choice (documented in
// full in the #300 PR body): the Recurring-IBNO signal is the IBNO Coder's
// existing Repeat History (lib/ibno-rules.js detectRecurring / historyRows —
// ADR-0001 / ADR-0007), read from the SAME browser's localStorage under
// IbnoRules.HISTORY_KEY, since both the IBNO Coder and the Address Catcher
// run in the same station-PC browser. This module stays pure/DOM-free and
// never reads localStorage itself — the caller (address-catcher-session.js /
// address-catcher.html) builds recurringIbnoSet from IbnoRules.historyRows(
// history).filter(row => row.timesSeen >= 2) and passes just the tracking
// numbers in. Reuses the existing recurring-detection logic verbatim; this
// module never reimplements "what counts as recurring."
//
// Delivery-confirmed trust signal (issue #359): a match now also carries
// `deliveryConfirmed` (boolean), passed straight through from the trusted
// entry's own `deliveryConfirmed` field (computed by
// AddressDictionary.trustedEntries() — see lib/address-dictionary.js's
// deliveryConfirms()/merge() comments for the agreement rule). This module
// does no comparison itself, same pattern as workArea/corroborated.
// groupMatches() aggregates it onto the group as a SHARED entry-level field
// (like corroborated/workArea, not a per-package aggregate like anyMisroute)
// since delivery confirmation is a property of the MAPPING, not of any one
// package — every member of a group shares the same underlying dictionary
// entry. It also becomes a sort key: within a lane, delivery-confirmed
// groups sort ABOVE unconfirmed ones (a stronger trust signal than raw
// seen-count per the issue), ahead of the existing evidenceCount tiebreak
// but still behind the existing misroute-first ordering (a misroute is an
// urgent "pull it" signal regardless of how trusted the mapping is).
//
// Grouping the worklist by address (issue #344): matchInbound emits one
// match per PACKAGE, so a mapping seen on many incoming packages multiplies
// into that many rows — a live-use finding (2026-07-02) found 777 match rows
// on the real 2026-07-01 inbound collapse to only 120 distinct addresses,
// burying the signal. groupMatches(matches) is a pure, additive grouping
// helper: one group per distinct ORIGINAL address, carrying the shared
// correction/evidence (every member came from the same trusted dictionary
// entry, so these fields are identical across the group) plus the full list
// of member matches for per-package detail (trk#s, and any per-package
// misroute divergence). It never changes matchInbound's own output shape or
// return value — callers that don't group (e.g. existing tests) keep working
// exactly as before.
//
// Per-mapping misroute-suppress flag (issue #426, ADR-0018): a promoted
// "wrong work area" Correction Feedback Loop override means Tyler judged
// this mapping's misroute signal wrong for THIS specific original->corrected
// pair, while the address correction itself is still trusted. matchInbound's
// optional opts.misrouteSuppressKeys is a Set of `entry.originalKey + '|' +
// entry.correctedKey` (the dictionary's own entry identity, NOT a
// display-string key — see lib/correction-overrides.js's
// misrouteSuppressKeys() for how the caller builds it). When an entry's key
// is in the set, `misroute` is forced false for every match built from it —
// entry.workArea (the "proper area" display) is left completely untouched,
// only the derived misroute boolean changes. Omitted opts (or no matching
// key) behaves exactly as before -- this is purely additive.
//
// Real signals replacing the dead itqaFlagged (issue #357): the real Inbound
// and Van Scans report has no ITQA flag column, so every inbound record's
// itqaFlagged was always false — a constant, not a signal. It has been
// REMOVED from a match's shape entirely (not just left false). Two real
// columns take its place, both read via the shared lib/inbound-scans.js:
// - `coded` (per package): true when the inbound record's `statusCodes`
//   (STATUS_CODES1, '||'-separated) contains 02, bare 2, or 33 — QA already
//   touched this package for an address reason. Real-data finding
//   (2026-07-01): 26 packages carried 02/33, and ZERO overlapped the 78
//   matches this tool surfaced — the absence of overlap IS the finding: it
//   proves these are packages ITQA/QA did NOT already catch, the exact
//   "unflagged leak" the Address Catcher exists to close.
// - `onTruck` (per package): true when `vanScanTime` (VAN_SCAN_TIME1) is
//   non-blank — the same signal the DSW uses. Mid-sort it splits "catchable
//   at the belt" (not yet on truck) from "go pull it off the truck".
// groupMatches aggregates both onto the group: `anyCoded` (true if ANY
// member is coded — same aggregate style as anyMisroute/anyRecurring) and
// `onTruckCount` (a COUNT, not a boolean — the pill reads "N on truck",
// per #357's spec, since knowing how many of the group's packages are
// already loaded is the operational question, not just whether any are).
//
// Mainly Assigned Area tally passthrough (issue #448, slice 2 of #446): a
// match now also carries `workAreaCount` (the dominant/mainly-assigned
// area's own sighting count) and `workAreaTotal` (all sightings across
// every area at this address, from AddressDictionary.trustedEntries()'s
// workAreaTally). This module does no computation of its own — the dominant
// area, tally, and totals are already resolved by trustedEntries() (see
// pickDominantArea in lib/address-dictionary.js); this is a straight
// passthrough, same pattern as workArea/corroborated. The display layer
// (address-catcher.html) uses workAreaCount === workAreaTotal to decide
// between a bare "Area 401" (unanimous) pill and a "Area 401 · 9 of 11"
// (non-unanimous) pill. groupMatches aggregates both onto the group as
// SHARED entry-level fields (like workArea itself), since the tally is a
// property of the mapping, not of any one package.
//
// Full per-area tally passthrough (issue #449, slice 3 of #446): a match also
// carries `workAreaTally` — the ENTIRE area->count breakdown (entry.
// workAreaTally from trustedEntries(), e.g. { '401': 9, '305': 2 }), not just
// the dominant area's own count. This is what lets a split (non-unanimous)
// worklist card show per-area counts ("Area 401 ×9 · Area 305 ×2") and the
// "view N assignments →" affordance into the Raw-Data Viewer. Same
// passthrough discipline as workArea/workAreaCount/workAreaTotal — this
// module computes nothing, it only threads the entry's already-resolved
// tally onto the match/group. The tally carries AREA CODES AND COUNTS ONLY,
// never USER_NAME/assigner identity — the who/when detail comes from the
// Raw-Data Viewer's raw rows, never from the dictionary (the hard
// constraint: no assigner names are ever accumulated into the dictionary).
//
// Scanned-area display (issue #447, slice 1 of #446): every match now
// carries `ibWorkArea` (the trimmed inbound IB_WORK_AREA already read for the
// misroute comparison above) regardless of misroute status, so the caller
// can show a package's own scanned area even when it's correctly routed.
// groupMatches aggregates `misrouteScannedAreas` onto each group: the
// distinct `ibWorkArea` values of members whose `misroute` is true, in
// first-seen order (a group with no misrouted members gets an empty array).
// This is purely a display aggregate — it changes no matching/grouping
// behavior and does not affect `anyMisroute` or sort order.
//
// Recipient + scanned-address passthrough (issue #450, slice 4 of #446): a
// match now also carries `recipient` (rec.firmName, the inbound record's
// LABEL_FIRM_NAME) and `address` (rec.address, the inbound record's own
// composed LABEL_ADDRESS1/CITY/STATE/POSTAL_CODE string — the package's
// TODAY'S scanned label address, not entry.originalDisplay/correctedDisplay,
// which are the DICTIONARY's addresses and may differ in formatting). Both
// are per-PACKAGE (unlike workArea/originalDisplay, which are shared across
// every match built from the same dictionary entry), since two packages at
// one corrected address can still carry different recipients. This is a
// straight passthrough with no computation, same discipline as
// workArea/corroborated above — it exists so lib/address-teams-grid.js's
// "Copy for Teams" misroute pull-list can show who a package is for and
// where it scanned without re-reading the inbound report itself.
//
// Grouping key: `originalDisplay`, not a raw address string or normalized
// key. Every match in a matchInbound() result carries originalDisplay
// straight from the trusted entry that produced it (entry.originalDisplay),
// so matches sharing one dictionary entry always share the identical
// originalDisplay string — a plain equality group-by is correct and doesn't
// require re-deriving or re-exporting the entry's normalized key here.
//
// Sort order (per #344 AC): misroute groups first (anyMisroute true sorts
// before false), then evidenceCount descending within each bucket. Stable
// otherwise (Array#sort is stable in the JS engines this repo targets).
//
// Name-matched unit-correction advisory tier (issue #358): matchNameAdvisories
// + groupNameAdvisories are a SEPARATE, PARALLEL path to matchInbound/
// groupMatches — they read AddressDictionary.suppressedAddsUnitEntries()
// (adds-a-unit mappings #342 suppresses from trustedEntries()), never
// trustedEntries() itself. An advisory surfaces ONLY when both the entry's
// recorded recipient name (Original Name or Corrected Name from the
// corrections report) AND today's package's LABEL_FIRM_NAME are present and
// match after conservative normalization (AddressNormalize.normalizeName —
// case/whitespace/punctuation folding, exact-ish equality, no fuzzy
// matching). This is a LEAD to verify, never a trusted fix — Tyler: even a
// matching name can legitimately route to an office instead of the unit.
// address-catcher.html renders these in their own clearly-labeled
// "Name match — verify" sub-section inside the Low-evidence lane, never
// mixed with trusted cards.
//
// Dual-loadable with no build step:
// - Browser: window.AddressMatch
// - Node: require('./lib/address-match')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AddressMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function deps() {
    const AddressNormalize = (root && root.AddressNormalize) ||
      (typeof require === 'function' ? require('./address-normalize') : null);
    if (!AddressNormalize) throw new Error('AddressMatch dependency unavailable (need AddressNormalize)');
    return {
      normalizeAddress: AddressNormalize.normalizeAddress,
      normalizeName: AddressNormalize.normalizeName,
    };
  }

  // isCoded(statusCodes) -> boolean. statusCodes is the raw STATUS_CODES1
  // cell, '||'-separated (e.g. "38||300", "33||52"). True when any token is
  // 02, bare 2, or 33 — the QA scan codes that mean "already touched for an
  // address reason" (see CONTEXT.md: 02 = bad address, 33 = address search).
  // Bare "2" is included alongside "02" because some report exports drop the
  // leading zero on single-digit-looking codes; both mean the same thing.
  function isCoded(statusCodes) {
    if (!statusCodes) return false;
    const tokens = String(statusCodes).split('||').map(function (t) { return t.trim(); });
    return tokens.indexOf('02') !== -1 || tokens.indexOf('2') !== -1 || tokens.indexOf('33') !== -1;
  }

  // matchInbound(inboundRecords, trustedEntries, opts?) -> match[]
  //
  // inboundRecords: array of { trackingId, address, statusCodes?,
  //   vanScanTime?, ... } — the shape address-catcher.html's inbound-scans
  //   parser produces (trackingId <- PKG_LABEL_XREF, address <-
  //   LABEL_ADDRESS1/CITY/STATE/POSTAL_CODE joined). itqaFlagged is no
  //   longer read (issue #357 — the real report has no ITQA flag column;
  //   see module comment above).
  // trustedEntries: the array returned by AddressDictionary.trustedEntries().
  // opts.recurringIbnoSet: optional Set (or array) of tracking numbers that
  //   are Recurring IBNOs (see module comment above for the data source).
  //   When omitted, every match's `recurring` field is simply false — the
  //   annotation degrades gracefully rather than throwing when the caller
  //   has no IBNO history loaded yet.
  //
  // Returns one match per inbound record whose normalized address equals a
  // trusted entry's originalKey — regardless of coded/onTruck status (story:
  // matches for packages QA has not already coded for this reason must be
  // included, per #295/#357 AC). Each match carries evidence (count,
  // sources) but never an "applied"/"autoApplied" field — this module only
  // surfaces, it never writes back.
  function matchInbound(inboundRecords, trustedEntries, opts) {
    const d = deps();
    const entries = Array.isArray(trustedEntries) ? trustedEntries : [];
    if (entries.length === 0) return [];

    const byKey = Object.create(null);
    entries.forEach(function (e) {
      if (e && e.originalKey) byKey[e.originalKey] = e;
    });

    const recurringSet = toSet(opts && opts.recurringIbnoSet);
    const misrouteSuppressKeys = toSet(opts && opts.misrouteSuppressKeys);

    const records = Array.isArray(inboundRecords) ? inboundRecords : [];
    const out = [];
    records.forEach(function (rec) {
      if (!rec) return;
      const key = d.normalizeAddress(rec.address);
      if (!key) return;
      const entry = byKey[key];
      if (!entry) return;
      const trackingId = rec.trackingId || '';
      // Misroute comparison uses ONLY a UNANIMOUS mainly-assigned area (issue
      // #448 is display-only — "the misroute decision itself is unchanged in
      // this slice"). Before #448, entry.workArea was blank whenever the
      // assignment history conflicted, so the misroute check below could
      // never fire on a non-unanimous entry. #448 redefines entry.workArea
      // to always be the DOMINANT area (for display, e.g. "Area 401 · 2 of
      // 3"), which would otherwise newly misroute-flag a package scanning to
      // the historical MINORITY area. Recomputing a strict unanimous-only
      // value here (rather than reusing entry.workArea) preserves the exact
      // pre-#448 misroute membership; entry.workArea itself is used
      // unchanged for the DISPLAY field below.
      const workAreaCount = entry.workAreaCount || 0;
      const workAreaTotal = entry.workAreaTotal || 0;
      const unanimousWorkArea = (workAreaTotal > 0 && workAreaCount === workAreaTotal)
        ? String(entry.workArea || '').trim() : '';
      const trueWorkArea = unanimousWorkArea;
      const ibWorkArea = String(rec.ibWorkArea || '').trim();
      const entryIdentity = String(entry.originalKey || '') + '|' + String(entry.correctedKey || '');
      const misroute = !misrouteSuppressKeys.has(entryIdentity) &&
        !!(trueWorkArea && ibWorkArea && trueWorkArea !== ibWorkArea);
      out.push({
        trackingId: trackingId,
        originalDisplay: entry.originalDisplay,
        correctedDisplay: entry.correctedDisplay,
        evidenceCount: entry.count,
        sources: (entry.sources || []).slice(),
        coded: isCoded(rec.statusCodes),
        onTruck: !!(rec.vanScanTime && String(rec.vanScanTime).trim()),
        recurring: recurringSet.has(trackingId),
        workArea: entry.workArea || '',
        workAreaCount: entry.workAreaCount || 0,
        workAreaTotal: entry.workAreaTotal || 0,
        workAreaTally: Object.assign({}, entry.workAreaTally || {}),
        corroborated: !!entry.corroborated,
        misroute: misroute,
        deliveryConfirmed: !!entry.deliveryConfirmed,
        ibWorkArea: ibWorkArea,
        recipient: rec.firmName || '',
        address: rec.address || '',
      });
    });
    return out;
  }

  // toSet(value) -> Set. Accepts a Set, an array, or nothing — callers may
  // reasonably pass any of these (an array is the natural JSON-ish shape;
  // a Set is what a caller building it from a loop already has on hand).
  function toSet(value) {
    if (!value) return new Set();
    if (value instanceof Set) return value;
    if (Array.isArray(value)) return new Set(value);
    return new Set();
  }

  // groupMatches(matches) -> group[]
  //
  // group shape: {
  //   originalDisplay, correctedDisplay,   // shared correction (from the entry)
  //   evidenceCount, sources, corroborated, workArea, // shared entry-level evidence
  //   workAreaCount, workAreaTotal,          // Mainly Assigned Area tally (#448)
  //   workAreaTally,                         // full area->count breakdown (#449)
  //   packageCount,                          // matches.length — "N packages today"
  //   anyMisroute, anyRecurring, anyCoded,   // aggregate pills: true if ANY member has the flag
  //   onTruckCount,                          // COUNT of members with onTruck true (#357 — "N on truck")
  //   matches,                               // the full member match[] — per-package detail
  //   misrouteScannedAreas,                  // distinct ibWorkArea of misrouted members, first-seen (#447)
  // }
  //
  // Pure and non-mutating: never touches the matches it's given (they're
  // referenced, not copied, into group.matches — matchInbound's own return
  // value and shape are completely unaffected by calling this afterward).
  function groupMatches(matches) {
    const list = Array.isArray(matches) ? matches : [];
    if (list.length === 0) return [];

    const order = []; // preserves first-seen order of distinct addresses
    const byAddress = Object.create(null);

    list.forEach(function (m) {
      if (!m) return;
      const key = m.originalDisplay || '';
      let group = byAddress[key];
      if (!group) {
        group = byAddress[key] = {
          originalDisplay: m.originalDisplay,
          correctedDisplay: m.correctedDisplay,
          evidenceCount: m.evidenceCount,
          sources: (m.sources || []).slice(),
          corroborated: !!m.corroborated,
          workArea: m.workArea || '',
          workAreaCount: m.workAreaCount || 0,
          workAreaTotal: m.workAreaTotal || 0,
          workAreaTally: Object.assign({}, m.workAreaTally || {}),
          deliveryConfirmed: !!m.deliveryConfirmed,
          packageCount: 0,
          anyMisroute: false,
          anyRecurring: false,
          anyCoded: false,
          onTruckCount: 0,
          matches: [],
          misrouteScannedAreas: [],
        };
        order.push(key);
      }
      group.packageCount++;
      group.matches.push(m);
      if (m.misroute) group.anyMisroute = true;
      if (m.recurring) group.anyRecurring = true;
      if (m.coded) group.anyCoded = true;
      if (m.onTruck) group.onTruckCount++;
      if (m.misroute && m.ibWorkArea && group.misrouteScannedAreas.indexOf(m.ibWorkArea) === -1) {
        group.misrouteScannedAreas.push(m.ibWorkArea);
      }
    });

    const groups = order.map(function (key) { return byAddress[key]; });
    groups.sort(function (a, b) {
      if (a.anyMisroute !== b.anyMisroute) return a.anyMisroute ? -1 : 1;
      // Delivery-confirmed trust signal (issue #359): a stronger trust
      // signal than raw seen-count, so it sorts ahead of evidenceCount
      // within a misroute bucket -- but never ahead of misroute itself,
      // which stays an urgent "pull it" signal regardless of trust.
      if (a.deliveryConfirmed !== b.deliveryConfirmed) return a.deliveryConfirmed ? -1 : 1;
      return (b.evidenceCount || 0) - (a.evidenceCount || 0);
    });
    return groups;
  }

  // matchNameAdvisories(inboundRecords, suppressedEntries, opts?) -> advisory[]
  // (issue #358) — the "Name match — verify" advisory tier. Separate from
  // matchInbound() by design: these entries are addsUnit-SUPPRESSED (never in
  // trustedEntries), so this function must never be mixed into or confused
  // with a trusted match. Returns one advisory per inbound record whose
  // normalized address equals a suppressed entry's originalKey AND whose
  // firmName conservatively matches (exact-ish, after AddressNormalize.
  // normalizeName folding) the entry's recorded originalName OR
  // correctedName. Either side matching counts — the same recipient may be
  // recorded under either column across different correction events, and
  // requiring one specific side to match would silently under-surface real
  // matches. Missing/non-matching names -> nothing (bias to MISSING, per the
  // issue's AC): a blank firmName or a blank entry name never produces an
  // advisory (suppressedAddsUnitEntries() already only returns entries where
  // BOTH names are present, but this function does not trust that as a
  // silent invariant — it re-checks defensively).
  //
  // Advisory shape mirrors a match's evidence-bearing fields but is
  // DELIBERATELY DISTINCT from matchInbound's return shape (no `misroute`,
  // no `corroborated`, no `workArea` — those never applied to a suppressed
  // mapping) so a caller can never accidentally render an advisory through
  // the trusted-match card path: { trackingId, originalDisplay,
  // correctedDisplay, matchedName, evidenceCount, sources }.
  function matchNameAdvisories(inboundRecords, suppressedEntries, opts) {
    const d = deps();
    if (typeof d.normalizeName !== 'function') return [];
    const entries = Array.isArray(suppressedEntries) ? suppressedEntries : [];
    if (entries.length === 0) return [];

    const byKey = Object.create(null);
    entries.forEach(function (e) {
      if (e && e.originalKey) byKey[e.originalKey] = e;
    });

    const records = Array.isArray(inboundRecords) ? inboundRecords : [];
    const out = [];
    records.forEach(function (rec) {
      if (!rec) return;
      const firmName = String(rec.firmName || '').trim();
      if (!firmName) return; // no name on today's package — nothing to compare
      const key = d.normalizeAddress(rec.address);
      if (!key) return;
      const entry = byKey[key];
      if (!entry) return;

      const packageNameKey = d.normalizeName(firmName);
      if (!packageNameKey) return;
      const originalNameKey = d.normalizeName(entry.originalName);
      const correctedNameKey = d.normalizeName(entry.correctedName);
      let matchedName = '';
      if (originalNameKey && originalNameKey === packageNameKey) matchedName = entry.originalName;
      else if (correctedNameKey && correctedNameKey === packageNameKey) matchedName = entry.correctedName;
      if (!matchedName) return; // present but non-matching -> nothing, per AC

      out.push({
        trackingId: rec.trackingId || '',
        originalDisplay: entry.originalDisplay,
        correctedDisplay: entry.correctedDisplay,
        matchedName: matchedName,
        evidenceCount: entry.count,
        sources: (entry.sources || []).slice(),
      });
    });
    return out;
  }

  // groupNameAdvisories(advisories) -> group[] (issue #358). Mirrors
  // groupMatches()'s address-level grouping so the advisory sub-section
  // renders with the same "N packages at this address" card shape as the
  // rest of the worklist, but stays a SEPARATE function (not a mode of
  // groupMatches) since advisory groups carry no misroute/onTruck/coded
  // fields — there is nothing to aggregate that a suppressed mapping ever
  // produces.
  function groupNameAdvisories(advisories) {
    const list = Array.isArray(advisories) ? advisories : [];
    if (list.length === 0) return [];

    const order = [];
    const byAddress = Object.create(null);

    list.forEach(function (a) {
      if (!a) return;
      const key = a.originalDisplay || '';
      let group = byAddress[key];
      if (!group) {
        group = byAddress[key] = {
          originalDisplay: a.originalDisplay,
          correctedDisplay: a.correctedDisplay,
          matchedName: a.matchedName,
          evidenceCount: a.evidenceCount,
          sources: (a.sources || []).slice(),
          packageCount: 0,
          matches: [],
        };
        order.push(key);
      }
      group.packageCount++;
      group.matches.push(a);
    });

    return order.map(function (key) { return byAddress[key]; })
      .sort(function (a, b) { return (b.evidenceCount || 0) - (a.evidenceCount || 0); });
  }

  return {
    matchInbound: matchInbound,
    groupMatches: groupMatches,
    matchNameAdvisories: matchNameAdvisories,
    groupNameAdvisories: groupNameAdvisories,
  };
});
