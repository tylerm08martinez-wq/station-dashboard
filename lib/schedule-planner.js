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
//   2. a day off added by hand for that date
//   3. a change made for that date (an area, or cleared to empty)
//   4. the regular schedule version in force on that date
//   5. open
// A request that is only asked for (not approved) never blocks: it sets
// `asked` and the lookup carries on with 2 to 5.
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

  function resolve(state, personId, date) {
    const entry = timeOffEntry(state, personId, date);
    const dated = datedCell(state, personId, date);

    // 1. Approved time off: locked. Any dated entry stays underneath, uncounted.
    if (entry && entry.kind === 'approved') {
      let tip = entryDescription(entry) + '. Approved in the time off file.';
      if (dated && Array.isArray(dated.areas) && dated.areas.length) {
        tip += ' Your entry for this day (' + joinAreas(dated.areas) + ') is kept underneath.';
      }
      return { kind: 'timeoff', areas: [], label: entry.label, asked: false, changed: false, locked: true, tip: tip };
    }

    const asked = !!(entry && entry.kind === 'asked');
    const askedTip = asked ? 'Asked off: ' + entryDescription(entry) + '. Not approved in the time off file yet.' : '';
    function tipWith(text) { return [askedTip, text].filter(Boolean).join(' '); }

    const reg = outcomeOfCell(patternCell(regularFor(state, date), personId, weekdayOf(date)));

    // 2 and 3. What Tyler set for this date.
    if (dated) {
      if (dated.off === true) {
        return {
          kind: 'dayoff', areas: [], label: 'OFF*', asked: asked, locked: false,
          changed: reg.kind !== 'dayoff', tip: tipWith('Day off added by hand.'),
        };
      }
      const areas = Array.isArray(dated.areas) ? dated.areas.slice() : [];
      const outcome = areas.length ? { kind: 'area', areas: areas } : { kind: 'open', areas: [] };
      const changed = outcome.kind !== reg.kind || joinAreas(outcome.areas) !== joinAreas(reg.areas);
      return {
        kind: outcome.kind, areas: outcome.areas, label: '', asked: asked, locked: false, changed: changed,
        tip: tipWith(changed ? 'Changed from the regular schedule.' : ''),
      };
    }

    // 4. The regular schedule, 5. otherwise open.
    return {
      kind: reg.kind, areas: reg.areas, label: reg.kind === 'regularOff' ? 'OFF' : '', asked: asked, changed: false,
      locked: false, tip: tipWith(reg.kind === 'regularOff' ? 'Regular day off.' : ''),
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
    const touched = {};
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
    return r.locked ? null : r;
  }

  // The cell that clears a date: removed when the regular schedule is open
  // there, an explicit empty cell when it is not.
  function clearedCell(state, personId, date) {
    const reg = outcomeOfCell(patternCell(regularFor(state, date), personId, weekdayOf(date)));
    return reg.kind === 'open' ? null : { areas: [] };
  }

  function clear(state, personId, date) {
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
    return Object.assign({}, state, {
      timeOff: {
        fileName: String(report && report.fileName != null ? report.fileName : ''),
        runDate: String(report && report.runDate != null ? report.runDate : ''),
        loadedAt: loadedAt,
        total: Number(report && report.total) || 0,
        mine: rows.length,
        rows: rows,
      },
    });
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
  };
});
