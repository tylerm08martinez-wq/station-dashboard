'use strict';

// Quick-Capture record model (issue #349 slice 1, issue #350 slice 2 of PRD
// #348).
//
// A Capture is a freeform, timestamped note Tyler jots mid-sort — see
// CONTEXT.md's Capture / Follow-up glossary entries. This module owns the
// pure record model: creating a capture (optionally flagged a Follow-up),
// tombstoning one (delete), resolving a Follow-up (outcome + timestamp), the
// active (non-tombstoned) list most-recent-first, and — slice 2 — the
// day-granular pendingFollowUps() selection. Sync/merge and the sweep are
// later slices (3-4).
//
// Clock-injectable throughout (never `new Date()` implicitly) so tests never
// hardcode a calendar date/time that ages out — the ibno-dom date-rot lesson
// (commit ac83254) applies here too.
//
// DAY-GRANULARITY (#338 lesson, mirrored from lib/address-dictionary.js's
// trustedEntries): a Follow-up's flag date (its createdAt) is compared
// against `asOfDay` at UTC-calendar-day granularity, never ms-vs-day mixing.
// A Follow-up created at any time today never pins until the caller's
// `asOfDay` rolls to a later UTC calendar day — the boundary is the DATE,
// never the time-of-day or the caller's local timezone.
//
// updatedAt (added slice 3, issue #351): every mutation (create/resolve/
// remove) stamps `updatedAt` to the injected/real clock, mirroring
// entries-sync.js's touch()/tombstone() convention. This is what lets
// lib/captures-sync.js's last-write-wins merge order two edits of the same
// record across devices (e.g. a resolve on one device racing a delete on
// another) without adding a separate module just to bolt a timestamp on.
//
// Dual-loadable with no build step:
// - Browser: window.Captures
// - Node: require('./lib/captures')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Captures = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // Client-generated id — same convention as time-off-log.html's entries
  // (base36 timestamp + a few random base36 chars): unique enough for a
  // single-user multi-device tool, sortable-ish, no dependency on
  // crypto.randomUUID (not available in every embedded/older browser).
  function genId(now) {
    const t = (now == null ? Date.now() : now).toString(36);
    const r = Math.random().toString(36).slice(2, 6);
    return t + r;
  }

  function nowIso(now) {
    return new Date(now == null ? Date.now() : now).toISOString();
  }

  // Floor an instant to its UTC calendar day, expressed in epoch ms — same
  // convention as address-dictionary.js's trustedEntries() day-granularity
  // fix (#338): comparisons key off the DATE, never the time-of-day.
  // Accepts anything `new Date()` parses (ms epoch, ISO string, Date).
  // Returns NaN for an unparseable input so callers can detect it.
  function dayFloorMs(value) {
    const d = new Date(value == null ? Date.now() : value);
    if (isNaN(d.getTime())) return NaN;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const STALE_AFTER_DAYS = 14;

  // create(text, options) -> a new capture record, or null when text is
  // empty/whitespace-only (the "whitespace-only saves do nothing" AC lives
  // here so every caller — page or future adapter — gets it for free).
  //
  // options:
  //   now      - clock injection point (ms epoch or anything `new Date()`
  //              accepts); defaults to the real clock.
  //   id       - override the generated id (tests only need this rarely).
  //   followUp - true to mark this capture a Follow-up at save time (the
  //              "check tomorrow" toggle, issue #350). Defaults to false.
  //              The flag date IS createdAt — there is no separate flaggedAt
  //              field, since a Follow-up is flagged at the moment it's
  //              created (CONTEXT.md: "flagged 'check tomorrow'").
  //
  // Reserved/owned fields: resolvedAt (iso string or null), outcome (string
  // or null) — set later via resolve(), never at create() time.
  function create(text, options) {
    const opts = options || {};
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) return null;
    const now = opts.now;
    const stamp = nowIso(now);
    return {
      id: opts.id || genId(now),
      text: text, // verbatim, not the trimmed copy — only emptiness is judged on trim
      createdAt: stamp,
      followUp: !!opts.followUp,
      resolvedAt: null,
      outcome: null,
      deleted: false,
      updatedAt: stamp,
    };
  }

  // resolve(capture, outcome, options) -> a new record (pure, does not
  // mutate) with resolvedAt set to the injected/real clock and outcome set
  // to the trimmed one-line text, or null when omitted/blank (the AC says
  // outcome is optional). Attempt (the original capture) and outcome both
  // remain in history — resolve() never drops createdAt/text/followUp.
  function resolve(capture, outcome, options) {
    if (!capture) return capture;
    const opts = options || {};
    const trimmedOutcome = typeof outcome === 'string' ? outcome.trim() : '';
    const out = {};
    for (const k in capture) if (Object.prototype.hasOwnProperty.call(capture, k)) out[k] = capture[k];
    const stamp = nowIso(opts.now);
    out.resolvedAt = stamp;
    out.outcome = trimmedOutcome || null;
    out.updatedAt = stamp;
    return out;
  }

  function isResolved(capture) {
    return !!(capture && capture.resolvedAt);
  }

  // pendingFollowUps(captures, asOfDay) -> Follow-ups that should render
  // pinned above the capture box right now, oldest-flagged-first.
  //
  // A capture qualifies when: it is an active (non-tombstoned) Follow-up,
  // unresolved, AND its flag date (createdAt) falls on a UTC calendar day
  // strictly BEFORE asOfDay's UTC calendar day. A Follow-up flagged the same
  // day as asOfDay is excluded — it stays out until the next local day (AC).
  //
  // Each returned item is the original capture plus a `stale` boolean: true
  // once asOfDay is STALE_AFTER_DAYS (14) or more UTC calendar days past the
  // flag date. Stale Follow-ups are still returned (pinned), never dropped.
  //
  // asOfDay defaults to the real clock; accepts anything `new Date()` parses
  // so callers/tests can inject "today" without touching global state.
  function pendingFollowUps(captures, asOfDay) {
    const asOfFloor = dayFloorMs(asOfDay == null ? Date.now() : asOfDay);
    if (isNaN(asOfFloor)) return [];

    return (Array.isArray(captures) ? captures : [])
      .filter(function (c) { return c && !isTombstone(c) && c.followUp && !isResolved(c); })
      .map(function (c) {
        const flagDay = dayFloorMs(c.createdAt);
        return { c: c, flagDay: flagDay };
      })
      .filter(function (x) { return !isNaN(x.flagDay) && x.flagDay < asOfFloor; })
      .sort(function (a, b) { return a.flagDay - b.flagDay; }) // oldest first
      .map(function (x) {
        const ageDays = Math.floor((asOfFloor - x.flagDay) / MS_PER_DAY);
        const out = {};
        for (const k in x.c) if (Object.prototype.hasOwnProperty.call(x.c, k)) out[k] = x.c[k];
        out.stale = ageDays >= STALE_AFTER_DAYS;
        return out;
      });
  }

  function isTombstone(capture) {
    return !!(capture && capture.deleted);
  }

  // Tombstone a capture: keep id/text/createdAt (retained in the model per
  // the AC), mark deleted, stamp updatedAt. Pure — returns a new object, does
  // not mutate. `options.now` is the usual clock-injection point; omit it to
  // stamp the real clock.
  function remove(capture, options) {
    if (!capture) return capture;
    const opts = options || {};
    const out = {};
    for (const k in capture) if (Object.prototype.hasOwnProperty.call(capture, k)) out[k] = capture[k];
    out.deleted = true;
    out.updatedAt = nowIso(opts.now);
    return out;
  }

  // touch(capture, now) -> a new record with updatedAt bumped, everything
  // else unchanged. Not used by create/resolve/remove (they stamp inline),
  // but exposed for lib/captures-sync.js and any future caller that needs to
  // bump a record without otherwise changing it (mirrors entries-sync.js's
  // touch()). Pure.
  function touch(capture, now) {
    if (!capture) return capture;
    const out = {};
    for (const k in capture) if (Object.prototype.hasOwnProperty.call(capture, k)) out[k] = capture[k];
    out.updatedAt = nowIso(now);
    return out;
  }

  // backfillUpdatedAt(list) -> every record guaranteed an updatedAt, backfilled
  // from createdAt for pre-sync local data that predates this field (slice
  // 1-2 captures saved before slice 3 shipped). Mirrors entries-sync.js's
  // backfillUpdatedAt so a genuine future edit always outranks old data with
  // no stamp, rather than a missing field comparing unpredictably.
  function backfillUpdatedAt(list) {
    return (Array.isArray(list) ? list : []).map(function (c) {
      if (c && c.updatedAt) return c;
      if (!c) return c;
      const out = {};
      for (const k in c) if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k];
      out.updatedAt = c.createdAt || '1970-01-01T00:00:00.000Z';
      return out;
    });
  }

  // Live (non-tombstoned) captures, most-recent-first by createdAt. Stable
  // tiebreak on equal timestamps (explicit index, never relies on Array.sort
  // stability assumptions across engines).
  function activeCaptures(list) {
    return (Array.isArray(list) ? list : [])
      .filter(function (c) { return c && !isTombstone(c); })
      .map(function (c, i) { return { c: c, i: i }; })
      .sort(function (a, b) {
        const ad = String(a.c.createdAt || '');
        const bd = String(b.c.createdAt || '');
        if (ad > bd) return -1;
        if (ad < bd) return 1;
        return b.i - a.i; // later-inserted wins the tie (most-recent-first)
      })
      .map(function (x) { return x.c; });
  }

  return {
    genId: genId,
    nowIso: nowIso,
    dayFloorMs: dayFloorMs,
    create: create,
    resolve: resolve,
    isResolved: isResolved,
    isTombstone: isTombstone,
    remove: remove,
    touch: touch,
    backfillUpdatedAt: backfillUpdatedAt,
    activeCaptures: activeCaptures,
    pendingFollowUps: pendingFollowUps,
    STALE_AFTER_DAYS: STALE_AFTER_DAYS,
  };
});
