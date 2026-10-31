'use strict';

// THE GENERAL PER-TRACKING OVERRIDE STORE (#1000, spec #996, direction #997).
//
// A RULE IS A GUESS ABOUT A PACKAGE; AN OVERRIDE IS A PERSON'S ANSWER. This
// store holds the second kind, keyed by tracking number, and everything that
// reads it applies one sentence: the override beats the rule, on every drop,
// until it is taken back.
//
// NOTHING IN HERE IS STATION-SPECIFIC, AND THAT IS THE POINT (spec #996 story
// 33, follow-up #997). The Station pane is only the first caller. The module is
// named `tracking-overrides` rather than `station-overrides`, the record says
// `kind` rather than `station`, and the API — set / clear / lookup — knows
// nothing about panes, addresses or reports. #997 collects the rest (auto-65,
// lane assignment, 503 derivation, park-prune, a Move to… on every row), and
// it extends THIS store rather than inventing a second one. Adding a kind is a
// one-line change to KINDS plus its own reader; adding a Station-shaped
// assumption to this file is the thing that would make #997 write a new store.
//
// THE THREE KINDS THIS TICKET SHIPS, each the record of one control:
//
//   station ....... "Send to Station". The package belongs in the Station pane
//                   even though the address predicate missed it.
//   not-station ... "Not ours". The package carries the station address but is
//                   not ours — it was vision-updated to our address because it
//                   needs more information (spec #996: roughly 1% of them) — so
//                   it goes back to Needs Review and stays there.
//   still-open .... "Undo". The package was INFERRED delivered by its absence
//                   from a drop, and it is in fact still out.
//
// HOW AN OVERRIDE ENDS, and the three kinds do NOT agree, deliberately:
//
//   `station` and `not-station` are statements about WHAT THE PACKAGE IS. The
//   report will keep saying the same wrong thing about it on every drop for as
//   long as it is here, so these persist until a human takes them back. An
//   override that quietly expired would hand Tyler the identical stray to
//   re-judge every sort, which is the state the feature exists to end.
//
//   `still-open` is a statement about ONE INFERENCE drawn from ONE absence. The
//   moment the report carries the package again, the inference it contradicts
//   is gone and the override has nothing left to say — so `clearReappeared`
//   retires it. Leaving it would be worse than useless: it is wired in as the
//   veto on the absence sweep (lib/station-store.js's `isHeldOpen`), so a stale
//   one would make that package permanently undeliverable, and the Admin's list
//   would never lose it again.
//
// A LABEL HOLDS AT MOST ONE OVERRIDE. `station` and `not-station` are opposite
// answers to one question, so `set` replaces rather than accumulates, and that
// is also how each is taken back: Send to Station on a row Tyler has marked Not
// ours is the undo of that, with no separate clear-the-override UI (which is
// #997's, not this ticket's).
//
// EVERY RECORD CARRIES ITS DAY AND ITS DEVICE. Neither is read by any rule
// here — they exist because #996 story 26 merges these across two desks through
// the Day Export and needs "most recent day wins" to be answerable, and because
// an override with no provenance is a decision nobody can be asked about. The
// Day Export wiring itself is NOT in this ticket.
//
// NOTHING IN HERE IS A RECORD. No code, no disposition, nothing that reaches
// OPS2 — the same fence lib/ibno-parked.js and lib/station-store.js keep.
//
// Dual-loadable with no build step:
// - Browser: window.TrackingOverrides
// - Node:    require('./lib/tracking-overrides')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TrackingOverrides = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function deps() {
    const SortDay = (root && root.SortDay) ||
      (typeof require === 'function' ? require('./sort-day') : null);
    if (!SortDay) throw new Error('TrackingOverrides dependencies unavailable (need SortDay)');
    return { SortDay: SortDay };
  }

  function str(v) { return String(v == null ? '' : v).trim(); }

  const VERSION = 1;

  // THE localStorage KEY THE STORE LIVES UNDER, NAMED HERE SO TWO TOOLS CANNOT
  // DRIFT (#1003). ibno-coder.html WRITES this store; address-catcher.html
  // READS it (both tools are served from the same origin, so it is literally
  // the same key in the same localStorage). A second string literal on the
  // reading side would be a silent one-character failure — the reader would
  // find nothing, every override would evaporate, and no test would notice
  // because "no override" is a legal state. tests/tracking-overrides.test.js
  // pins the coder's own literal against this constant.
  const STORAGE_KEY = 'ibno_overrides';

  // THE KIND WHITELIST. An unknown kind is DROPPED on restore rather than
  // carried: a reader that does not know a kind cannot honor it, and a record
  // nothing honors sitting in the store reads as "Tyler's decision is saved"
  // while the rule quietly keeps winning. A newer build's kind arriving on an
  // older one is exactly that shape (#997 will add kinds), and losing it is the
  // honest failure — the row simply follows the rule, visibly.
  const KINDS = ['station', 'not-station', 'still-open'];

  // The kinds that do NOT survive a reappearance. See the module note:
  // `still-open` speaks about one inference and dies with it; the other two
  // speak about the package and outlive every drop.
  const SELF_CLEARING_KINDS = ['still-open'];

  function isKind(kind) { return KINDS.indexOf(str(kind)) !== -1; }

  function empty() { return { v: VERSION, items: {} }; }

  // NOT DAY-GATED, and for the same reason lib/station-store.js is not: a
  // decision Tyler made yesterday about a package that is still in the cage is
  // still his decision this morning. Gating the restore would silently reverse
  // every override at the sort-day roll, which is precisely what spec #996
  // story 19 says must not happen.
  function restore(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { return empty(); }
    }
    return serialize(parsed);
  }

  function normalizeEntry(value, key) {
    const SortDay = deps().SortDay;
    const src = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    const kind = str(src.kind);
    if (!isKind(kind)) return null;
    const out = { kind: kind };
    const day = SortDay.parseInboundDate(src.day);
    if (day) out.day = day;
    const device = str(src.device);
    if (device) out.device = device;
    const label = str(src.label) || str(key);
    if (label) out.label = label;
    return out;
  }

  function serialize(store) {
    const s = (store && typeof store === 'object' && !Array.isArray(store)) ? store : {};
    const out = empty();
    const items = (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) ? s.items : {};
    Object.keys(items).forEach(function (k) {
      const key = str(k);
      if (!key) return;
      const entry = normalizeEntry(items[k], key);
      if (entry) out.items[key] = entry;
    });
    return out;
  }

  function entries(store) { return serialize(store).items; }

  // ─── LOOKUP ───────────────────────────────────────────────────────────────

  function get(store, label) { return entries(store)[str(label)] || null; }

  // kindOf(store, label) -> the kind string, or '' when this package has no
  // override. ONE FUNCTION ANSWERS "what did the human say about this package",
  // so a caller that branches on the answer cannot disagree with a caller that
  // asks has(). ADR 0022's rule, applied to this store.
  function kindOf(store, label) {
    const entry = get(store, label);
    return entry ? entry.kind : '';
  }

  function has(store, label, kind) {
    const k = kindOf(store, label);
    if (!k) return false;
    return kind == null ? true : k === str(kind);
  }

  function labelsOfKind(store, kind) {
    const items = entries(store);
    const want = str(kind);
    return Object.keys(items).filter(function (l) { return items[l].kind === want; });
  }

  // ─── WRITES (each returns a NEW store, the lib/station-store.js convention:
  // the caller persists the result and can still hold the previous value) ────

  function set(store, label, kind, opts) {
    const SortDay = deps().SortDay;
    const next = serialize(store);
    const l = str(label);
    const k = str(kind);
    // A blank label or an unknown kind CHANGES NOTHING rather than writing a
    // record nothing can honor.
    if (!l || !isKind(k)) return next;
    const o = opts || {};
    const entry = { kind: k, label: l };
    // THE SORT DAY, NEVER THE DEVICE CLOCK. Station 849's sort starts around
    // 1:30 AM and crosses midnight every night, so `new Date()` names the wrong
    // day for half of every shift — the hazard lib/sort-day.js exists for. The
    // caller passes the page's monotonic sort day; an unreadable one records no
    // day at all rather than a wrong one.
    const day = SortDay.parseInboundDate(o.day);
    if (day) entry.day = day;
    const device = str(o.device);
    if (device) entry.device = device;
    next.items[l] = entry;
    return next;
  }

  function clear(store, label) {
    const next = serialize(store);
    delete next.items[str(label)];
    return next;
  }

  // clearReappeared(store, labels) -> the self-clearing kinds retired for every
  // package the drop CARRIES, everything else left exactly as it was.
  //
  // The caller hands in the labels this drop actually contains, which is the
  // only population entitled to say "it reappeared". A `station` or
  // `not-station` override on one of those labels is untouched: the package
  // reappearing is the ordinary case for those and says nothing about them.
  function clearReappeared(store, labels) {
    const next = serialize(store);
    const list = Array.isArray(labels) ? labels : [];
    list.forEach(function (label) {
      const l = str(label);
      const entry = next.items[l];
      if (!entry) return;
      if (SELF_CLEARING_KINDS.indexOf(entry.kind) === -1) return;
      delete next.items[l];
    });
    return next;
  }

  return {
    VERSION: VERSION,
    KINDS: KINDS,
    SELF_CLEARING_KINDS: SELF_CLEARING_KINDS,
    isKind: isKind,

    STORAGE_KEY: STORAGE_KEY,
    empty: empty,
    restore: restore,
    serialize: serialize,
    entries: entries,

    get: get,
    kindOf: kindOf,
    has: has,
    labelsOfKind: labelsOfKind,

    set: set,
    clear: clear,
    clearReappeared: clearReappeared,
  };
});
