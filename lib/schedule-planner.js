'use strict';

// Schedule Planner core. Pure logic, no storage, no DOM, no clock.
// Every mutation takes a state and returns a new state; the input is never
// written to (the page keeps prior states for undo). When a mutation changes
// nothing it returns the same state object it was given.
//
// Dual-loadable with no build step:
// - Browser: window.SchedulePlanner
// - Node:    require('./lib/schedule-planner')
//
// Dates are local calendar dates as 'YYYY-MM-DD' strings. All date math is
// string and integer work (no Date, no UTC), so a TZ change moves nothing.
// Weeks run Sunday (0) through Saturday (6).
//
// One cell, one state. For one person on one calendar date, resolve() takes
// the first of:
//   1. approved time off from the file          (locked)
//   1b. vacation marked by hand for that date  (round 3: overrides[person][date] 'vac';
//       behaves like time off but is not locked, V or Backspace removes it)
//   2. a day off added by hand for that date
//   3. a change made for that date (an area, or cleared to empty)
//   4. the regular schedule version in force on that date
//   5. open
// A request that is only asked for (not approved) never blocks: it sets
// `asked` and the lookup carries on with 2 to 5. Round 3: overrides[person][date]
// 'hideAsked' drops that flag for one day and changes nothing else.
//
// Everything is keyed by person id, never by name, so two people with the same name
// never share days.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SchedulePlanner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  const AREAS = [
    { code: 'A', name: 'Cage A', key: 'a' },
    { code: 'B', name: 'Cage B', key: 'b' },
    { code: 'C', name: 'Cage C', key: 'c' },
    { code: 'ME', name: 'ME', key: 'm' },
    { code: 'DMG', name: 'Damages', key: 'd' },
    { code: 'XP', name: 'Xpress', key: 'x' },
    { code: '999', name: '999', key: '9' },
    { code: 'LC', name: 'Learning Center', key: 'l' },
    { code: 'OG', name: 'Overgoods', key: 'o' },
  ];
  const AREA_CODES = AREAS.map(function (a) { return a.code; });
  const MAX_AREAS_PER_DAY = 2;
  const MIN_LEN = 1;
  const MAX_LEN = 31;
  const SORTS = ['list', 'name', 'area'];
  const VIEWS = ['regular', 'dates'];

  let timeOffReport = null;
  function TOR() {
    if (!timeOffReport) {
      timeOffReport = (root && root.TimeOffReport) ||
        (typeof require === 'function' ? require('./time-off-report') : null);
    }
    return timeOffReport;
  }

  function has(obj, key) {
    return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
  }

  // ---- dates ----------------------------------------------------------

  function daysInMonth(y, m) {
    return [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  }

  // 'YYYY-MM-DD' that names a real calendar day.
  function isIsoDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
    if (!m) return false;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
  }

  // Civil date <-> days since 1970-01-01 (proleptic Gregorian).
  function toDayNumber(y, m, d) {
    const yy = m <= 2 ? y - 1 : y;
    const era = Math.floor(yy / 400);
    const yoe = yy - era * 400;
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }

  function fromDayNumber(z) {
    const zz = z + 719468;
    const era = Math.floor(zz / 146097);
    const doe = zz - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp < 10 ? mp + 3 : mp - 9;
    const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
    return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function dayNumber(date) {
    return toDayNumber(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)));
  }

  // Sunday 0 .. Saturday 6, or -1 for a string that is not a date.
  function weekdayOf(date) {
    if (!isIsoDate(date)) return -1;
    return (((dayNumber(date) + 4) % 7) + 7) % 7;
  }

  // 'YYYY-MM-DD' plus n days (n may be negative), or '' for a non-date.
  function addDays(date, n) {
    if (!isIsoDate(date)) return '';
    return fromDayNumber(dayNumber(date) + Math.trunc(Number(n) || 0));
  }

  function clampLen(len) {
    const n = Math.floor(Number(len));
    if (!isFinite(n)) return MIN_LEN;
    return Math.min(MAX_LEN, Math.max(MIN_LEN, n));
  }

  // rangeDates(from, len) -> [{ date, weekday }], len clamped to 1..31.
  // A `from` that is not a date gives [].
  function rangeDates(from, len) {
    if (!isIsoDate(from)) return [];
    const n = clampLen(len);
    const start = dayNumber(from);
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ date: fromDayNumber(start + i), weekday: (((start + i + 4) % 7) + 7) % 7 });
    }
    return out;
  }

  // The functions that take "dates" accept the objects rangeDates returns or
  // plain 'YYYY-MM-DD' strings.
  function dateList(dates) {
    return (dates || []).map(function (d) { return typeof d === 'string' ? d : d && d.date; })
      .filter(function (d) { return isIsoDate(d); });
  }

  // ---- state ----------------------------------------------------------

  function emptyState() {
    return {
      people: [],
      removed: [],
      regular: [],
      days: {},
      timeOff: null,
      leftOut: [],
      settings: { managerId: '', showAskedOff: true, sort: 'list', view: 'dates', from: '', len: 7 },
    };
  }

  function personRec(state, id) {
    const all = (state.people || []).concat(state.removed || []);
    for (let i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  function isActive(state, id) {
    return (state.people || []).some(function (p) { return p.id === id; });
  }

  // Time off index, built once per rows array and cached on it. A new report
  // is a new rows array, so a stale index can never be read.
  const indexCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function timeOffIndex(state) {
    const rows = state.timeOff && state.timeOff.rows;
    if (!Array.isArray(rows) || !rows.length) return {};
    if (indexCache && indexCache.has(rows)) return indexCache.get(rows);
    const idx = TOR().dayIndex(rows);
    if (indexCache) indexCache.set(rows, idx);
    return idx;
  }

  function timeOffEntry(state, personId, date) {
    const person = personRec(state, personId);
    const eid = person && typeof person.employeeId === 'string' ? person.employeeId.trim() : '';
    if (eid === '') return null;
    const idx = timeOffIndex(state);
    if (!has(idx, eid) || !has(idx[eid], date)) return null;
    return idx[eid][date];
  }

  // ---- regular schedule -----------------------------------------------

  // The pattern in force on a date: the newest version whose `from` is on or
  // before it. {} when no version is in force yet.
  function regularFor(state, date) {
    const versions = state.regular || [];
    let found = null;
    for (let i = 0; i < versions.length; i++) {
      if (versions[i].from <= date) found = versions[i];
    }
    return found ? found.pattern : {};
  }

  function patternCell(pattern, personId, weekday) {
    if (!has(pattern, personId)) return null;
    const byDay = pattern[personId];
    return has(byDay, weekday) ? byDay[weekday] : null;
  }

  function outcomeOfCell(cell) {
    if (cell && cell.off === true) return { kind: 'regularOff', areas: [] };
    if (cell && Array.isArray(cell.areas) && cell.areas.length) return { kind: 'area', areas: cell.areas.slice() };
    return { kind: 'open', areas: [] };
  }

  // The standing answer for one weekday, from the newest version (what the
  // Regular schedule view shows and edits).
  function resolveRegular(state, personId, weekday) {
    const versions = state.regular || [];
    const newest = versions.length ? versions[versions.length - 1].pattern : {};
    return outcomeOfCell(patternCell(newest, personId, weekday));
  }

  // ---- resolving a cell -----------------------------------------------

  function joinAreas(areas) { return areas.join('/'); }

  function listWords(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  function hoursText(hours) {
    const h = String(hours == null ? '' : hours).trim();
    if (h === '') return '';
    return h === '1' ? '1 hour' : h + ' hours';
  }

  function entryDescription(entry) {
    const bits = [listWords(entry.payCodes.filter(Boolean))];
    const hrs = hoursText(entry.hours);
    if (hrs) bits.push(hrs);
    return bits.filter(Boolean).join(', ');
  }

  function datedCell(state, personId, date) {
    const byDate = has(state.days, personId) ? state.days[personId] : null;
    return byDate && has(byDate, date) ? byDate[date] : null;
  }

  // Round 3: 'vac' | 'hideAsked' | null, from the additive overrides map.
  function overrideOf(state, personId, date) {
    const by = state && state.overrides && has(state.overrides, personId) ? state.overrides[personId] : null;
    if (!by || !has(by, date)) return null;
    return by[date] === 'vac' || by[date] === 'hideAsked' ? by[date] : null;
  }

  function resolve(state, personId, date) {
    const entry = timeOffEntry(state, personId, date);
    const dated = datedCell(state, personId, date);

    // 1. Approved time off: locked. Any dated entry stays underneath, uncounted.
    if (entry && entry.kind === 'approved') {
      let tip = entryDescription(entry) + '. Approved in the time off file.';
      if (dated && Array.isArray(dated.areas) && dated.areas.length) {
        tip += ' Your entry for this day (' + joinAreas(dated.areas) + ') is kept underneath.';
      }
      return {
        kind: 'timeoff', areas: [], label: entry.label, asked: false, changed: false, locked: true, tip: tip,
        hand: false, hasRequest: false, askedHidden: false,
      };
    }

    const rawAsked = !!(entry && entry.kind === 'asked');
    const ov = overrideOf(state, personId, date);
    const hand = ov === 'vac';
    const hidden = rawAsked && ov === 'hideAsked';
    const asked = rawAsked && !hidden && !hand;

    // 1b. Vacation marked by hand: counts as off, stays editable only by V,
    // Backspace or Delete. Any dated entry stays underneath, uncounted.
    if (hand) {
      let vtip = 'Vacation, set by hand. Press V to remove.';
      if (rawAsked) vtip += ' Still not approved in the time off file.';
      if (dated && Array.isArray(dated.areas) && dated.areas.length) {
        vtip += ' Your entry for this day (' + joinAreas(dated.areas) + ') is kept underneath.';
      }
      return {
        kind: 'timeoff', areas: [], label: 'VAC', asked: false, changed: false, locked: false, tip: vtip,
        hand: true, hasRequest: rawAsked, askedHidden: false,
      };
    }
    const askedTip = asked ? 'Asked off: ' + entryDescription(entry) + '. Not approved in the time off file yet.' : '';
    function tipWith(text) { return [askedTip, text].filter(Boolean).join(' '); }

    const reg = outcomeOfCell(patternCell(regularFor(state, date), personId, weekdayOf(date)));

    // 2 and 3. What Tyler set for this date.
    if (dated) {
      if (dated.off === true) {
        return {
          kind: 'dayoff', areas: [], label: 'OFF*', asked: asked, locked: false,
          changed: reg.kind !== 'dayoff', tip: tipWith('Day off added by hand.'), hand: false, hasRequest: rawAsked, askedHidden: hidden,
        };
      }
      const areas = Array.isArray(dated.areas) ? dated.areas.slice() : [];
      const outcome = areas.length ? { kind: 'area', areas: areas } : { kind: 'open', areas: [] };
      const changed = outcome.kind !== reg.kind || joinAreas(outcome.areas) !== joinAreas(reg.areas);
      return {
        kind: outcome.kind, areas: outcome.areas, label: '', asked: asked, locked: false, changed: changed,
        tip: tipWith(changed ? 'Changed from the regular schedule.' : ''), hand: false, hasRequest: rawAsked, askedHidden: hidden,
      };
    }

    // 4. The regular schedule, 5. otherwise open.
    return {
      kind: reg.kind, areas: reg.areas, label: reg.kind === 'regularOff' ? 'OFF' : '', asked: asked, changed: false,
      locked: false, tip: tipWith(reg.kind === 'regularOff' ? 'Regular day off.' : ''), hand: false, hasRequest: rawAsked, askedHidden: hidden,
    };
  }

  // ---- counts, order, collisions --------------------------------------

  function counts(state, dates) {
    const list = dateList(dates);
    const byArea = {};
    AREA_CODES.forEach(function (code) { byArea[code] = list.map(function () { return 0; }); });
    const scheduled = list.map(function () { return 0; });
    const open = list.map(function () { return 0; });
    const daysWorked = {};
    (state.people || []).forEach(function (p) {
      daysWorked[p.id] = 0;
      list.forEach(function (date, i) {
        const r = resolve(state, p.id, date);
        if (r.kind === 'open') open[i] += 1;
        if (r.kind !== 'area') return;
        scheduled[i] += 1;
        daysWorked[p.id] += 1;
        r.areas.forEach(function (code) { if (has(byArea, code)) byArea[code][i] += 1; });
      });
    });
    return { byArea: byArea, scheduled: scheduled, open: open, daysWorked: daysWorked };
  }

  function nameKey(p) { return String(p.name || '').toLowerCase(); }

  // order(state, sort, sortDate, dates) -> personId[]. 'list' is My order,
  // 'name' is A to Z, 'area' groups by the area held on sortDate (the first
  // of `dates` when none is given): area order, then open, then off.
  function order(state, sort, sortDate, dates) {
    const people = (state.people || []).map(function (p, i) { return { p: p, i: i }; });
    function byName(a, b) {
      const x = nameKey(a.p), y = nameKey(b.p);
      if (x < y) return -1;
      if (x > y) return 1;
      return a.i - b.i;
    }
    if (sort === 'name') {
      return people.slice().sort(byName).map(function (e) { return e.p.id; });
    }
    if (sort === 'area') {
      const day = isIsoDate(sortDate) ? sortDate : (dateList(dates)[0] || '');
      const rank = function (e) {
        const r = day ? resolve(state, e.p.id, day) : { kind: 'open', areas: [] };
        if (r.kind === 'area') {
          const at = AREA_CODES.indexOf(r.areas[0]);
          return at === -1 ? AREA_CODES.length : at;
        }
        return AREA_CODES.length + (r.kind === 'open' ? 1 : 2);
      };
      return people.map(function (e) { return { e: e, r: rank(e) }; })
        .sort(function (a, b) { return (a.r - b.r) || byName(a.e, b.e); })
        .map(function (x) { return x.e.p.id; });
    }
    return people.map(function (e) { return e.p.id; });
  }

  // The Regular schedule view's twin of counts(): one column per weekday
  // (0 Sunday to 6 Saturday), read from the NEWEST regular version, the same
  // thing resolveRegular shows. Active people only.
  function countsRegular(state) {
    const days = [0, 1, 2, 3, 4, 5, 6];
    const byArea = {};
    AREA_CODES.forEach(function (code) { byArea[code] = days.map(function () { return 0; }); });
    const scheduled = days.map(function () { return 0; });
    const open = days.map(function () { return 0; });
    const daysWorked = {};
    (state.people || []).forEach(function (p) {
      daysWorked[p.id] = 0;
      days.forEach(function (wd) {
        const r = resolveRegular(state, p.id, wd);
        if (r.kind === 'open') open[wd] += 1;
        if (r.kind !== 'area') return;
        scheduled[wd] += 1;
        daysWorked[p.id] += 1;
        r.areas.forEach(function (code) { if (has(byArea, code)) byArea[code][wd] += 1; });
      });
    });
    return { byArea: byArea, scheduled: scheduled, open: open, daysWorked: daysWorked };
  }

  // The Regular schedule view's twin of order(): 'area' groups by the area
  // each person holds on `weekday` in the newest regular version.
  function orderRegular(state, sort, weekday) {
    if (sort !== 'area') return order(state, sort, '', []);
    const wd = Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : 0;
    const people = (state.people || []).map(function (p, i) { return { p: p, i: i }; });
    const rank = function (e) {
      const r = resolveRegular(state, e.p.id, wd);
      if (r.kind === 'area') {
        const at = AREA_CODES.indexOf(r.areas[0]);
        return at === -1 ? AREA_CODES.length : at;
      }
      return AREA_CODES.length + (r.kind === 'open' ? 1 : 2);
    };
    return people.map(function (e) { return { e: e, r: rank(e) }; })
      .sort(function (a, b) {
        if (a.r !== b.r) return a.r - b.r;
        const x = nameKey(a.e.p), y = nameKey(b.e.p);
        if (x < y) return -1;
        if (x > y) return 1;
        return a.e.i - b.e.i;
      })
      .map(function (x) { return x.e.p.id; });
  }

  // Dated area entries that now sit under approved time off. They stay in
  // state.days, uncounted, and come back if a later file drops the date.
  function collisions(state) {
    const out = [];
    (state.people || []).forEach(function (p) {
      if (!has(state.days, p.id)) return;
      Object.keys(state.days[p.id]).sort().forEach(function (date) {
        const cell = state.days[p.id][date];
        if (!cell || !Array.isArray(cell.areas) || !cell.areas.length) return;
        const entry = timeOffEntry(state, p.id, date);
        if (entry && entry.kind === 'approved') out.push({ personId: p.id, date: date, areas: cell.areas.slice() });
      });
    });
    return out;
  }

  // ---- round 3: overrides ---------------------------------------------
  // overrides[personId][date] is 'vac' (vacation by hand) or 'hideAsked' (one
  // asked-off request hidden). Additive: a state without the key behaves as
  // before, and the key is removed again when the last override goes.

  function withOverrides(state, edits) {
    // edits: [{ personId, date, value: 'vac'|'hideAsked'|null }] applied in one copy.
    const ov = Object.assign({}, state.overrides);
    const touched = Object.create(null);
    edits.forEach(function (e) {
      if (!has(touched, e.personId)) touched[e.personId] = Object.assign({}, has(ov, e.personId) ? ov[e.personId] : {});
      if (e.value === null) delete touched[e.personId][e.date]; else touched[e.personId][e.date] = e.value;
    });
    Object.keys(touched).forEach(function (id) {
      if (Object.keys(touched[id]).length) ov[id] = touched[id]; else delete ov[id];
    });
    const next = Object.assign({}, state);
    if (Object.keys(ov).length) next.overrides = ov; else delete next.overrides;
    return next;
  }

  function setOverride(state, personId, date, value) {
    if (overrideOf(state, personId, date) === value) return state;
    return withOverrides(state, [{ personId: personId, date: date, value: value }]);
  }

  function requestAt(state, personId, date) {
    const e = timeOffEntry(state, personId, date);
    return !!(e && e.kind === 'asked');
  }

  // The date cells among refs ({ person, date }) that are in the grid and not
  // approved time off. Approved days are counted, never changed.
  function overrideTargets(state, refs) {
    const out = [];
    let locked = 0;
    (refs || []).forEach(function (ref) {
      if (!ref || !isIsoDate(ref.date) || !isActive(state, ref.person)) return;
      if (resolve(state, ref.person, ref.date).locked) { locked += 1; return; }
      out.push({ personId: ref.person, date: ref.date });
    });
    return { cells: out, locked: locked };
  }

  // toggleVacation(state, refs) -> { state, op: 'set'|'remove'|'none', changed, skippedLocked }.
  // Every target already on hand-set vacation: remove it from all. Otherwise
  // set it on all. Approved time off is skipped and counted.
  function toggleVacation(state, refs) {
    const t = overrideTargets(state, refs);
    if (!t.cells.length) return { state: state, op: 'none', changed: 0, skippedLocked: t.locked };
    const allVac = t.cells.every(function (c) { return overrideOf(state, c.personId, c.date) === 'vac'; });
    const edits = [];
    t.cells.forEach(function (c) {
      const cur = overrideOf(state, c.personId, c.date);
      if (allVac) edits.push({ personId: c.personId, date: c.date, value: null });
      else if (cur !== 'vac') edits.push({ personId: c.personId, date: c.date, value: 'vac' });
    });
    return {
      state: edits.length ? withOverrides(state, edits) : state,
      op: allVac ? 'remove' : 'set', changed: edits.length, skippedLocked: t.locked,
    };
  }

  // toggleHideAsked(state, refs) -> { state, op: 'hide'|'show'|'none', changed }.
  // Only days that carry an asked-off request (and are not already vacation or
  // approved) count; the rest are skipped. All hidden already: show them again.
  function toggleHideAsked(state, refs) {
    const t = overrideTargets(state, refs);
    const cells = t.cells.filter(function (c) {
      return requestAt(state, c.personId, c.date) && overrideOf(state, c.personId, c.date) !== 'vac';
    });
    if (!cells.length) return { state: state, op: 'none', changed: 0 };
    const allHidden = cells.every(function (c) { return overrideOf(state, c.personId, c.date) === 'hideAsked'; });
    const edits = [];
    cells.forEach(function (c) {
      const cur = overrideOf(state, c.personId, c.date);
      if (allHidden) edits.push({ personId: c.personId, date: c.date, value: null });
      else if (cur !== 'hideAsked') edits.push({ personId: c.personId, date: c.date, value: 'hideAsked' });
    });
    return { state: edits.length ? withOverrides(state, edits) : state, op: allHidden ? 'show' : 'hide', changed: edits.length };
  }

  // The hidden requests in these dates: [{ personId, date }] for people in the
  // grid whose request in the file is hidden by hand.
  function hiddenAsked(state, dates) {
    const list = dateList(dates);
    const out = [];
    (state.people || []).forEach(function (p) {
      list.forEach(function (date) {
        if (overrideOf(state, p.id, date) !== 'hideAsked') return;
        if (requestAt(state, p.id, date) && !resolve(state, p.id, date).locked) out.push({ personId: p.id, date: date });
      });
    });
    return out;
  }

  function hiddenAskedCount(state, dates) { return hiddenAsked(state, dates).length; }

  // Removes every hide in these dates, one new state (one undo step).
  function showHiddenAsked(state, dates) {
    const edits = hiddenAsked(state, dates).map(function (h) { return { personId: h.personId, date: h.date, value: null }; });
    return edits.length ? withOverrides(state, edits) : state;
  }

  // ---- editing dated cells --------------------------------------------

  // The new areas after painting `code` onto a cell that now holds `areas`.
  // null means "no change". `clearIt` is true for the toggle-off case.
  function nextAreas(areas, code, add) {
    if (add) {
      if (!areas.length) return { areas: [code] };
      if (areas.indexOf(code) !== -1 || areas.length >= MAX_AREAS_PER_DAY) return null;
      return { areas: areas.concat([code]) };
    }
    if (areas.length === 1 && areas[0] === code) return { clear: true };
    return { areas: [code] };
  }

  function withDay(state, personId, date, cell) {
    const prior = has(state.days, personId) ? state.days[personId] : {};
    const byDate = Object.assign({}, prior);
    if (cell === null) delete byDate[date]; else byDate[date] = cell;
    const days = Object.assign({}, state.days);
    if (Object.keys(byDate).length) days[personId] = byDate; else delete days[personId];
    return Object.assign({}, state, { days: days });
  }

  function withDays(state, edits) {
    // edits: [{ personId, date, cell|null }] applied in one copy.
    const days = Object.assign({}, state.days);
    const touched = Object.create(null);
    edits.forEach(function (e) {
      if (!has(touched, e.personId)) {
        touched[e.personId] = Object.assign({}, has(days, e.personId) ? days[e.personId] : {});
      }
      if (e.cell === null) delete touched[e.personId][e.date]; else touched[e.personId][e.date] = e.cell;
    });
    Object.keys(touched).forEach(function (id) {
      if (Object.keys(touched[id]).length) days[id] = touched[id]; else delete days[id];
    });
    return Object.assign({}, state, { days: days });
  }

  function editable(state, personId, date) {
    if (!isActive(state, personId) || !isIsoDate(date)) return null;
    const r = resolve(state, personId, date);
    return r.locked || r.hand ? null : r;
  }

  // The cell that clears a date: removed when the regular schedule is open
  // there, an explicit empty cell when it is not.
  function clearedCell(state, personId, date) {
    const reg = outcomeOfCell(patternCell(regularFor(state, date), personId, weekdayOf(date)));
    return reg.kind === 'open' ? null : { areas: [] };
  }

  function clear(state, personId, date) {
    // Backspace on hand-set vacation removes the vacation (and only that).
    if (isActive(state, personId) && isIsoDate(date) && overrideOf(state, personId, date) === 'vac' &&
        !resolve(state, personId, date).locked) {
      return setOverride(state, personId, date, null);
    }
    const r = editable(state, personId, date);
    if (!r) return state;
    const had = datedCell(state, personId, date);
    const cell = clearedCell(state, personId, date);
    if (cell === null && !had) return state;
    if (cell !== null && had && Array.isArray(had.areas) && !had.areas.length) return state;
    return withDay(state, personId, date, cell);
  }

  function paint(state, personId, date, code, opts) {
    if (AREA_CODES.indexOf(code) === -1) return state;
    const r = editable(state, personId, date);
    if (!r) return state;
    const base = r.kind === 'area' ? r.areas : [];
    const next = nextAreas(base, code, !!(opts && opts.add));
    if (next === null) return state;
    if (next.clear) return clear(state, personId, date);
    return withDay(state, personId, date, { areas: next.areas });
  }

  // Toggles a day off added by hand for one date.
  function dayOff(state, personId, date) {
    if (!editable(state, personId, date)) return state;
    const had = datedCell(state, personId, date);
    return withDay(state, personId, date, had && had.off === true ? null : { off: true });
  }

  // Dates view: every visible area gone, every kind of day off left alone.
  // An entry hidden under approved time off is not in view and is kept.
  function clearAreas(state, dates) {
    const list = dateList(dates);
    const edits = [];
    (state.people || []).forEach(function (p) {
      list.forEach(function (date) {
        const r = resolve(state, p.id, date);
        if (r.kind !== 'area') return;
        edits.push({ personId: p.id, date: date, cell: clearedCell(state, p.id, date) });
      });
    });
    return edits.length ? withDays(state, edits) : state;
  }

  // Back to regular: drops Tyler's dated changes (areas and hand-added days
  // off) in the range, for the people in the grid.
  function resetRange(state, dates) {
    const list = dateList(dates);
    const edits = [];
    (state.people || []).forEach(function (p) {
      list.forEach(function (date) {
        if (datedCell(state, p.id, date)) edits.push({ personId: p.id, date: date, cell: null });
      });
    });
    return edits.length ? withDays(state, edits) : state;
  }

  // ---- editing the regular schedule -----------------------------------

  function samePattern(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // Applies fn to the newest version's pattern. fn returns the same object when
  // it changes nothing, and then no version is made. An edit made on a day when
  // the newest version is dated that day or later, or when that version was
  // itself first made that day, edits it in
  // place. An edit on a later day copies it into a new version dated `today`,
  // so earlier dates keep the pattern that was in force then. The first-ever
  // edit is dated `today` too: before it there was no pattern, so earlier dates
  // keep none.
  function editRegular(state, today, fn) {
    if (!isIsoDate(today)) return state;
    const versions = state.regular || [];
    const newest = versions.length ? versions[versions.length - 1] : null;
    const base = newest ? newest.pattern : {};
    const next = fn(base);
    if (next === base || samePattern(next, base)) return state;
    let regular;
    if (!newest) {
      regular = [{ from: today, pattern: next, edited: today }];
    } else if (newest.from >= today || newest.edited === today) {
      regular = versions.slice(0, -1).concat([Object.assign({}, newest, { pattern: next, edited: today })]);
    } else {
      regular = versions.concat([{ from: today, pattern: next, edited: today }]);
    }
    return Object.assign({}, state, { regular: regular });
  }

  function setPatternCell(pattern, personId, weekday, cell) {
    const byDay = Object.assign({}, has(pattern, personId) ? pattern[personId] : {});
    if (cell === null) delete byDay[weekday]; else byDay[weekday] = cell;
    const out = Object.assign({}, pattern);
    if (Object.keys(byDay).length) out[personId] = byDay; else delete out[personId];
    return out;
  }

  function validWeekday(w) { return Number.isInteger(w) && w >= 0 && w <= 6; }

  function paintRegular(state, today, personId, weekday, code, opts) {
    if (AREA_CODES.indexOf(code) === -1 || !validWeekday(weekday) || !isActive(state, personId)) return state;
    return editRegular(state, today, function (pattern) {
      const cur = patternCell(pattern, personId, weekday);
      const areas = cur && Array.isArray(cur.areas) ? cur.areas : [];
      const next = nextAreas(areas, code, !!(opts && opts.add));
      if (next === null) return pattern;
      return setPatternCell(pattern, personId, weekday, next.clear ? null : { areas: next.areas });
    });
  }

  // Toggles a regular day off.
  function regularOff(state, today, personId, weekday) {
    if (!validWeekday(weekday) || !isActive(state, personId)) return state;
    return editRegular(state, today, function (pattern) {
      const cur = patternCell(pattern, personId, weekday);
      return setPatternCell(pattern, personId, weekday, cur && cur.off === true ? null : { off: true });
    });
  }

  function clearRegular(state, today, personId, weekday) {
    if (!validWeekday(weekday) || !isActive(state, personId)) return state;
    return editRegular(state, today, function (pattern) {
      return patternCell(pattern, personId, weekday) ? setPatternCell(pattern, personId, weekday, null) : pattern;
    });
  }

  // Regular view: every area gone from the standing pattern, regular days off
  // left in place.
  function clearAreasRegular(state, today) {
    return editRegular(state, today, function (pattern) {
      let out = pattern;
      Object.keys(pattern).forEach(function (id) {
        Object.keys(pattern[id]).forEach(function (w) {
          if (pattern[id][w] && pattern[id][w].off !== true) out = setPatternCell(out, id, w, null);
        });
      });
      return out;
    });
  }

  // ---- people ---------------------------------------------------------

  function trimmed(v) { return typeof v === 'string' ? v.trim() : ''; }

  function idUsed(state, id) {
    return personRec(state, id) !== null;
  }

  // The removed person this input is the same person as, or null. By employee
  // ID when the input carries one; otherwise (or as well) by name when the
  // removed person has no ID of their own. The most recently removed wins.
  function removedMatch(state, name, eid) {
    const gone = state.removed || [];
    for (let i = gone.length - 1; i >= 0; i--) {
      const r = gone[i];
      const rid = trimmed(r.employeeId);
      if (eid !== '' && rid === eid) return r;
    }
    for (let i = gone.length - 1; i >= 0; i--) {
      const r = gone[i];
      if (trimmed(r.employeeId) === '' && trimmed(r.name).toLowerCase() === name.toLowerCase()) return r;
    }
    return null;
  }

  // Adds an admin. When the input is a person who was removed (same employee
  // ID, or the same name when that person had no ID) it brings that person
  // back under the same id, so their saved days and regular pattern return.
  function addPerson(state, input, newId) {
    const name = trimmed(input && input.name);
    if (name === '' || typeof newId !== 'string' || newId === '' || idUsed(state, newId)) return state;
    const eid = trimmed(input.employeeId);
    const back = removedMatch(state, name, eid);
    if (back) {
      return Object.assign({}, state, {
        people: (state.people || []).concat([{ id: back.id, name: name, employeeId: eid !== '' ? eid : trimmed(back.employeeId) }]),
        removed: (state.removed || []).filter(function (r) { return r !== back; }),
      });
    }
    const person = { id: newId, name: name, employeeId: eid };
    return Object.assign({}, state, { people: (state.people || []).concat([person]) });
  }

  function renamePerson(state, id, name) {
    const nm = trimmed(name);
    if (nm === '' || !isActive(state, id)) return state;
    return Object.assign({}, state, {
      people: state.people.map(function (p) { return p.id === id ? Object.assign({}, p, { name: nm }) : p; }),
    });
  }

  // Moves the person to `removed`. Their days and regular pattern stay in the
  // state, so undo (the page's earlier state) brings everything back.
  function removePerson(state, id) {
    const person = (state.people || []).filter(function (p) { return p.id === id; })[0];
    if (!person) return state;
    return Object.assign({}, state, {
      people: state.people.filter(function (p) { return p.id !== id; }),
      removed: (state.removed || []).concat([person]),
    });
  }

  // Sets an admin's employee ID; an empty value clears it. Refused (same state
  // back) when another admin in the grid already has that ID.
  function linkPerson(state, id, employeeId) {
    const eid = trimmed(employeeId);
    const person = (state.people || []).filter(function (p) { return p.id === id; })[0];
    if (!person || person.employeeId === eid) return state;
    if (eid !== '' && employeeIdTaken(state, eid, id)) return state;
    return Object.assign({}, state, {
      people: state.people.map(function (p) { return p.id === id ? Object.assign({}, p, { employeeId: eid }) : p; }),
    });
  }

  // duplicateEmployeeIds(state) -> [{ employeeId, names }]: employee IDs that
  // more than one active admin holds. Nothing refuses such a state (a backup
  // of it must restore); the page shows it so one of them gets edited.
  function duplicateEmployeeIds(state) {
    const by = Object.create(null);
    const order = [];
    ((state && Array.isArray(state.people)) ? state.people : []).forEach(function (p) {
      const eid = p && typeof p.employeeId === 'string' ? p.employeeId.trim() : '';
      if (eid === '') return;
      if (!by[eid]) { by[eid] = []; order.push(eid); }
      by[eid].push(String(p.name || ''));
    });
    return order.filter(function (e) { return by[e].length > 1; }).map(function (e) { return { employeeId: e, names: by[e] }; });
  }

  // True when another person in the grid already carries this employee ID.
  function employeeIdTaken(state, employeeId, exceptPersonId) {
    const eid = trimmed(employeeId);
    if (eid === '') return false;
    return (state.people || []).some(function (p) { return p.id !== exceptPersonId && p.employeeId === eid; });
  }

  // ---- the time off file ----------------------------------------------

  // `report.rows` are already filtered to the manager. The newest file is the
  // whole truth about time off, so it replaces the old rows completely. A
  // person's own dated entries are never touched.
  function applyReport(state, report, loadedAt) {
    const rows = Array.isArray(report && report.rows) ? report.rows.slice() : [];
    const timeOff = {
      fileName: String(report && report.fileName != null ? report.fileName : ''),
      runDate: String(report && report.runDate != null ? report.runDate : ''),
      loadedAt: loadedAt,
      total: Number(report && report.total) || 0,
      mine: rows.length,
      rows: rows,
    };
    // Round 2, additive: the period the file covers, only when it names one,
    // so a record without it keeps the shape round 1 wrote.
    const period = parsePeriod(report && report.period);
    if (period) timeOff.period = period;
    return Object.assign({}, state, { timeOff: timeOff });
  }

  // People in the kept file who match no admin by employee ID and were not
  // left out, in file order: [{ employeeId, name }].
  function unknownPeople(state) {
    const rows = state.timeOff && state.timeOff.rows;
    if (!Array.isArray(rows) || !rows.length) return [];
    const known = {};
    (state.people || []).forEach(function (p) { if (trimmed(p.employeeId) !== '') known[p.employeeId.trim()] = true; });
    const left = {};
    (state.leftOut || []).forEach(function (id) { left[id] = true; });
    return TOR().people(rows).filter(function (p) { return !has(known, p.employeeId) && !has(left, p.employeeId); });
  }

  // Statuses in the kept file's rows that this page does not know: not one of
  // the approved ones and not REQ_SUBMITTED (asked). Those days show as asked
  // off. Worked out from the kept rows, so it always matches the state. The
  // known asked status is the one lib/time-off-report.js reads as asked; a
  // test parses a file with both readers and compares the answers.
  const KNOWN_ASKED_STATUSES = ['REQ_SUBMITTED'];
  function unknownStatuses(state) {
    const rows = state.timeOff && state.timeOff.rows;
    const out = [];
    if (!Array.isArray(rows)) return out;
    rows.forEach(function (r) {
      if (r.kind === 'asked' && typeof r.status === 'string' && KNOWN_ASKED_STATUSES.indexOf(r.status) === -1 && out.indexOf(r.status) === -1) out.push(r.status);
    });
    return out;
  }

  function leaveOut(state, employeeId) {
    const eid = trimmed(employeeId);
    if (eid === '' || (state.leftOut || []).indexOf(eid) !== -1) return state;
    return Object.assign({}, state, { leftOut: (state.leftOut || []).concat([eid]) });
  }

  // Empties the "leave out" list, so everyone in the kept file who matches no
  // admin shows in the notice again.
  function clearLeftOut(state) {
    if (!(state.leftOut || []).length) return state;
    return Object.assign({}, state, { leftOut: [] });
  }

  // ---- round 2: regular days off, people order -----------------------

  // Sets (on) or removes (off) a regular day off for one weekday in the
  // standing pattern. Ticking replaces any area on that weekday; unticking
  // leaves the day empty. Same versioning as every regular edit (from today).
  function setRegularOff(state, today, personId, weekday, on) {
    if (!validWeekday(weekday) || !isActive(state, personId)) return state;
    return editRegular(state, today, function (pattern) {
      const cur = patternCell(pattern, personId, weekday);
      const isOff = !!(cur && cur.off === true);
      if (isOff === !!on) return pattern;
      return setPatternCell(pattern, personId, weekday, on ? { off: true } : null);
    });
  }

  // Moves one admin up (delta < 0) or down (delta > 0) one place in My order.
  function movePerson(state, id, delta) {
    const list = state.people || [];
    let i = -1;
    for (let k = 0; k < list.length; k++) if (list[k].id === id) { i = k; break; }
    const step = Number(delta) < 0 ? -1 : (Number(delta) > 0 ? 1 : 0);
    const j = i + step;
    if (i === -1 || step === 0 || j < 0 || j >= list.length) return state;
    const people = list.slice();
    people[i] = list[j];
    people[j] = list[i];
    return Object.assign({}, state, { people: people });
  }

  // ---- round 2: setting exact areas -----------------------------------

  function knownAreas(areas) {
    if (!Array.isArray(areas) || areas.length > MAX_AREAS_PER_DAY) return false;
    for (let i = 0; i < areas.length; i++) {
      if (AREA_CODES.indexOf(areas[i]) === -1 || areas.indexOf(areas[i]) !== i) return false;
    }
    return true;
  }

  // One date set to exactly these areas (not a toggle). [] clears.
  function setAreas(state, personId, date, areas) {
    const r = editable(state, personId, date);
    if (!r || !knownAreas(areas)) return state;
    if (!areas.length) return clear(state, personId, date);
    if (r.kind === 'area' && joinAreas(r.areas) === joinAreas(areas)) return state;
    return withDay(state, personId, date, { areas: areas.slice() });
  }

  function setAreasRegular(state, today, personId, weekday, areas) {
    if (!validWeekday(weekday) || !isActive(state, personId) || !knownAreas(areas)) return state;
    if (!areas.length) return clearRegular(state, today, personId, weekday);
    return editRegular(state, today, function (pattern) {
      const cur = patternCell(pattern, personId, weekday);
      if (cur && Array.isArray(cur.areas) && joinAreas(cur.areas) === joinAreas(areas)) return pattern;
      return setPatternCell(pattern, personId, weekday, { areas: areas.slice() });
    });
  }

  // ---- round 2: clipboard ---------------------------------------------
  // A cell reference is { person, date } in Specific dates or
  // { person, weekday } in Regular schedule. A token is what one cell copies
  // as: 'A', '999/B', 'OFF', '' (empty), or null (copies nothing: approved
  // time off from the file, a cell outside the selection, an ignored word).

  function isDateRef(ref) { return !!ref && isIsoDate(ref.date); }

  function cellToken(state, ref) {
    if (!ref) return null;
    let r;
    if (isDateRef(ref)) {
      r = resolve(state, ref.person, ref.date);
      if (r.kind === 'timeoff') return r.hand ? 'VAC' : null;
    } else if (validWeekday(ref.weekday)) {
      r = resolveRegular(state, ref.person, ref.weekday);
    } else {
      return null;
    }
    if (r.kind === 'dayoff' || r.kind === 'regularOff') return 'OFF';
    return r.kind === 'area' ? joinAreas(r.areas) : '';
  }

  function cellKey(c) { return c.row + ',' + c.col; }

  function inGrid(c, rows, cols) {
    return !!c && Number.isInteger(c.row) && Number.isInteger(c.col) && c.row >= 0 && c.col >= 0 && c.row < rows && c.col < cols;
  }

  // The selected cells that are inside the grid, each once, in the order given.
  function cleanCells(cells, rows, cols) {
    const seen = Object.create(null);
    const out = [];
    (cells || []).forEach(function (c) {
      if (!inGrid(c, rows, cols) || seen[cellKey(c)]) return;
      seen[cellKey(c)] = true;
      out.push({ row: c.row, col: c.col });
    });
    return out;
  }

  function bounds(cells) {
    const b = { r0: Infinity, r1: -Infinity, c0: Infinity, c1: -Infinity };
    cells.forEach(function (c) {
      b.r0 = Math.min(b.r0, c.row); b.r1 = Math.max(b.r1, c.row);
      b.c0 = Math.min(b.c0, c.col); b.c1 = Math.max(b.c1, c.col);
    });
    return b;
  }

  function gridSize(grid) {
    const rows = Array.isArray(grid) ? grid.length : 0;
    return { rows: rows, cols: rows && Array.isArray(grid[0]) ? grid[0].length : 0 };
  }

  // rectCells(a, b) -> every { row, col } in the rectangle with corners a and b.
  function rectCells(a, b) {
    const out = [];
    if (!a || !b) return out;
    const r0 = Math.min(a.row, b.row), r1 = Math.max(a.row, b.row);
    const c0 = Math.min(a.col, b.col), c1 = Math.max(a.col, b.col);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push({ row: r, col: c });
    return out;
  }

  // copyBlock(state, grid, selected) -> token[][]: the bounding box of the
  // selected cells; a cell inside the box that is not selected copies nothing.
  function copyBlock(state, grid, selected) {
    const size = gridSize(grid);
    const cells = cleanCells(selected, size.rows, size.cols);
    if (!cells.length) return [];
    const b = bounds(cells);
    const picked = Object.create(null);
    cells.forEach(function (c) { picked[cellKey(c)] = true; });
    const out = [];
    for (let r = b.r0; r <= b.r1; r++) {
      const line = [];
      for (let c = b.c0; c <= b.c1; c++) line.push(picked[r + ',' + c] ? cellToken(state, grid[r][c]) : null);
      out.push(line);
    }
    return out;
  }

  // The clipboard text: tab between cells, CRLF between rows, codes as shown.
  function encodeClipboard(block) {
    return (block || []).map(function (line) {
      return line.map(function (t) { return t == null ? '' : String(t); }).join('\t');
    }).join('\r\n');
  }

  // One pasted word -> a token, or undefined when it is not one this page knows.
  function readToken(raw) {
    let v = String(raw == null ? '' : raw).trim();
    if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') v = v.slice(1, -1).trim();
    const up = v.toUpperCase();
    if (up === '') return '';
    if (up === 'OFF' || up === 'OFF*') return 'OFF';
    if (up === 'VAC') return 'VAC';
    const parts = up.split('/').map(function (x) { return x.trim(); });
    return knownAreas(parts) && parts.length ? parts.join('/') : undefined;
  }

  // decodeClipboard(text) -> { block: token[][], ignored }. Case-insensitive;
  // takes LF or CRLF and the trailing line break a spreadsheet adds. In pasted
  // TEXT a blank cell means "leave this day as it is": it is a null and never
  // clears (only the page's own in-memory copy can say "this empty cell was
  // copied"). A word that is not an area code, OFF or empty is a null too, and
  // is counted in `ignored` (a blank is not). Text that is only whitespace has
  // nothing to paste: an empty block.
  function decodeClipboard(text) {
    if (typeof text !== 'string' || /^\s*$/.test(text)) return { block: [], ignored: 0 };
    let t = text.replace(/\r\n?/g, '\n');
    if (t.charAt(t.length - 1) === '\n') t = t.slice(0, -1);
    let ignored = 0;
    const block = t.split('\n').map(function (line) {
      return line.split('\t').map(function (raw) {
        const tk = readToken(raw);
        if (tk === undefined) { ignored += 1; return null; }
        return tk === '' ? null : tk;
      });
    });
    let width = 0;
    block.forEach(function (line) { width = Math.max(width, line.length); });
    block.forEach(function (line) { while (line.length < width) line.push(null); });
    return { block: block, ignored: ignored };
  }

  // sameClipboardText(a, b): true when both are text and differ only in line
  // breaks (CRLF, CR, LF) and trailing blanks, per line and at the end. The
  // page uses it to tell its own copy coming back from other text, because
  // some browsers hand the text back with other line breaks.
  function normClip(t) {
    return t.replace(/\r\n?/g, '\n').split('\n').map(function (l) { return l.replace(/[ \t]+$/, ''); }).join('\n').replace(/\s+$/, '');
  }
  function sameClipboardText(a, b) {
    return typeof a === 'string' && typeof b === 'string' && normClip(a) === normClip(b);
  }

  // pasteTargets(selected, block, rows, cols) -> [{ row, col, token }].
  // One selected cell: the block lands with its top-left corner there,
  // clipped to the grid. More than one: every selected cell takes the block's
  // cell at its offset from the selection's top-left, repeating the block
  // (so one copied cell fills them all). Nothing outside the grid.
  function pasteTargets(selected, block, rows, cols) {
    const out = [];
    const R = Array.isArray(block) ? block.length : 0;
    const C = R && Array.isArray(block[0]) ? block[0].length : 0;
    if (!R || !C) return out;
    const cells = cleanCells(selected, rows, cols);
    if (!cells.length) return out;
    if (cells.length === 1) {
      const a = cells[0];
      for (let r = 0; r < R; r++) {
        for (let c = 0; c < C; c++) {
          if (a.row + r < rows && a.col + c < cols) out.push({ row: a.row + r, col: a.col + c, token: block[r][c] });
        }
      }
      return out;
    }
    const b = bounds(cells);
    cells.forEach(function (c) {
      out.push({ row: c.row, col: c.col, token: block[(c.row - b.r0) % R][(c.col - b.c0) % C] });
    });
    return out;
  }

  // One cell set to one token. -> { state, status: 'done'|'locked'|'skip'|'ignored', label }
  // 'ignored' is a VAC token meeting a weekday cell (vacation is a date).
  function applyToken(state, today, ref, token, op) {
    if (token === null || token === undefined || !ref) return { state: state, status: 'skip' };
    if (token === 'VAC') {
      if (!isActive(state, ref.person)) return { state: state, status: 'skip' };
      if (!isDateRef(ref)) return { state: state, status: 'ignored' };
      const rv = resolve(state, ref.person, ref.date);
      if (rv.locked) return { state: state, status: 'locked', label: rv.label };
      return { state: setOverride(state, ref.person, ref.date, 'vac'), status: 'done' };
    }
    const off = token === 'OFF';
    const areas = token === '' || off ? [] : String(token).split('/');
    if (!knownAreas(areas) || (op === 'add' && areas.length !== 1)) return { state: state, status: 'skip' };
    if (!isActive(state, ref.person)) return { state: state, status: 'skip' };
    if (isDateRef(ref)) {
      const r = resolve(state, ref.person, ref.date);
      if (r.locked) return { state: state, status: 'locked', label: r.label };
      // Hand-set vacation is never overwritten, and a broad clear (a selection
      // Backspace, the Clear brush) skips it too. It leaves the vacation and the
      // entry stored under it alone. Only V, a lone Backspace (P.clear), the cell
      // menu and Undo remove it.
      if (r.hand) return { state: state, status: 'locked', label: 'VAC' };
      let next;
      if (op === 'add') next = paint(state, ref.person, ref.date, areas[0], { add: true });
      else if (off) next = (r.kind === 'dayoff' || r.kind === 'regularOff') ? state : dayOff(state, ref.person, ref.date);
      else next = setAreas(state, ref.person, ref.date, areas);
      return { state: next, status: 'done' };
    }
    if (!validWeekday(ref.weekday)) return { state: state, status: 'skip' };
    let next;
    if (op === 'add') next = paintRegular(state, today, ref.person, ref.weekday, areas[0], { add: true });
    else if (off) next = setRegularOff(state, today, ref.person, ref.weekday, true);
    else next = setAreasRegular(state, today, ref.person, ref.weekday, areas);
    return { state: next, status: 'done' };
  }

  function applyAll(state, today, edits, op) {
    let s = state, done = 0, locked = 0, vac = 0, ignored = 0;
    edits.forEach(function (e) {
      const before = e.ref ? cellToken(s, e.ref) : null;
      const out = applyToken(s, today, e.ref, e.token, op);
      s = out.state;
      // Only a day that now reads differently counts (A onto A is nothing).
      if (out.status === 'done' && cellToken(s, e.ref) !== before) done += 1;
      else if (out.status === 'locked') { locked += 1; if (out.label === 'VAC') vac += 1; }
      else if (out.status === 'ignored') ignored += 1;
    });
    return { state: s, done: done, skippedLocked: locked, skippedVacation: vac, ignoredVacation: ignored };
  }

  // planPaste(state, today, grid, selected, clip) ->
  //   { state, pasted, skippedLocked, skippedVacation, ignoredTokens }
  // grid: the shown cells as refs, rows in display order. selected: the
  // target { row, col } cells. clip: { block, ignored } from copyBlock or
  // decodeClipboard. A copied day off is a one-time day off on a date and a
  // regular day off in Regular schedule. Locked time off is never changed.
  // The page commits the returned state once, so a paste is one undo step.
  function planPaste(state, today, grid, selected, clip) {
    const size = gridSize(grid);
    const block = clip && Array.isArray(clip.block) ? clip.block : [];
    const edits = pasteTargets(selected, block, size.rows, size.cols).map(function (t) {
      return { ref: grid[t.row][t.col], token: t.token };
    });
    const r = applyAll(state, today, edits);
    return {
      state: r.state, pasted: r.done, skippedLocked: r.skippedLocked, skippedVacation: r.skippedVacation,
      ignoredTokens: (Number(clip && clip.ignored) || 0) + r.ignoredVacation, ignoredVacation: r.ignoredVacation,
    };
  }

  // fillCells(state, today, refs, op, code) -> { state, filled, skippedLocked, skippedVacation }
  // op: 'set' (exactly `code`), 'add' (`code` as a second area), 'off' (a day
  // off: one-time on a date, regular in Regular schedule) or 'clear'.
  function fillCells(state, today, refs, op, code) {
    const token = op === 'off' ? 'OFF' : (op === 'clear' ? '' : (AREA_CODES.indexOf(code) !== -1 ? code : null));
    if (['set', 'add', 'off', 'clear'].indexOf(op) === -1 || token === null) return { state: state, filled: 0, skippedLocked: 0 };
    const r = applyAll(state, today, (refs || []).map(function (ref) { return { ref: ref, token: token }; }), op === 'add' ? 'add' : (op === 'clear' ? 'clear' : 'set'));
    return { state: r.state, filled: r.done, skippedLocked: r.skippedLocked, skippedVacation: r.skippedVacation };
  }

  // ---- round 2: sorting, dates, the file's period, backups -------------

  // headerSort({ sort, day }, clicked) -> { sort, day }. clicked is
  // { by: 'name' } for the Admin heading or { by: 'area', day } for a day
  // heading (a date, or a weekday number in Regular schedule). `day` in the
  // current value is the column the By area sort is using now.
  function headerSort(cur, clicked) {
    const c = cur || {};
    if (clicked && clicked.by === 'name') return { sort: c.sort === 'name' ? 'list' : 'name', day: c.day };
    if (!clicked || clicked.by !== 'area') return { sort: c.sort, day: c.day };
    if (c.sort === 'area' && c.day === clicked.day) return { sort: 'list', day: c.day };
    return { sort: 'area', day: clicked.day };
  }

  // weekRange(today, offset) -> { from, len: 7 }: Sunday through Saturday of
  // the week holding `today` (offset 0) or a later one (offset 1, ...).
  function weekRange(today, offset) {
    if (!isIsoDate(today)) return null;
    return { from: addDays(today, -weekdayOf(today) + 7 * (Math.trunc(Number(offset)) || 0)), len: 7 };
  }

  // rangeTo(from, to) -> { ok: true, len } or { ok: false, reason } where
  // reason is 'before' (to is before from), 'too-long' (past MAX_LEN days)
  // or 'not-a-date'.
  function rangeTo(from, to) {
    if (!isIsoDate(from) || !isIsoDate(to)) return { ok: false, reason: 'not-a-date' };
    const n = dayNumber(to) - dayNumber(from) + 1;
    if (n < 1) return { ok: false, reason: 'before' };
    if (n > MAX_LEN) return { ok: false, reason: 'too-long' };
    return { ok: true, len: n };
  }

  // The file's "Time Period: M/D/YYYY - M/D/YYYY" -> { from, to } or null.
  function parsePeriod(text) {
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(text == null ? '' : text));
    if (!m) return null;
    const iso = function (mo, d, y) { return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'); };
    const from = iso(m[1], m[2], m[3]), to = iso(m[4], m[5], m[6]);
    if (!isIsoDate(from) || !isIsoDate(to) || to < from) return null;
    return { from: from, to: to };
  }

  // True when the kept file names its period and `date` is after its last day,
  // so an empty day there is not "nobody is off".
  function pastFile(state, date) {
    const p = state && state.timeOff && state.timeOff.period;
    return !!(p && isIsoDate(p.to) && isIsoDate(date) && date > p.to);
  }

  // backupDue(lastExportedAt ms|null, now ms, people count) -> true when the
  // last export is more than 14 days old, or there has never been one and
  // the planner has people in it.
  const BACKUP_DAYS = 14;
  function backupDue(lastExportedAt, now, peopleCount) {
    const t = Number(lastExportedAt);
    if (!(t > 0)) return Number(peopleCount) > 0;
    return Number(now) - t > BACKUP_DAYS * 86400000;
  }

  // ---- settings -------------------------------------------------------

  // setSettings(state, patch) -> State. Unknown keys and invalid values are
  // ignored. Changing managerId discards the kept time off rows (they were
  // filtered with the old ID), so the page must ask for the file again.
  function setSettings(state, patch) {
    const p = patch || {};
    const next = Object.assign({}, state.settings);
    if (typeof p.managerId === 'string') next.managerId = p.managerId.trim();
    if (typeof p.showAskedOff === 'boolean') next.showAskedOff = p.showAskedOff;
    if (SORTS.indexOf(p.sort) !== -1) next.sort = p.sort;
    if (VIEWS.indexOf(p.view) !== -1) next.view = p.view;
    if (p.from === '' || isIsoDate(p.from)) next.from = p.from;
    if (p.len !== undefined && isFinite(Number(p.len))) next.len = clampLen(p.len);
    const dropRows = next.managerId !== state.settings.managerId && state.timeOff !== null;
    if (samePattern(next, state.settings) && !dropRows) return state;
    return Object.assign({}, state, { settings: next, timeOff: dropRows ? null : state.timeOff });
  }

  return {
    AREAS: AREAS,
    AREA_CODES: AREA_CODES,
    MAX_LEN: MAX_LEN,
    emptyState: emptyState,
    isIsoDate: isIsoDate,
    weekdayOf: weekdayOf,
    addDays: addDays,
    rangeDates: rangeDates,
    regularFor: regularFor,
    resolve: resolve,
    resolveRegular: resolveRegular,
    counts: counts,
    order: order,
    collisions: collisions,
    paint: paint,
    dayOff: dayOff,
    clear: clear,
    paintRegular: paintRegular,
    regularOff: regularOff,
    clearRegular: clearRegular,
    clearAreas: clearAreas,
    clearAreasRegular: clearAreasRegular,
    resetRange: resetRange,
    addPerson: addPerson,
    renamePerson: renamePerson,
    removePerson: removePerson,
    linkPerson: linkPerson,
    employeeIdTaken: employeeIdTaken,
    applyReport: applyReport,
    unknownPeople: unknownPeople,
    unknownStatuses: unknownStatuses,
    leaveOut: leaveOut,
    clearLeftOut: clearLeftOut,
    countsRegular: countsRegular,
    orderRegular: orderRegular,
    setSettings: setSettings,
    // round 2
    setRegularOff: setRegularOff,
    movePerson: movePerson,
    cellToken: cellToken,
    copyBlock: copyBlock,
    encodeClipboard: encodeClipboard,
    decodeClipboard: decodeClipboard,
    sameClipboardText: sameClipboardText,
    duplicateEmployeeIds: duplicateEmployeeIds,
    rectCells: rectCells,
    pasteTargets: pasteTargets,
    planPaste: planPaste,
    fillCells: fillCells,
    headerSort: headerSort,
    weekRange: weekRange,
    rangeTo: rangeTo,
    parsePeriod: parsePeriod,
    pastFile: pastFile,
    backupDue: backupDue,
    // round 3
    overrideOf: overrideOf,
    toggleVacation: toggleVacation,
    toggleHideAsked: toggleHideAsked,
    hiddenAsked: hiddenAsked,
    hiddenAskedCount: hiddenAskedCount,
    showHiddenAsked: showHiddenAsked,
  };
});
