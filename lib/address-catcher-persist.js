'use strict';

// Address Catcher survive-navigation persistence — the DOM-free, storage-free
// SHAPE of what the tool persists so its loaded reports survive navigating to
// the dashboard and back (PRD #396, issue #397; design in ADR-0016). Mirrors
// lib/address-catcher-session.js's posture: this lib computes the snapshot /
// restore shape and the last-load-replace semantics; the PAGE owns the actual
// IndexedDB read/write (its own device-local store, parallel to the IBNO
// Coder's `ibno_archive`).
//
// SCOPE (this issue): persist the loaded reports' RAW ROWS — the two Standing
// Reports (Address Corrections, Manual Assignment Detail) and the Daily
// Inbound (Inbound and Van Scans) — so returning from the dashboard no longer
// forces a re-drop. The derived worklist is NOT persisted: on restore the page
// recomputes it from the restored rows against the CURRENT dictionary, so a
// restored worklist can never be stale relative to what the dictionary now
// knows. The cross-day replace-vs-merge freshness UI (#398/#399) is separate.
//
// PRIVACY (ADR-0012 / ADR-0016): the raw rows carry recipient names and
// addresses (PII). They are persisted DEVICE-LOCAL only (IndexedDB) and are
// NEVER synced to GitHub or any remote — this module exposes no sync path and
// none may be added. Syncing address data off the device is the worst-class,
// irreversible failure this design exists to prevent.
//
// Last-load-replace: the persisted raw-row snapshot is the LAST-LOADED report
// of each type (single-load, per ADR-0015). A new drop of a type REPLACES that
// type's snapshot (this module's `replace`); the accumulating Address
// Correction Dictionary keeps merging separately and is untouched here.
//
// Pure + dual-loadable, no build step (mirrors lib/address-catcher-session.js):
// - Browser: window.AddressCatcherPersist
// - Node: require('./lib/address-catcher-persist')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AddressCatcherPersist = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // The three report types the Address Catcher loads. These are the persisted
  // snapshot keys (the IndexedDB store keys on the type), and the shape restore
  // rebuilds the page's `state` from.
  const REPORT_TYPES = ['corrections', 'assignment', 'inbound'];

  // Device-local IndexedDB store identity, kept here so the page and its tests
  // reference one source of truth. This is the Address Catcher's OWN store,
  // deliberately SEPARATE from the IBNO Coder's `ibno_archive` (ADR-0016).
  const DB_NAME = 'address_catcher_reports';
  const STORE = 'reports';
  const VERSION = 1;

  function isValidType(type) {
    return REPORT_TYPES.indexOf(type) !== -1;
  }

  // snapshot(type, rows, meta) -> the persist payload for ONE report type, or
  // null for an invalid type / non-array rows (never persist garbage). `rows`
  // is the raw parsed rows exactly as the page holds them in `state[type]`, so
  // restore can hand them straight back to the matcher / raw-data viewer. The
  // record is keyed on `type` so a new drop of the same type overwrites it
  // (last-load-replace). meta is optional { fileName, savedAt }.
  function snapshot(type, rows, meta) {
    if (!isValidType(type) || !Array.isArray(rows)) return null;
    const m = meta || {};
    return {
      type: type,
      rows: rows,
      fileName: m.fileName == null ? '' : String(m.fileName),
      savedAt: m.savedAt == null ? Date.now() : m.savedAt,
    };
  }

  // restore(entries) -> { corrections, assignment, inbound } — each is the
  // report's raw rows array, or null if nothing of that type is persisted.
  // Accepts the array of stored snapshot records (what the page reads back from
  // the store); ignores unknown types and malformed records, so a partial /
  // legacy store never throws. This is what the page uses to rebuild `state`
  // and then recompute the worklist from.
  function restore(entries) {
    const out = { corrections: null, assignment: null, inbound: null };
    if (!Array.isArray(entries)) return out;
    for (const rec of entries) {
      if (!rec || !isValidType(rec.type) || !Array.isArray(rec.rows)) continue;
      out[rec.type] = rec.rows;
    }
    return out;
  }

  // replace(entries, snap) -> a NEW entries array with `snap` replacing any
  // existing record of the same type (last-load-replace for the raw snapshot).
  // Pure: does not mutate the input. This is the raw-row half of ADR-0016's
  // "replace snapshot, merge dictionary" split — the dictionary merge lives in
  // AddressCatcherSession and is deliberately NOT touched here, so persistence
  // adds durability without altering how the dictionary learns or ages.
  function replace(entries, snap) {
    const base = Array.isArray(entries) ? entries : [];
    if (!snap || !isValidType(snap.type)) return base.slice();
    const out = base.filter(function (rec) { return !rec || rec.type !== snap.type; });
    out.push(snap);
    return out;
  }

  // ── Loud storage writes (issue #496) ───────────────────────────────────
  //
  // The Address Correction Dictionary, the Area Dictionary and the correction
  // feedback log are the tool's ACCUMULATED LEARNING, and they live in
  // localStorage (~5 MB per origin). #496 measured the serialized dictionary at
  // ~2.5 MB from one real export, and `correctionHistory[group].trackingSeen`
  // is uncapped by design (lib/address-dictionary.js) — so the footprint grows
  // with every corrections drop and the headroom shrinks. Until #496 every one
  // of those writes was a bare `try { setItem } catch (e) {}`: on a full store
  // the learning silently stopped accumulating and the operator was told
  // nothing. That is the exact shape that bit the IBNO Coder's Repeat History,
  // where a full quota presented as "a refresh re-inputs the CSV" rather than
  // as "storage is full".
  //
  // So this is the deliberate opposite of lib/tool-helpers.js's fail-soft
  // `createStorage().set` (which returns false and lets callers ignore it):
  // here a refused write is reported to the caller with enough detail to put a
  // BANNER on screen, matching the IBNO Coder's #storage-warning posture (tell
  // the user, never block the session).
  //
  // Two things beyond "did it throw":
  //
  // 1. REMOVE BEFORE WRITE. Replacing a key in a near-full store needs
  //    transient room for BOTH copies at once, so an in-place overwrite can be
  //    refused even when the new value is the same size as the old. Removing
  //    first guarantees the write can reuse that space — the same trick
  //    ibno-coder.html's persistSession() uses, and on its own it fixes the
  //    common "storage full, dictionary barely grew" case.
  //
  // 2. RESTORE ON FAILURE. Step 1 means a failed write would otherwise leave
  //    the key GONE, destroying a dictionary that took months of drops to
  //    accumulate — strictly worse than the silent no-op it replaces. So the
  //    previous serialized value is read first and written back when the new
  //    write is refused. Worst case the store keeps what it had and the banner
  //    says the new learning did not save.

  // isQuotaError(e) -> true when a storage write was refused for SPACE, across
  // the names/codes browsers actually use. Chrome/Safari throw a DOMException
  // named QuotaExceededError (legacy code 22); Firefox has historically used
  // NS_ERROR_DOM_QUOTA_REACHED (code 1014). Anything else (a private-mode
  // SecurityError, no store at all) is still a refused write and still worth a
  // banner — it just isn't a QUOTA one, and the caller can say so.
  function isQuotaError(e) {
    if (!e) return false;
    const name = String(e.name || '');
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
    return e.code === 22 || e.code === 1014;
  }

  // quotaSafeWrite(store, key, json) -> { ok, quota, lost }
  //   ok    — the value is now in the store
  //   quota — the write was refused specifically because the store is full
  //   lost  — the PREVIOUS value is gone: the fallback path removed it and the
  //           restore was refused too. The caller must say so; "what you had
  //           is still there" would be a lie.
  // Never throws. `store` is any localStorage-shaped object
  // (getItem/setItem/removeItem), which is what makes this testable in Node.
  //
  // Order matters (PR #960 review, F1): the in-place write goes FIRST, so a
  // healthy persist never touches removeItem and never opens a window in
  // which the key is absent. Only a refused in-place write falls back to
  // read → remove → rewrite, and only that path can lose the value.
  function quotaSafeWrite(store, key, json) {
    if (!store) return { ok: false, quota: false, lost: false };
    let firstErr = null;
    try {
      store.setItem(key, json);
      return { ok: true, quota: false, lost: false };
    } catch (e) { firstErr = e; }
    // Refused in place. A near-full store may still take the new value once
    // the old copy is gone (see step 1 above) — try that, restoring on failure.
    let prev = null;
    try { prev = store.getItem(key); } catch (e) { prev = null; }
    if (prev == null) return { ok: false, quota: isQuotaError(firstErr), lost: false };
    try { store.removeItem(key); } catch (e) { return { ok: false, quota: isQuotaError(firstErr), lost: false }; }
    try {
      store.setItem(key, json);
      return { ok: true, quota: false, lost: false };
    } catch (e) {
      let lost = false;
      try { store.setItem(key, prev); } catch (e2) { lost = true; }
      if (lost) { try { lost = store.getItem(key) !== prev; } catch (e3) { lost = true; } }
      return { ok: false, quota: isQuotaError(e), lost: lost };
    }
  }

  // storageWarningText(labels, quota) -> the banner sentence naming WHICH
  // stores were refused. Naming them is the whole point: "storage is full" on
  // its own leaves the operator guessing whether they just lost today's coding,
  // their dictionary, or nothing at all. Pure string building so the wording is
  // pinned by a unit test and the page owns only the DOM.
  function joinNames(arr) {
    const named = (Array.isArray(arr) ? arr : []).filter(Boolean);
    if (!named.length) return '';
    return named.length === 1
      ? named[0]
      : named.slice(0, -1).join(', ') + ' and ' + named[named.length - 1];
  }

  // lostLabels (optional): stores whose PREVIOUS value could not be put back
  // (quotaSafeWrite returned lost:true). Those get the honest sentence — the
  // earlier learning is gone from this browser — instead of "still there".
  function storageWarningText(labels, quota, lostLabels) {
    const list = joinNames(labels);
    if (!list) return '';
    const lost = joinNames(lostLabels);
    const why = quota
      ? 'This browser\u2019s storage is full'
      : 'This browser is refusing to save to device-local storage (private mode or a blocked/full disk)';
    const tail = lost
      ? 'Worse: the ' + lost + ' could not be put back either, so what this browser had learned before is GONE. ' +
        'Free up space in this browser (or clear this site\u2019s old data), then re-drop every report you still have to rebuild it.'
      : 'What you have learned before this is still there, but anything learned from here on is lost on refresh. ' +
        'Free up space in this browser (or clear this site\u2019s old data) and re-drop the report.';
    return '\u26A0 ' + why + ', so the ' + list + ' did NOT save. ' + tail;
  }

  return {
    REPORT_TYPES: REPORT_TYPES,
    DB_NAME: DB_NAME,
    STORE: STORE,
    VERSION: VERSION,
    snapshot: snapshot,
    restore: restore,
    replace: replace,
    isQuotaError: isQuotaError,
    quotaSafeWrite: quotaSafeWrite,
    storageWarningText: storageWarningText,
  };
});
