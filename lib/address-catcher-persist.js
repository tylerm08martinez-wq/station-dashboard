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

  return {
    REPORT_TYPES: REPORT_TYPES,
    DB_NAME: DB_NAME,
    STORE: STORE,
    VERSION: VERSION,
    snapshot: snapshot,
    restore: restore,
    replace: replace,
  };
});
