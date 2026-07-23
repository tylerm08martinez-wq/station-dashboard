'use strict';

// Date-guarded daily persistence for the DSW page (slice #276, PRD #273).
//
// DSW is a once-a-day tool. A refresh or same-day tab reopen should restore the
// computed flagged rows (so you don't re-drop both reports), but it must NEVER
// surface a previous day's flags — acting on yesterday's stale In-Area 12 list
// is a wrong call. So every record is stamped with the day it was computed, and
// load() returns the payload ONLY when that stamp equals today; otherwise it
// clears the entry and returns null.
//
// Storage is injected (any object with getItem/setItem/removeItem) so the logic
// is testable without a browser: the page passes window.localStorage; tests
// pass a fake. Dual-loadable, no build step (mirrors lib/in-area-12.js).
//
// - Browser: window.DailyStore
// - Node: require('./lib/daily-store')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DailyStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const KEY = 'dsw_daily_flags';

  // Stamp the payload with the day it was computed and store it as JSON. `key`
  // defaults to the flags entry; pass a different key (e.g. 'dsw_excluded') to
  // keep an independent, separately date-guarded entry in the same storage.
  function save(store, date, payload, key) {
    if (!store) return;
    try {
      store.setItem(key || KEY, JSON.stringify({ date: String(date), payload: payload }));
    } catch (e) { /* storage full/unavailable — persistence is best-effort */ }
  }

  // Return the payload only if it was computed today; otherwise clear it and
  // return null. Missing/corrupt entries also yield null (and are cleared).
  function load(store, today, key) {
    if (!store) return null;
    const k = key || KEY;
    let raw;
    try { raw = store.getItem(k); } catch (e) { return null; }
    if (raw == null) return null;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { remove(store, k); return null; }
    if (!parsed || parsed.date !== String(today)) { remove(store, k); return null; }
    return parsed.payload;
  }

  function remove(store, key) {
    try { store.removeItem(key || KEY); } catch (e) { /* nothing to clean up */ }
  }

  return { save: save, load: load, remove: remove, KEY: KEY };
});
