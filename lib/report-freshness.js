'use strict';

// Report freshness core — the guard against SILENT DICTIONARY STARVATION
// (PRD #396, issue #399; design in ADR-0016, decision 3).
//
// THE TRAP THIS EXISTS TO PREVENT (ADR-0016 Context): the Address Correction
// Dictionary ages a mapping out once its newest event date is older than
// `recencyWindowDays` (currently 30) before today, and `asOf` advances with
// the calendar. So a Standing Report that is persisted but never re-dropped
// will, after ~30 days, have all its mappings silently age out — the tool just
// gets quieter, with no error. This module computes each Standing Report's
// data recency and escalates a re-pull NUDGE before that 30-day cliff.
//
// DELIBERATE INVARIANTS (ADR-0016 Consequences — do NOT "simplify" these away;
// a hardcoded age-from-drop-date threshold would reintroduce silent starvation):
//
//   1. Thresholds DERIVE FROM `recencyWindowDays`, never hardcoded. Nudge
//      softly at ~half the window (~15d at 30) and firmly at ~three-quarters
//      (~22d at 30), so a re-pull reliably happens before the aging cliff. The
//      window is an INPUT so the coupling tracks any retuning of the dictionary.
//
//   2. Age is measured from the report's NEWEST EVENT DATE (corrections `Date`
//      = '1<YY><MMDD>', manual assignment `SCAN_DT1` = 'MM/DD/YYYY'), NOT the
//      drop timestamp — because dictionary aging keys on event dates, and
//      re-dropping a STALE export must not read as "fresh."
//
//   3. If the newest event date can't be parsed → treated as UNKNOWN age and
//      prompts a re-pull (never assumed fresh — failing open here would mask
//      exactly the starvation this guards against).
//
//   4. The nudge is ADVISORY ONLY. It NEVER blocks using the persisted data;
//      it just tells Tyler when to re-pull.
//
// Pure + dual-loadable, no DOM / no storage (mirrors lib/address-catcher-
// session.js and lib/address-catcher-persist.js):
//   - Browser: window.ReportFreshness
//   - Node: require('./lib/report-freshness')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ReportFreshness = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const DAY_MS = 24 * 60 * 60 * 1000;

  // The dictionary's default aging window (lib/address-dictionary.js's
  // recencyWindowDays, ADR-0016). Exposed so callers that don't thread an
  // explicit window still couple to the SAME number — but the coupling is the
  // point, so callers SHOULD pass the dictionary's actual window.
  const DEFAULT_RECENCY_WINDOW_DAYS = 30;

  // Candidate date-field names per Standing Report type. Both parsed record
  // shapes (AddressCatcherSession.parseCorrectionsRows / parseAssignmentRecords)
  // expose the event date as `.date`; the type-specific raw column names are
  // listed too so dataRecency also works if handed rawer objects. Corrections
  // = the Address Corrections Report's `Date` ('1<YY><MMDD>'); assignment = the
  // Manual Assignment Detail's `SCAN_DT1` ('MM/DD/YYYY', surfaced as scanDate).
  const DATE_FIELDS_BY_TYPE = {
    corrections: ['date', 'Date'],
    assignment: ['date', 'scanDate', 'SCAN_DT1', 'SCAN DT'],
  };

  // parseEventDate(raw) -> epoch ms (UTC midnight of the calendar day), or null
  // if unparseable. Handles every date format that flows through a Standing
  // Report, mirroring lib/address-dictionary.js's parseEntryDate PLUS the
  // manual assignment 'MM/DD/YYYY' form:
  //   - '1<YY><MMDD>'  (Address Corrections Report `Date`, e.g. '1260612')
  //   - 'MM/DD/YYYY'    (Manual Assignment Detail `SCAN_DT1`, e.g. '06/12/2026')
  //   - 'YYYY-MM-DD'    (ISO-ish, used by tests / any normalized caller)
  //   - Date.parse fallback for anything else.
  // Unlike the dictionary's forgiving aging (which fails OPEN), an unparseable
  // date here returns null so freshness can fail toward "unknown → re-pull"
  // rather than silently reading as fresh.
  function parseEventDate(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;

    // '1<YY><MMDD>' encoded corrections date.
    const encoded = /^1(\d{2})(\d{2})(\d{2})$/.exec(s);
    if (encoded) {
      const year = 2000 + Number(encoded[1]);
      const month = Number(encoded[2]);
      const day = Number(encoded[3]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        const t = Date.UTC(year, month - 1, day);
        if (!isNaN(t)) return t;
      }
      // Falls through if the digits aren't a plausible month/day.
    }

    // 'MM/DD/YYYY' manual assignment scan date.
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (us) {
      const month = Number(us[1]);
      const day = Number(us[2]);
      const year = Number(us[3]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        const t = Date.UTC(year, month - 1, day);
        if (!isNaN(t)) return t;
      }
      return null;
    }

    // 'YYYY-MM-DD' ISO-ish.
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (iso) {
      const t = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
      return isNaN(t) ? null : t;
    }

    const t = Date.parse(s);
    if (isNaN(t)) return null;
    // Normalize a generic parse to its UTC calendar day so age math stays
    // day-granular regardless of any time component.
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  // newestEventDate(records, dateField) -> epoch ms of the MAX parseable event
  // date across `records`, or null if none parse. `dateField` is a field name
  // or array of candidate field names (first non-blank wins per record).
  function newestEventDate(records, dateField) {
    if (!Array.isArray(records) || records.length === 0) return null;
    const fields = Array.isArray(dateField)
      ? dateField
      : [dateField == null ? 'date' : dateField];
    let max = null;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec || typeof rec !== 'object') continue;
      let raw = '';
      for (let f = 0; f < fields.length; f++) {
        const v = rec[fields[f]];
        if (v != null && String(v).trim() !== '') { raw = v; break; }
      }
      const t = parseEventDate(raw);
      if (t != null && (max == null || t > max)) max = t;
    }
    return max;
  }

  // dataRecency(records, reportType) -> newest event date (epoch ms) or null.
  // The AC-named entry point: `reportType` selects which date fields to read
  // ('corrections' → `Date`, 'assignment' → `SCAN_DT1`), defaulting to `.date`
  // (what both parsed record shapes expose) for an unknown/omitted type.
  function dataRecency(records, reportType) {
    const fields = DATE_FIELDS_BY_TYPE[reportType] || ['date'];
    return newestEventDate(records, fields);
  }

  // ageInDays(recency, asOf) -> whole days between `recency` and `asOf`, or null
  // if recency is null (unknown). `recency` is epoch ms (UTC midnight) or a
  // date string; `asOf` defaults to now and may carry a time-of-day — it is
  // normalized to its UTC calendar day so age is measured day-to-day, matching
  // how lib/address-dictionary.js compares lastSeen against its cutoff. A
  // future event date yields a negative age (reads as fresh).
  function ageInDays(recency, asOf) {
    let recencyMs;
    if (recency == null || recency === '') return null;
    if (typeof recency === 'number') recencyMs = recency;
    else recencyMs = parseEventDate(recency);
    if (recencyMs == null || isNaN(recencyMs)) return null;

    const ref = asOf == null ? new Date() : new Date(asOf);
    if (isNaN(ref.getTime())) return null;
    const asOfDayMs = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
    return Math.round((asOfDayMs - recencyMs) / DAY_MS);
  }

  // thresholds(recencyWindowDays) -> { soft, firm } day counts, DERIVED from
  // the dictionary's aging window (never hardcoded): soft at half, firm at
  // three-quarters — so a re-pull is prompted before the full-window cliff.
  // Falls back to the default window for a non-positive / non-finite input so a
  // bad call can't disable the guard.
  function thresholds(recencyWindowDays) {
    let w = Number(recencyWindowDays);
    if (!isFinite(w) || w <= 0) w = DEFAULT_RECENCY_WINDOW_DAYS;
    return { soft: w / 2, firm: (w * 3) / 4 };
  }

  // nudgeLevel(ageDays, recencyWindowDays) -> 'fresh' | 'soft' | 'firm' |
  // 'unknown'. Thresholds derive from `recencyWindowDays`. `ageDays == null`
  // (unparseable / unknown recency) is 'unknown' — which the UI treats as a
  // re-pull prompt, NOT as fresh.
  function nudgeLevel(ageDays, recencyWindowDays) {
    if (ageDays == null || isNaN(ageDays)) return 'unknown';
    const t = thresholds(recencyWindowDays);
    if (ageDays >= t.firm) return 'firm';
    if (ageDays >= t.soft) return 'soft';
    return 'fresh';
  }

  // freshness(records, opts) -> { ageDays, level, newestEventDate } — the
  // convenience wrapper the tool wires per Standing Report.
  //   opts.recencyWindowDays  the dictionary's aging window (default 30).
  //   opts.asOf               reference "now" (default new Date()).
  //   opts.reportType         'corrections' | 'assignment' (picks date fields).
  //   opts.dateField          explicit field name/list, overrides reportType.
  // A report whose newest event date can't be parsed → { ageDays: null,
  // level: 'unknown', newestEventDate: null }: prompt a re-pull, never fresh.
  function freshness(records, opts) {
    const o = opts || {};
    const window = o.recencyWindowDays == null
      ? DEFAULT_RECENCY_WINDOW_DAYS
      : o.recencyWindowDays;
    const fields = o.dateField != null
      ? o.dateField
      : (DATE_FIELDS_BY_TYPE[o.reportType] || ['date']);
    const newest = newestEventDate(records, fields);
    if (newest == null) {
      return { ageDays: null, level: 'unknown', newestEventDate: null };
    }
    const ageDays = ageInDays(newest, o.asOf);
    return {
      ageDays: ageDays,
      level: nudgeLevel(ageDays, window),
      newestEventDate: newest,
    };
  }

  // inboundFreshness(sortDate, asOf) -> { status, ageDays, sortDate } for the
  // DAILY INBOUND (issue #400, ADR-0016 decision 4). Unlike a Standing Report
  // — which nudges on a ~biweekly cadence derived from recencyWindowDays — the
  // Daily Inbound is expected fresh EACH SORT, so its only question is "is this
  // today's?". `sortDate` is the inbound's own sort date (its INBOUND_DATE,
  // e.g. AddressCatcherSession.inboundSortDate(rows), a 'YYYY-MM-DD' string) or
  // any parseEventDate-able value; `asOf` defaults to now.
  //   - status 'today'   : sort date is today or later (a future date also
  //                        reads as today — it is NOT before today).
  //   - status 'stale'   : sort date is BEFORE today — a restored yesterday's
  //                        worklist that must be flagged as "not today's
  //                        inbound," yet stays usable until a fresh one is
  //                        dropped (advisory, never blocks — ADR-0016 dec 4).
  //   - status 'unknown' : sort date is blank/unparseable — flagged, NEVER
  //                        assumed to be today (mirrors the Standing Report
  //                        unknown → re-pull invariant; failing open here would
  //                        let an undated restore masquerade as today's).
  //
  // TIMEZONE (issue #400 review): the today-vs-before-today decision is made in
  // the report's own LOCAL calendar frame, NOT via ageInDays (which keys on the
  // UTC calendar day — correct for the Standing Reports' ±1-day-tolerant nudge,
  // but wrong here). The inbound's sort date is a NAIVE local date, and this
  // station runs a NIGHT SORT in Phoenix (UTC-7): once local evening rolls the
  // UTC clock to tomorrow, a UTC-day comparison would read a freshly-dropped
  // TODAY inbound as ageDays=1 → 'stale', a nightly false alarm on today's own
  // report. Comparing the report's naive day against asOf's LOCAL day keeps a
  // today-dated inbound reading 'today' through the whole sort.
  function inboundFreshness(sortDate, asOf) {
    const reportDayMs = parseEventDate(sortDate); // UTC-midnight of the naive date
    if (reportDayMs == null) {
      return { status: 'unknown', ageDays: null, sortDate: sortDate || null };
    }
    const ref = asOf == null ? new Date() : new Date(asOf);
    if (isNaN(ref.getTime())) {
      return { status: 'unknown', ageDays: null, sortDate: sortDate || null };
    }
    // asOf's LOCAL calendar day, pinned to UTC-midnight so it compares
    // day-to-day against the naive report day in the SAME frame.
    const todayLocalDayMs = Date.UTC(ref.getFullYear(), ref.getMonth(), ref.getDate());
    const ageDays = Math.round((todayLocalDayMs - reportDayMs) / DAY_MS);
    if (ageDays > 0) return { status: 'stale', ageDays: ageDays, sortDate: sortDate };
    return { status: 'today', ageDays: ageDays, sortDate: sortDate };
  }

  return {
    DAY_MS: DAY_MS,
    DEFAULT_RECENCY_WINDOW_DAYS: DEFAULT_RECENCY_WINDOW_DAYS,
    DATE_FIELDS_BY_TYPE: DATE_FIELDS_BY_TYPE,
    parseEventDate: parseEventDate,
    newestEventDate: newestEventDate,
    dataRecency: dataRecency,
    ageInDays: ageInDays,
    thresholds: thresholds,
    nudgeLevel: nudgeLevel,
    freshness: freshness,
    inboundFreshness: inboundFreshness,
  };
});
