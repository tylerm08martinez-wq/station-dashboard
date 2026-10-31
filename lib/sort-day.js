'use strict';

// THE SORT-DAY CLOCK (issue #695, decision record #621, mandate 2 of spec #690).
//
// One answer to "is this the same sort day", keyed on the loaded report's own
// INBOUND_DATE and NEVER on the device clock.
//
// WHY THE DEVICE CLOCK IS WRONG HERE, not merely imprecise: the sort at 849
// starts around 1:30 AM. A single shift's work therefore straddles midnight on
// the device, so a device-date stamp changes IN THE MIDDLE of the day being
// worked and is identical across two different sorts pulled either side of a
// midnight. Both failures are silent, and both land on Goes To, a field whose
// value routes a physical package. The report says which sort day its rows
// belong to; that is the only clock this module reads.
//
// NO AMBIENT CLOCK IN ANY DECISION PATH. Nothing here asks the device what day
// it is: retention and same-day questions take their "as of" day from the
// caller, which passes the report's sort day. The only `new Date()` in the file
// is fromSerial's fixed epoch arithmetic (a pure YYYY-MM-DD conversion of an
// Excel serial that is already in hand), which reads no current time. That is
// the invariant to protect when editing: a Date constructed from data is fine,
// a Date constructed from now is not.
//
// WHAT THIS MODULE OWNS
//
//   1. The clock: parseInboundDate / sortDayOf / isSameSortDay.
//   2. The DAY STORE shape, a keyed store stamped with the sort day it belongs
//      to, which resets when a report from a different sort day is loaded. The
//      later tickets in spec #690 ride this shape: parked rows, 503s, and
//      barcode sheet ticks are each a day store. It is deliberately generic
//      (values are opaque) so those tickets add no shape of their own.
//   3. The DATED-NOTE data rules from #621: when the sort day moves on, an area
//      typed on an earlier day is NOT carried into today as a value, a work
//      area that was right three weeks ago can be wrong today, and the carried
//      value read as "finished" in three places at once. It is demoted to a
//      note: the MOST RECENT area only, plus a COUNT of the sort days it has
//      been carried off, on a 30-day retention window (the same window Repeat
//      History uses). DISPLAY of that note is a later ticket. This file holds
//      the data rules and writes no UI.
//
// The Goes To store itself stays in lib/actual-area.js, it owns propagation
// and the auto/early provenance flags, which have nothing to do with the day.
// This module only re-keys WHEN that store resets, through rollToSortDay.
//
// Dual-loadable with no build step:
// - Browser: window.SortDay
// - Node:    require('./lib/sort-day')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SortDay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Retention for the dated notes. 30 days, matching Repeat History's window
  // and lib/actual-area.js's DEFAULT_DAYS, so "how far back this tool
  // remembers a package" is one number everywhere. Counted in SORT days.
  const NOTE_DAYS = 30;

  // An Excel serial date (1899-12-30 epoch) only ever reaches us from a binary
  // .xlsx export, where a date cell is a number. The window below is roughly
  // 1990-01-01 to 2079-01-01: wide enough for any report, narrow enough that a
  // facility number or a work area can never be mistaken for a date.
  const SERIAL_MIN = 32874;
  const SERIAL_MAX = 65380;
  const SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30);

  function str(v) { return String(v == null ? '' : v).trim(); }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  // parseInboundDate(cell) -> 'YYYY-MM-DD', or '' when the cell is not a date.
  //
  // Handles BOTH report dialects the IBNO Coder accepts, ISO ("Manual
  // Assignment Detail at IB Scan") and US M/D/YYYY ("Inbound and Van Scans -
  // Full Detail by Date"), each optionally carrying a time, plus the Excel
  // serial an .xlsx export produces. The TIME IS ALWAYS DROPPED: a 1:30 AM row
  // and an 11:50 PM row on the same report are the same sort day.
  //
  // Refuses rather than guesses. An unreadable cell answers '', and every
  // caller here treats '' as "day unknown, change nothing", a wrong sort day
  // would silently clear a supervisor's typed work, which is worse than not
  // knowing.
  function parseInboundDate(cell) {
    if (typeof cell === 'number' && isFinite(cell)) return fromSerial(cell);
    const s = str(cell);
    if (!s) return '';
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);              // ISO, optional time
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);            // US M/D/YYYY, optional time
    if (m) return m[3] + '-' + pad2(Number(m[1])) + '-' + pad2(Number(m[2]));
    if (/^\d+(\.\d+)?$/.test(s)) return fromSerial(Number(s)); // .xlsx serial
    return '';
  }

  function fromSerial(n) {
    const whole = Math.floor(n);
    if (!(whole >= SERIAL_MIN && whole <= SERIAL_MAX)) return '';
    const d = new Date(SERIAL_EPOCH_MS + whole * 86400000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  // dateCellOf(row) -> the row's raw INBOUND_DATE cell, for a PARSED item.
  // Reads the field names the page's own row shape uses (lib/ibno-rules.js
  // readFields) and the raw column name, so the same call works on an item
  // from the session snapshot, an early Post Sort item, and a plain object.
  function dateCellOf(row) {
    if (!row || typeof row !== 'object') return '';
    if (row.inboundDate != null && str(row.inboundDate)) return row.inboundDate;
    if (row.inboundDateRaw != null && str(row.inboundDateRaw)) return row.inboundDateRaw;
    if (row.INBOUND_DATE != null && str(row.INBOUND_DATE)) return row.INBOUND_DATE;
    return '';
  }

  // sortDayOf(rows) -> the sort day of a whole report, or '' when unreadable.
  //
  // Accepts EITHER parsed items (objects carrying inboundDate) OR the raw rows
  // straight out of lib/csv.js, arrays of cells, under the SSRS preamble the
  // real exports carry. The header row is found by looking for INBOUND_DATE,
  // so the eleven preamble lines above it cost nothing.
  //
  // THE MODE, not the first row. A report pulled fresh mid-sort carries a
  // handful of the NEW day's early rows which can sort ahead of the bulk of
  // the day actually being worked; first-row would misidentify the file and
  // wipe a shift's Goes To work. Ties break to first occurrence, the same rule
  // lib/ibno-session.js's modeInboundDate uses.
  //
  // The two agree on every text date and DIVERGE, deliberately, on an Excel
  // serial: parseInboundDate reads it, IbnoRules.toIsoDate does not. That is
  // safe in one direction only, and this is the direction. modeInboundDate
  // feeds the #459 "this report is not dated today" note, where '' means
  // "say nothing"; here '' would mean "the sort day is unknown", which costs
  // day scoping on an .xlsx load. Widening toIsoDate instead would change what
  // that note and the merge path do, which is not this module's call to make.
  function sortDayOf(rows) {
    if (!Array.isArray(rows) || !rows.length) return '';
    const cells = Array.isArray(rows[0]) ? rawDateCells(rows) : rows.map(dateCellOf);
    const counts = new Map();
    const order = [];
    cells.forEach(function (cell) {
      const iso = parseInboundDate(cell);
      if (!iso) return;
      if (!counts.has(iso)) { counts.set(iso, 0); order.push(iso); }
      counts.set(iso, counts.get(iso) + 1);
    });
    let best = '', bestCount = -1;
    order.forEach(function (iso) {
      if (counts.get(iso) > bestCount) { bestCount = counts.get(iso); best = iso; }
    });
    return best;
  }

  function rawDateCells(rows) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      const col = row.findIndex(function (c) { return str(c).toUpperCase() === 'INBOUND_DATE'; });
      if (col === -1) continue;
      const out = [];
      for (let j = i + 1; j < rows.length; j++) {
        if (Array.isArray(rows[j])) out.push(rows[j][col]);
      }
      return out;
    }
    return [];
  }

  // isSameSortDay(a, b) -> whether two sort days are the same day.
  // An UNKNOWN day ('') is never the same as anything, including another
  // unknown: two reports we cannot date are not evidence of one sort day.
  function isSameSortDay(a, b) {
    const x = parseInboundDate(a);
    const y = parseInboundDate(b);
    return !!x && !!y && x === y;
  }

  function dayNumber(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parseInboundDate(iso));
    if (!m) return null;
    return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
  }

  // isLaterSortDay(day, than) -> whether `day` is strictly after `than`.
  //
  // This is what makes the sort-day clock MONOTONIC, and it exists because
  // "different day" is not the same question as "next day". During a 1:30 AM
  // sort the only main pull available is often YESTERDAY's report, worked
  // alongside a Post Sort report dated today: the older file is a normal part
  // of one shift, not evidence the shift ended. A clock that rolled on any
  // change of day would delete that shift's typed areas the moment the older
  // report loaded, or the moment the newer one came back.
  //
  // An unknown `than` ('' , nothing loaded yet) is earlier than any readable
  // day, so a first load always sets the clock. An unknown `day` is never
  // later than anything, so an undateable report never moves it.
  function isLaterSortDay(day, than) {
    const a = dayNumber(day);
    if (a == null) return false;
    const b = dayNumber(than);
    return b == null ? true : a > b;
  }

  // ─── DAY STORE ────────────────────────────────────────────────────────────
  //
  // Shape: { day: 'YYYY-MM-DD', items: { [key]: value } }
  //
  // The one persistence shape for everything spec #690 says "lives for the sort
  // day": parked rows, 503s, and barcode sheet ticks. The stamp is the SORT
  // day, so a store written at 1:30 AM and read again at 3:00 AM on the same
  // sort is the same store, and a store written on the previous sort is empty
  // no matter what the device clock says between the two.
  //
  // Values are opaque on purpose. A later ticket storing `true` for a tick and
  // an object for a parked row needs no change here, and there is one place
  // that decides when the day resets rather than three that can drift.
  //
  // Every writer returns a NEW store, so a caller can persist the result and
  // still hold the previous value (the lib/barcode-done.js convention).

  function emptyDayStore(day) {
    return { day: parseInboundDate(day), items: {} };
  }

  // restoreDayStore(raw, day) -> the stored state IF it belongs to this sort
  // day, otherwise an empty store stamped with the new day. This single check
  // is "reset on a new sort day" for every store that rides this shape.
  //
  // An unknown current day restores NOTHING: with no day to check against, a
  // restore would be a guess that yesterday's parked rows belong to today.
  function restoreDayStore(raw, day) {
    const today = parseInboundDate(day);
    const fresh = { day: today, items: {} };
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { return fresh; }
    }
    if (!today) return fresh;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fresh;
    if (parseInboundDate(parsed.day) !== today) return fresh;
    const items = parsed.items;
    if (!items || typeof items !== 'object' || Array.isArray(items)) return fresh;
    const out = {};
    Object.keys(items).forEach(function (k) { if (str(k)) out[str(k)] = items[k]; });
    return { day: today, items: out };
  }

  function serializeDayStore(store) {
    const s = store && typeof store === 'object' ? store : {};
    return { day: parseInboundDate(s.day), items: Object.assign({}, s.items || {}) };
  }

  function dayStoreItems(store) {
    const s = store && typeof store === 'object' ? store : {};
    return (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) ? s.items : {};
  }

  function dayStoreGet(store, key) { return dayStoreItems(store)[str(key)]; }
  function dayStoreHas(store, key) {
    return Object.prototype.hasOwnProperty.call(dayStoreItems(store), str(key));
  }
  function dayStoreKeys(store) { return Object.keys(dayStoreItems(store)); }
  function dayStoreCount(store) { return dayStoreKeys(store).length; }

  function dayStoreSet(store, key, value) {
    const next = serializeDayStore(store);
    const k = str(key);
    if (k) next.items[k] = value;
    return next;
  }

  function dayStoreDelete(store, key) {
    const next = serializeDayStore(store);
    delete next.items[str(key)];
    return next;
  }

  // dayStorePruneTo(store, keys) -> the store with only these keys kept. Used
  // when a fresh report is dropped so a day store cannot accumulate labels the
  // loaded report no longer contains.
  function dayStorePruneTo(store, keys) {
    const next = serializeDayStore(store);
    const keep = new Set((Array.isArray(keys) ? keys : []).map(str).filter(Boolean));
    Object.keys(next.items).forEach(function (k) { if (!keep.has(k)) delete next.items[k]; });
    return next;
  }

  // ─── DATED NOTES (#621 data rules; display is a later ticket) ─────────────
  //
  // Shape: { [trackingLabel]: { area, date, count } }
  //   area  the MOST RECENT carried area, and only that one
  //   date  the sort day that area was typed on, so the note can read
  //         "was 165 on 30 Jun" when a later ticket renders it
  //   count how many sort days this package has carried an area off, which is
  //         the "still coming back" signal, a route move shows as one, a
  //         package that keeps returning shows as many
  //
  // A history of every area on every day is deliberately NOT kept: #621's
  // whole finding is that an old area must not look like an answer, and a list
  // of old areas is a list of things to be walked by mistake.

  function restoreNotes(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { return {}; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    Object.keys(parsed).forEach(function (label) {
      const v = parsed[label];
      if (!v || typeof v !== 'object') return;
      const area = str(v.area);
      const date = parseInboundDate(v.date);
      if (!area || !date) return;   // a note with no area or no day cannot be shown
      const count = Number(v.count);
      out[str(label)] = { area: area, date: date, count: count >= 1 ? Math.floor(count) : 1 };
    });
    return out;
  }

  // noteFor(notes, label) -> { area, date, count } or null.
  //
  // Reads a RAW store, one that has not been through restoreNotes, because
  // that is how a display caller reaches it. The count is therefore validated
  // here on the SAME rule restoreNotes uses (#713): a hand-edited or
  // half-migrated payload can carry '3' or 1.7, and both must answer a whole
  // number, because the note renders as "carried N sort days". Anything that
  // is not a number of at least 1 answers 1, since a note that exists at all
  // was carried at least once.
  function noteFor(notes, label) {
    const n = notes && typeof notes === 'object' ? notes[str(label)] : null;
    if (!n || !str(n.area) || !parseInboundDate(n.date)) return null;
    const count = Number(n.count);
    return {
      area: str(n.area),
      date: parseInboundDate(n.date),
      count: count >= 1 ? Math.floor(count) : 1,
    };
  }

  // recordNote(notes, label, area, day) -> a NEW note store.
  //
  // THE COUNT DOES NOT CLIMB when the day handed in matches the note's
  // RETAINED date: a re-drop of the same report rolls the same areas through
  // again, and a count that climbed each time would be a count of file drops
  // rather than of sort days. The guard keys on the day and NOT on the area
  // too (#713): the count means "sort days carried", so a second record for a
  // day already counted is that same day whatever area it names.
  //
  // The AREA still moves to the newer one on that repeat, because this store's
  // contract above is "the MOST RECENT carried area, and only that one", and
  // call order is the recency signal. A correction typed later in a sort day
  // must not be dropped in favour of the value it corrects.
  //
  // KNOWN LIMIT, pre-existing and unreachable today: the comparison is against
  // the RETAINED date, not the day handed in, and the older-day branch below
  // holds the newer date while still counting. So once a note's date has been
  // pulled forward, an OLDER day recounts on every repeat instead of settling
  // (record 07-02, then 07-01 twice, and the count reaches 3). Nothing reaches
  // it: rollToSortDay records a label at most once per load, because the area
  // store holds one entry per label. Pinned by a test so this stays a stated
  // limit rather than a surprise. Fixing it means tracking the days counted,
  // which is a shape change this ticket does not own.
  //
  // An OLDER day never overwrites a newer note's area, the note is "the most
  // recent one", but it still counts, because it is another day this package
  // carried an area.
  function recordNote(notes, label, area, day) {
    const next = restoreNotes(notes);
    const key = str(label);
    const value = str(area);
    const date = parseInboundDate(day);
    if (!key || !value || !date) return next;
    const prev = next[key];
    const sameDay = !!prev && prev.date === date;
    const count = prev ? (sameDay ? prev.count : prev.count + 1) : 1;
    const keepPrev = prev && dayNumber(prev.date) > dayNumber(date);
    next[key] = {
      area: keepPrev ? prev.area : value,
      date: keepPrev ? prev.date : date,
      count: count,
    };
    return next;
  }

  // pruneNotes(notes, day, days) -> notes within `days` sort days of `day`.
  // `day` is a SORT day supplied by the caller. An unknown day prunes nothing:
  // with no reference point, dropping a note would be arbitrary.
  function pruneNotes(notes, day, days) {
    const next = restoreNotes(notes);
    const now = dayNumber(day);
    if (now == null) return next;
    const window = typeof days === 'number' && days >= 0 ? days : NOTE_DAYS;
    Object.keys(next).forEach(function (label) {
      const d = dayNumber(next[label].date);
      if (d == null || now - d > window) delete next[label];
    });
    return next;
  }

  // ─── THE DATED NOTE'S DISPLAY RULES (issue #702) ─────────────────────────
  //
  // The data half above (#712) demotes a cross-day area out of the Goes To
  // store and into this note store. These three functions answer the two
  // questions a renderer has — "is there a note to show on this row" and "what
  // does it read" — IN LIB, so both are unit-testable and neither can be
  // restated (and drift) in the page.
  //
  // THEY ARE PURE READERS. Nothing here writes, and nothing here touches the
  // area store at all. That is the load-bearing property of this whole ticket:
  // a note is a DATED REMARK ABOUT A PAST DAY, never an answer for today.
  // `ActualArea.isAnswered` (ADR 0022's **answered** state) is what says
  // whether a row carries an area, it reads lib/actual-area.js's store, and a
  // note is not in that store and never becomes part of it. So a noted row is
  // still unanswered: the Work-mode cursor stops on it, the progress bar's
  // worked half does not count it, no filter hides it, and a barcode card
  // prints a dash rather than a stale area. Nothing below can change that,
  // because nothing below writes anywhere.

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // noteDayLabel(iso) -> '30 Jun' for '2026-06-30', '' for anything unreadable.
  //
  // Pure string arithmetic on a date that is already in hand — NO Date built
  // from now, and no toLocaleDateString, whose output moves with the machine's
  // locale and would make the same note read differently on two devices.
  // Day-then-month, no year: within the 30-day retention window a year would
  // be noise, and this line has to be readable at arm's length mid-sort.
  // parseInboundDate answers a well-SHAPED date, not a real one: '2026-13-05'
  // matches its ISO pattern and comes straight back. So the month is checked
  // here rather than assumed, on the same posture noteFor and noteLine already
  // take with a hand-edited count — an ibno_area_notes payload that was edited
  // by hand or written by a half-migrated build is exactly the input class this
  // module defends against. Without the check the line read "was 165 on 5
  // undefined", and noteLine's own `if (!when) return ''` could not catch it,
  // because '5 undefined' is a truthy string.
  function noteDayLabel(iso) {
    const d = parseInboundDate(iso);
    if (!d) return '';
    const mon = MONTHS[Number(d.slice(5, 7)) - 1];
    if (!mon) return '';
    return String(Number(d.slice(8, 10))) + ' ' + mon;
  }

  // noteLine(note) -> 'was 165 on 30 Jun · 2 days', or '' when there is no
  // showable note. The wording is deliberate and was confirmed in the browser
  // (Tyler, 2026-08-19, variant D):
  //
  //   "was"  — past tense, so the line cannot be read as an instruction.
  //   "on 30 Jun" — the date is what makes it a note rather than a value.
  //   "· 2 days" — how many sort days this package has carried an area, the
  //                repeat signal. Singular for one, because "1 days" reads as
  //                a bug and undermines the rest of the line.
  //
  // The count is re-validated here on noteFor's rule rather than trusted: a
  // hand-edited store can carry '3' or 1.7 and this line must never print
  // either.
  function noteLine(note) {
    const n = note && typeof note === 'object' ? note : null;
    if (!n) return '';
    const area = str(n.area);
    const when = noteDayLabel(n.date);
    if (!area || !when) return '';
    const raw = Number(n.count);
    const count = raw >= 1 ? Math.floor(raw) : 1;
    return 'was ' + area + ' on ' + when + ' · ' + count + (count === 1 ? ' day' : ' days');
  }

  // noteToShow(notes, label, currentArea) -> the note a row should render, or
  // null.
  //
  // AGREEMENT HIDES IT (#702). Once today's typed answer matches what the
  // package carried before, the note has nothing left to say and would only
  // add a line to a row that is finished with it. DISAGREEMENT is the whole
  // point of the feature — that is the route-moved signal — so the note stays
  // beside a differing answer rather than being dismissed by the first thing
  // typed.
  //
  // The comparison is on the STORED form of an area, not the raw keystrokes:
  // lib/actual-area.js uppercases, trims and collapses whitespace before
  // storing, so "belt a" typed today must agree with a stored "BELT A" note.
  // Normalized here rather than by requiring the caller to hand in a
  // pre-normalized value, because a caller that forgot would leave the note
  // showing beside an answer that agrees, which looks exactly like a moved
  // route.
  function noteToShow(notes, label, currentArea) {
    const n = noteFor(notes, label);
    if (!n) return null;
    if (normalizeAreaText(currentArea) === normalizeAreaText(n.area)) return null;
    return n;
  }

  // The same normalization lib/actual-area.js's normalizeArea applies, spelled
  // here so this module keeps its zero dependencies (it is loaded by Node tests
  // and by the page, and neither should have to load actual-area.js to read a
  // note). Length capping is deliberately NOT repeated: both sides of the
  // comparison came out of stores that already capped, and a cap here would be
  // a second place to keep MAX_LEN in step for no gain.
  function normalizeAreaText(raw) {
    return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().toUpperCase();
  }

  // ─── ROLLING THE GOES TO STORE ONTO A NEW SORT DAY ───────────────────────
  //
  // rollToSortDay({ areas, notes, day, days }) -> { areas, notes, carried }
  //
  // `areas` is a lib/actual-area.js store, whose entries already carry the day
  // they were written on. This is the whole re-key: an entry stamped with the
  // sort day being loaded STAYS (that is a same-day re-drop or an F5, and
  // losing it is what #621 says Tyler explicitly values not losing); an entry
  // from any other sort day is removed from the live store and demoted to a
  // dated note.
  //
  // Pure, and a no-op on an unknown day: an .xlsx whose dates will not parse
  // must never clear a supervisor's typed work.
  //
  // `carried` lists the labels that moved, so a caller can repaint exactly
  // those rows.
  function rollToSortDay(opts) {
    const o = opts || {};
    const day = parseInboundDate(o.day);
    const areas = (o.areas && typeof o.areas === 'object' && !Array.isArray(o.areas)) ? o.areas : {};
    const outAreas = {};
    Object.keys(areas).forEach(function (k) { outAreas[k] = Object.assign({}, areas[k]); });
    if (!day) return { areas: outAreas, notes: restoreNotes(o.notes), carried: [] };

    let notes = restoreNotes(o.notes);
    const carried = [];
    Object.keys(outAreas).forEach(function (label) {
      const entry = outAreas[label];
      const stamp = parseInboundDate(entry && entry.date);
      // No usable stamp: KEEP. A missing date is not evidence the entry is
      // stale, and this matches lib/actual-area.js's own prune rule.
      if (!stamp) return;
      if (stamp === day) return;
      notes = recordNote(notes, label, entry.area, stamp);
      delete outAreas[label];
      carried.push(label);
    });
    return {
      areas: outAreas,
      notes: pruneNotes(notes, day, typeof o.days === 'number' ? o.days : NOTE_DAYS),
      carried: carried,
    };
  }

  return {
    NOTE_DAYS: NOTE_DAYS,

    parseInboundDate: parseInboundDate,
    sortDayOf: sortDayOf,
    isSameSortDay: isSameSortDay,
    isLaterSortDay: isLaterSortDay,

    emptyDayStore: emptyDayStore,
    restoreDayStore: restoreDayStore,
    serializeDayStore: serializeDayStore,
    dayStoreGet: dayStoreGet,
    dayStoreHas: dayStoreHas,
    dayStoreSet: dayStoreSet,
    dayStoreDelete: dayStoreDelete,
    dayStoreKeys: dayStoreKeys,
    dayStoreCount: dayStoreCount,
    dayStorePruneTo: dayStorePruneTo,

    restoreNotes: restoreNotes,
    noteFor: noteFor,
    recordNote: recordNote,
    pruneNotes: pruneNotes,

    noteDayLabel: noteDayLabel,
    noteLine: noteLine,
    noteToShow: noteToShow,

    rollToSortDay: rollToSortDay,
  };
});
