'use strict';

// Correction Feedback Loop — the log model (issue #424, PRD #423, ADR-0018).
//
// The PURE model behind the Address Catcher's first write: a reject record
// keyed to the `original -> corrected` mapping. Tyler rejects a wrong
// correction on the worklist; that reject is LOGGED here (device-local this
// slice), with a reason category and an optional note. It does NOT change what
// the worklist suggests — this model only records judgments; applying an
// override is a later slice (correction-overrides.js, #426).
//
// Design invariants (all enforced/tested):
//   - PURE: no DOM, no network, and NO clock read inside — every mutator takes
//     the timestamp as a parameter so the model is deterministic and unit-
//     testable. The page (address-catcher.html) supplies `now`.
//   - Keyed to the FULL mapping (original AND corrected), never the original
//     alone — so if the dictionary later maps the same original to a DIFFERENT
//     corrected value, that new mapping is judged fresh (mirrors the PRD's
//     override-keying rule).
//   - Dedupe / last-write-wins merge on the same mapping key; tombstones for
//     removals; a logged -> promoted status transition (promotion itself is a
//     later slice, but the status field and transition live here).
//   - Carries mapping + category + note + status only. No recipient names, no
//     tracking numbers (PRD PII wall — the mapping addresses ARE the key).
//
// Dual-loadable with no build step:
// - Browser: window.CorrectionLog
// - Node: require('./lib/correction-log')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CorrectionLog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // The four reason categories, EXACTLY (PRD #423 / #424 acceptance). Each maps
  // to an override effect in a later slice; the order here is the order the
  // picker offers them.
  const CATEGORIES = [
    'wrong destination',
    'wrong work area',
    'not always right / context-dependent',
    'outdated / forward ended',
  ];

  // The four AREA VERDICT categories, EXACTLY (issue #452, slice 6 of #446).
  // The Area Verdict Loop reuses this SAME log + promote mechanism (ADR-0018)
  // for per-area-card verdicts, so these live alongside the correction reject
  // categories but are a DISJOINT vocabulary: a verdict is logged with
  // logAreaVerdict() (kind === 'area') and each category maps to an area
  // resolution effect in lib/correction-overrides.js (strengthen / suppress /
  // demote / keep). Order here is the order the picker offers them.
  const AREA_CATEGORIES = [
    'confirmed missort',
    'routing changed / history stale',
    'legitimately multi-area',
    'wrong contractor / plotting issue reported',
  ];

  const STATUS = { LOGGED: 'logged', PROMOTED: 'promoted' };

  function isValidCategory(category) {
    return CATEGORIES.indexOf(category) !== -1;
  }

  function isValidAreaCategory(category) {
    return AREA_CATEGORIES.indexOf(category) !== -1;
  }

  // Normalize one side of a mapping for a stable key: trim, collapse internal
  // whitespace, uppercase. So two rejects of the "same" mapping that differ
  // only in incidental spacing/case dedupe to one record. Display strings are
  // preserved separately on the record.
  function normalizeSide(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toUpperCase();
  }

  // The mapping key: original AND corrected, joined by a separator that cannot
  // occur in a normalized address. Keying on BOTH sides is the PRD's rule.
  function mappingKey(original, corrected) {
    return normalizeSide(original) + ' → ' + normalizeSide(corrected);
  }

  function isTombstone(rec) {
    return !!(rec && rec.tombstone === true);
  }

  // A reject is "pending" (Tyler can see it needs review) while it is logged,
  // not promoted, and not tombstoned.
  function isPending(rec) {
    return !!(rec && !isTombstone(rec) && rec.status === STATUS.LOGGED);
  }

  // Find the record for a mapping key (active or tombstoned). Returns null if
  // absent. Pure lookup; does not mutate.
  function getRecord(log, key) {
    const list = Array.isArray(log) ? log : [];
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].key === key) return list[i];
    }
    return null;
  }

  // The active (non-tombstoned) record for a mapping key, or null.
  function getActive(log, key) {
    const rec = getRecord(log, key);
    return rec && !isTombstone(rec) ? rec : null;
  }

  // Every active (non-tombstoned) record — what a UI lists as pending/promoted.
  function activeRecords(log) {
    return (Array.isArray(log) ? log : []).filter(function (r) { return r && !isTombstone(r); });
  }

  // Upsert a reject for a mapping. If a record for the key already exists it is
  // UPDATED in place (category/note refreshed, updatedAt bumped, any tombstone
  // cleared) — never duplicated — so re-rejecting the same mapping stays one
  // record. Existing status is preserved (re-logging a promoted mapping does
  // not silently demote it). Returns a NEW array; input is not mutated.
  function logReject(log, input, now) {
    const original = input && input.original;
    const corrected = input && input.corrected;
    const category = input && input.category;
    if (!isValidCategory(category)) {
      throw new Error('logReject: unknown category ' + JSON.stringify(category));
    }
    const note = input && input.note != null ? String(input.note) : '';
    const key = mappingKey(original, corrected);
    const list = Array.isArray(log) ? log.slice() : [];
    const existing = getRecord(list, key);
    const record = {
      key: key,
      original: String(original == null ? '' : original),
      corrected: String(corrected == null ? '' : corrected),
      category: category,
      note: note,
      status: existing && existing.status === STATUS.PROMOTED ? STATUS.PROMOTED : STATUS.LOGGED,
      updatedAt: now,
      tombstone: false,
    };
    return upsert(list, record);
  }

  // areaMappingKey(areaKey, area) — the stable key for an AREA VERDICT
  // (issue #452): the Area Dictionary entry's street+ZIP5 identity (areaKey,
  // = AreaDictionary.resolveEntries()' entry.key) AND the mainly-assigned
  // area it was judged against, keyed to BOTH sides exactly as mappingKey()
  // keys a correction to original+corrected. So if the dominant area later
  // changes, the old verdict is judged fresh and simply stops matching. Reuses
  // mappingKey() verbatim — an areaKey always contains '|' (street|ZIP5) and a
  // correction original never does, so the two key spaces never collide.
  function areaMappingKey(areaKey, area) {
    return mappingKey(areaKey, area);
  }

  function isAreaRecord(rec) {
    return !!(rec && rec.kind === 'area');
  }

  // logAreaVerdict(log, input, now) — upsert a per-area-card verdict onto the
  // SAME log logReject writes to (one store, one sync branch, ADR-0018).
  // input: { areaKey, area, addressDisplay?, category, note? }. The record
  // carries kind:'area' + areaKey + area so the override-apply engine keys off
  // the stable street+ZIP5 identity, plus original/corrected display strings
  // (addressDisplay and "Area <area>") so the shared review overlay renders it
  // with no special-casing. Dedupe / promoted-status preservation / tombstone
  // handling are the SAME as logReject (upsert by key). Returns a NEW array.
  function logAreaVerdict(log, input, now) {
    const areaKey = input && input.areaKey;
    const area = input && input.area;
    const category = input && input.category;
    if (!isValidAreaCategory(category)) {
      throw new Error('logAreaVerdict: unknown area category ' + JSON.stringify(category));
    }
    const note = input && input.note != null ? String(input.note) : '';
    const key = areaMappingKey(areaKey, area);
    const list = Array.isArray(log) ? log.slice() : [];
    const existing = getRecord(list, key);
    const areaStr = String(area == null ? '' : area);
    const record = {
      key: key,
      kind: 'area',
      areaKey: String(areaKey == null ? '' : areaKey),
      area: areaStr,
      original: input && input.addressDisplay != null ? String(input.addressDisplay) : String(areaKey == null ? '' : areaKey),
      corrected: 'Area ' + areaStr,
      category: category,
      note: note,
      status: existing && existing.status === STATUS.PROMOTED ? STATUS.PROMOTED : STATUS.LOGGED,
      updatedAt: now,
      tombstone: false,
    };
    return upsert(list, record);
  }

  // Tombstone the reject for a mapping (Tyler un-rejects). The record is kept
  // as a tombstone so the removal propagates on a later sync. No-op-safe if the
  // mapping was never rejected (a fresh tombstone is written so a later merge
  // still sees the removal intent). Returns a NEW array.
  function unReject(log, key, now) {
    const list = Array.isArray(log) ? log.slice() : [];
    const existing = getRecord(list, key);
    const record = Object.assign({}, existing, {
      key: key,
      tombstone: true,
      updatedAt: now,
    });
    // Ensure the shape is complete even if there was no prior record.
    if (record.status !== STATUS.PROMOTED) record.status = STATUS.LOGGED;
    if (record.category == null) record.category = null;
    if (record.note == null) record.note = '';
    return upsert(list, record);
  }

  // logged -> promoted. Promotion begins applying an override in a later slice;
  // here it is only the status transition. No-op-safe: promoting an absent or
  // tombstoned mapping returns the log unchanged. Returns a NEW array.
  function promote(log, key, now) {
    return transition(log, key, STATUS.PROMOTED, now);
  }

  // promoted -> logged (Tyler un-promotes; the override stops applying). Returns
  // a NEW array; no-op-safe.
  function unPromote(log, key, now) {
    return transition(log, key, STATUS.LOGGED, now);
  }

  function transition(log, key, status, now) {
    const list = Array.isArray(log) ? log.slice() : [];
    const existing = getRecord(list, key);
    if (!existing || isTombstone(existing)) return list; // nothing active to transition
    if (existing.status === status) return list; // already there
    const record = Object.assign({}, existing, { status: status, updatedAt: now });
    return upsert(list, record);
  }

  // Replace-or-append a record by key. Pure over `list` (already a copy).
  function upsert(list, record) {
    const idx = list.findIndex(function (r) { return r && r.key === record.key; });
    if (idx === -1) list.push(record);
    else list[idx] = record;
    return list;
  }

  // Last-write-wins merge of two logs by mapping key. For a shared key the
  // record with the higher updatedAt wins (tombstones included, so removals
  // propagate). Deterministic on ties: `a` wins, so pass the incoming/local
  // list you want to prefer as the first argument. Pure; inputs not mutated.
  function merge(listA, listB) {
    const byKey = Object.create(null);
    function absorb(list, preferOnTie) {
      (Array.isArray(list) ? list : []).forEach(function (rec) {
        if (!rec || rec.key == null) return;
        const existing = byKey[rec.key];
        if (!existing) { byKey[rec.key] = rec; return; }
        const ax = rec.updatedAt || '';
        const bx = existing.updatedAt || '';
        if (ax > bx || (ax === bx && preferOnTie)) byKey[rec.key] = rec;
      });
    }
    absorb(listB, false);
    absorb(listA, true); // A absorbed second with tie-preference so A wins ties
    return Object.keys(byKey).map(function (k) { return byKey[k]; });
  }

  return {
    CATEGORIES: CATEGORIES,
    AREA_CATEGORIES: AREA_CATEGORIES,
    STATUS: STATUS,
    isValidCategory: isValidCategory,
    isValidAreaCategory: isValidAreaCategory,
    mappingKey: mappingKey,
    areaMappingKey: areaMappingKey,
    isAreaRecord: isAreaRecord,
    normalizeSide: normalizeSide,
    isTombstone: isTombstone,
    isPending: isPending,
    getRecord: getRecord,
    getActive: getActive,
    activeRecords: activeRecords,
    logReject: logReject,
    logAreaVerdict: logAreaVerdict,
    unReject: unReject,
    promote: promote,
    unPromote: unPromote,
    merge: merge,
  };
});
