'use strict';

// Schedule Planner storage. One versioned localStorage value, plus Export and
// Import of everything in it. Pure of the DOM; the page passes localStorage.
// Same read and refuse rules as lib/writeups-store.js:
//  * Nothing stored is "empty". Anything stored that cannot be read (damaged
//    JSON, a version this page does not know, a shape that fails the checks,
//    a storage that throws on read) is "unreadable": the page says so, save()
//    refuses, and the stored bytes are never touched. Unreadable is never
//    presented as an empty schedule.
//  * Two tabs: the store remembers the raw string it last loaded or wrote and
//    save() refuses (lastError 'changed-elsewhere') when the stored value is
//    no longer exactly that, so a tab that has not seen another tab's work can
//    never write over it. load() makes the store current again.
//  * A backup is checked by the same checks that import it before it is handed
//    over, so an export that could not be restored is never produced.
//
// Dual-loadable with no build step:
// - Browser: window.SchedulePlannerStore
// - Node:    require('./lib/schedule-planner-store')
//
// Keys (localStorage):
//   schedule-planner:state  { version: 1, state }
//   schedule-planner:ui     { version: 1, lastExportedAt }   (not part of the backup)

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SchedulePlannerStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  const STATE_KEY = 'schedule-planner:state';
  const UI_KEY = 'schedule-planner:ui';
  const SCHEMA_VERSION = 1;
  const EXPORT_FORMAT = 'station-schedule-planner';
  const EXPORT_VERSION = 1;
  const MAX_AREAS_PER_DAY = 2;

  let planner = null;
  function Planner() {
    if (!planner) {
      planner = (root && root.SchedulePlanner) ||
        (typeof require === 'function' ? require('./schedule-planner') : null);
    }
    return planner;
  }

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isStr(v) { return typeof v === 'string'; }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  // ---- shape checks ---------------------------------------------------
  // Each returns an error message (plain words, naming the part) or null.

  function checkCell(cell, where) {
    if (!isObj(cell)) return where + ' is not a day entry.';
    const keys = Object.keys(cell);
    if (keys.length === 1 && keys[0] === 'off') {
      return cell.off === true ? null : where + ' has a day off flag that is not true.';
    }
    if (keys.length === 1 && keys[0] === 'areas') {
      const areas = cell.areas;
      if (!Array.isArray(areas)) return where + ' has areas that are not a list.';
      if (areas.length > MAX_AREAS_PER_DAY) return where + ' has more than ' + MAX_AREAS_PER_DAY + ' areas.';
      for (let i = 0; i < areas.length; i++) {
        if (Planner().AREA_CODES.indexOf(areas[i]) === -1) return where + ' names an area this page does not know.';
        if (areas.indexOf(areas[i]) !== i) return where + ' repeats an area.';
      }
      return null;
    }
    return where + ' is neither an area list nor a day off.';
  }

  function checkPeople(list, label, seen) {
    if (!Array.isArray(list)) return 'The ' + label + ' list is missing.';
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const at = 'Entry ' + (i + 1) + ' of the ' + label + ' list';
      if (!isObj(p)) return at + ' is not a person.';
      if (!isStr(p.id) || p.id === '') return at + ' has no id.';
      if (p.id === '__proto__') return at + ' has an id that is not allowed.';
      if (seen[p.id]) return at + ' repeats an id used by another person.';
      seen[p.id] = true;
      if (!isStr(p.name)) return at + ' has no name.';
      if (!isStr(p.employeeId)) return at + ' has an employee ID that is not text.';
    }
    return null;
  }

  function checkRows(rows) {
    if (!Array.isArray(rows)) return 'The kept time off rows are not a list.';
    const P = Planner();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const at = 'Time off row ' + (i + 1);
      if (!isObj(r)) return at + ' is not a row.';
      if (!isStr(r.employeeId) || r.employeeId === '') return at + ' has no employee ID.';
      if (!P.isIsoDate(r.date)) return at + ' has a date that is not YYYY-MM-DD.';
      if (r.kind !== 'approved' && r.kind !== 'asked') return at + ' is neither approved nor asked.';
      if (!isStr(r.payCode)) return at + ' has no pay code.';
      if (!isStr(r.hours)) return at + ' has hours that are not text.';
      const optional = ['name', 'reportsTo', 'status'];
      for (let k = 0; k < optional.length; k++) {
        if (r[optional[k]] !== undefined && !isStr(r[optional[k]])) return at + ' has a ' + optional[k] + ' that is not text.';
      }
    }
    return null;
  }

  // validateState(state) -> an error message, or null when the state is sound.
  function validateState(s) {
    const P = Planner();
    if (!isObj(s)) return 'The saved schedule is not an object.';
    const seen = Object.create(null);
    let err = checkPeople(s.people, 'people', seen) || checkPeople(s.removed, 'removed people', seen);
    if (err) return err;

    if (!Array.isArray(s.regular)) return 'The regular schedule is missing.';
    let prev = '';
    for (let i = 0; i < s.regular.length; i++) {
      const v = s.regular[i];
      const at = 'Regular schedule version ' + (i + 1);
      if (!isObj(v)) return at + ' is not a version.';
      if (!P.isIsoDate(v.from)) return at + ' has a start date that is not YYYY-MM-DD.';
      if (prev !== '' && v.from <= prev) return at + ' is not dated after the one before it.';
      prev = v.from;
      if (v.edited !== undefined && !P.isIsoDate(v.edited)) return at + ' has an edit date that is not YYYY-MM-DD.';
      if (!isObj(v.pattern)) return at + ' has no pattern.';
      const ids = Object.keys(v.pattern);
      for (let a = 0; a < ids.length; a++) {
        const byDay = v.pattern[ids[a]];
        if (!isObj(byDay)) return at + ' has a person entry that is not a list of weekdays.';
        const days = Object.keys(byDay);
        for (let b = 0; b < days.length; b++) {
          if (!/^[0-6]$/.test(days[b])) return at + ' has a weekday that is not 0 to 6.';
          err = checkCell(byDay[days[b]], at + ', weekday ' + days[b] + ',');
          if (err) return err;
        }
      }
    }

    if (!isObj(s.days)) return 'The dated changes are missing.';
    const owners = Object.keys(s.days);
    for (let a = 0; a < owners.length; a++) {
      const byDate = s.days[owners[a]];
      if (!isObj(byDate)) return 'A person\'s dated changes are not a list of dates.';
      const dates = Object.keys(byDate);
      for (let b = 0; b < dates.length; b++) {
        if (!P.isIsoDate(dates[b])) return 'A dated change has a date that is not YYYY-MM-DD.';
        err = checkCell(byDate[dates[b]], 'The dated change for ' + dates[b]);
        if (err) return err;
      }
    }

    if (s.timeOff !== null) {
      const t = s.timeOff;
      if (!isObj(t)) return 'The kept time off file record is not an object.';
      if (!isStr(t.fileName) || !isStr(t.runDate)) return 'The kept time off file record has no file name or run date.';
      if (!(typeof t.loadedAt === 'number' || isStr(t.loadedAt))) return 'The kept time off file record has no load time.';
      if (!isFinite(t.total) || !isFinite(t.mine)) return 'The kept time off file record has counts that are not numbers.';
      // Round 2, optional: the period the file covers.
      if (t.period !== undefined && (!isObj(t.period) || !P.isIsoDate(t.period.from) || !P.isIsoDate(t.period.to))) {
        return 'The kept time off file record has a period that is not two dates.';
      }
      err = checkRows(t.rows);
      if (err) return err;
    }

    if (!Array.isArray(s.leftOut) || !s.leftOut.every(isStr)) return 'The left out list is not a list of employee IDs.';

    const st = s.settings;
    if (!isObj(st)) return 'The settings are missing.';
    if (!isStr(st.managerId)) return 'The manager ID setting is not text.';
    if (typeof st.showAskedOff !== 'boolean') return 'The show asked off setting is not true or false.';
    if (['list', 'name', 'area'].indexOf(st.sort) === -1) return 'The sort setting is not one this page knows.';
    if (['regular', 'dates'].indexOf(st.view) === -1) return 'The view setting is not one this page knows.';
    if (st.from !== '' && !P.isIsoDate(st.from)) return 'The From date setting is not YYYY-MM-DD.';
    if (!Number.isInteger(st.len) || st.len < 1 || st.len > P.MAX_LEN) return 'The length setting is not a whole number from 1 to ' + P.MAX_LEN + '.';
    return null;
  }

  // ---- import-only checks (review L4, round 2) -----------------------
  // A backup is a file from anywhere, so it gets checks the stored value does
  // not: nothing here can be produced by the page (ids are made by the page
  // from letters, digits and hyphens, employee IDs are trimmed, and a person's
  // days only ever move to `removed` with them). Two admins sharing an
  // employee ID is NOT refused: the page refuses to create one, but a state
  // that loads must export and restore, so the page warns about it instead. The checks are NOT
  // applied on load, so nothing a page has stored becomes unreadable because
  // of them. Removed admins may share an employee ID with each other or with
  // an admin in the grid: round 1 allows that (link an ID that a removed admin
  // had), so refusing it would refuse a backup of a real planner.

  // The first own key named __proto__ anywhere in v, as a path, or ''.
  function protoKeyPath(v, where) {
    if (v === null || typeof v !== 'object') return '';
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === '__proto__') return where;
      const found = protoKeyPath(v[keys[i]], where + '.' + keys[i]);
      if (found) return found;
    }
    return '';
  }

  // Trims every employee ID in place (on the backup's own copy).
  function trimIds(s) {
    s.people.concat(s.removed).forEach(function (p) { p.employeeId = p.employeeId.trim(); });
  }

  // checkImportOnly(state) -> an error message, or null. `state` has passed
  // validateState and had its employee IDs trimmed.
  function checkImportOnly(s) {
    const known = Object.create(null);
    const all = s.people.concat(s.removed);
    for (let i = 0; i < all.length; i++) {
      if (!/^[A-Za-z0-9_.:-]+$/.test(all[i].id)) return 'A person has an id with a character this page does not accept (only letters, digits, hyphen, underscore, dot and colon).';
      known[all[i].id] = true;
    }
    const owners = Object.keys(s.days);
    for (let i = 0; i < owners.length; i++) {
      if (!known[owners[i]]) return 'It has dated changes for someone who is in neither the admins nor the removed list.';
    }
    for (let v = 0; v < s.regular.length; v++) {
      const ids = Object.keys(s.regular[v].pattern);
      for (let i = 0; i < ids.length; i++) {
        if (!known[ids[i]]) return 'Its regular schedule has a pattern for someone who is in neither the admins nor the removed list.';
      }
    }
    return null;
  }

  function summarize(state) {
    let dated = 0;
    Object.keys(state.days).forEach(function (id) { dated += Object.keys(state.days[id]).length; });
    return {
      people: state.people.length,
      datedDays: dated,
      regularVersions: state.regular.length,
      timeOffRows: state.timeOff ? state.timeOff.rows.length : 0,
    };
  }

  // checkBackup(input) -> { ok: true, state, summary } | { ok: false, error }
  // `input` is the parsed backup, or the file's text. It never throws: a file
  // so deeply nested that the checks run out of stack is refused like any
  // other file that cannot be restored.
  function checkBackup(input) {
    try {
      return checkBackupUnsafe(input);
    } catch (e) {
      return { ok: false, error: 'That file cannot be read as a backup (it is nested too deeply or is otherwise unusable). Nothing was changed.' };
    }
  }

  function checkBackupUnsafe(input) {
    let file = input;
    if (isStr(input)) {
      try { file = JSON.parse(input); } catch (e) { return { ok: false, error: 'That file is not a Schedule Planner backup. It is not valid JSON.' }; }
    }
    if (!isObj(file)) return { ok: false, error: 'That file is not a Schedule Planner backup.' };
    if (file.format !== EXPORT_FORMAT) return { ok: false, error: 'That file is not a Schedule Planner backup. Expected format "' + EXPORT_FORMAT + '".' };
    if (file.version !== EXPORT_VERSION) {
      return { ok: false, error: typeof file.version === 'number' && file.version > EXPORT_VERSION
        ? 'That backup was made by a newer version of this page. Nothing was changed.'
        : 'That backup has a version this page does not know. Nothing was changed.' };
    }
    if (!isStr(file.exportedAt) || isNaN(Date.parse(file.exportedAt))) return { ok: false, error: 'That backup has no export time. Nothing was changed.' };
    const proto = protoKeyPath(file, 'backup');
    if (proto) return { ok: false, error: 'That backup cannot be restored. It uses the key __proto__ (at ' + proto + '), which this page does not accept. Nothing was changed.' };
    let err = validateState(file.state);
    if (err) return { ok: false, error: 'That backup cannot be restored. ' + err + ' Nothing was changed.' };
    const state = clone(file.state);
    trimIds(state);
    err = checkImportOnly(state);
    if (err) return { ok: false, error: 'That backup cannot be restored. ' + err + ' Nothing was changed.' };
    return { ok: true, state: state, summary: summarize(state), exportedAt: file.exportedAt };
  }

  // ---- the store ------------------------------------------------------

  function createStore(storage, opts) {
    const o = opts || {};
    const now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
    // The last known state of the stored value: 'empty' | 'ok' | 'unreadable'.
    // Set by load(), save() and importAll(); computed on first use otherwise.
    let known = null;
    // The raw stored string this store last loaded or wrote (null: nothing was
    // stored; undefined: storage could not be read). save() writes only while
    // the stored value is still exactly this, so a second tab's work is never
    // overwritten by a tab that has not seen it.
    let lastRaw;
    let lastError = null;

    function getRaw() {
      try { return storage ? storage.getItem(STATE_KEY) : undefined; } catch (e) { return undefined; }
    }

    function readState() {
      const raw = getRaw();
      // undefined: no storage, or one that throws. It cannot be shown to be
      // empty, so it is unreadable and read-only rather than a clean slate.
      if (raw === undefined) return { status: 'unreadable', state: Planner().emptyState(), raw: raw };
      if (raw == null) return { status: 'empty', state: Planner().emptyState(), raw: null };
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!isObj(parsed) || parsed.version !== SCHEMA_VERSION || validateState(parsed.state) !== null) {
        return { status: 'unreadable', state: Planner().emptyState(), raw: raw };
      }
      return { status: 'ok', state: parsed.state, raw: raw };
    }

    function write(state) {
      if (!storage) return false;
      const text = JSON.stringify({ version: SCHEMA_VERSION, state: state });
      try { storage.setItem(STATE_KEY, text); } catch (e) { return false; }
      known = 'ok';
      lastRaw = text;
      return true;
    }

    // load() -> { state, status }. For 'unreadable' the state is an empty
    // placeholder: the page must show the unreadable message, not that state.
    // It also makes this store current with whatever is stored now.
    function load() {
      const r = readState();
      known = r.status;
      lastRaw = r.raw;
      lastError = null;
      return { state: r.state, status: r.status };
    }

    // changedElsewhere() -> true when the stored value is no longer what this
    // store last loaded or wrote (another tab or window saved). Writes nothing.
    function changedElsewhere() {
      if (known === null) return false;
      if (getRaw() !== lastRaw) { lastError = 'changed-elsewhere'; return true; }
      return false;
    }

    // save(state) -> true when written. False, with `lastError` saying why:
    //   'unreadable'         the stored value cannot be read (nothing is written)
    //   'invalid'            the state fails the checks a later load would apply
    //   'changed-elsewhere'  the stored value is not what this store last
    //                        loaded or wrote, so writing would overwrite
    //                        another tab's work; load() to catch up
    //   'write-failed'       the write threw (storage full or blocked)
    function save(state) {
      if (known === null) { const r = readState(); known = r.status; lastRaw = r.raw; }
      if (known === 'unreadable') { lastError = 'unreadable'; return false; }
      if (validateState(state) !== null) { lastError = 'invalid'; return false; }
      if (getRaw() !== lastRaw) { lastError = 'changed-elsewhere'; return false; }
      if (!write(state)) { lastError = 'write-failed'; return false; }
      lastError = null;
      return true;
    }

    // exportAll(state?) -> the one versioned backup object, or null. With no
    // argument it exports what is stored; null while that is unreadable. Pass
    // the page's own state to back up work that could not be saved (a full
    // storage). The result is run through the import checks first.
    function exportAll(state) {
      let source = state;
      if (source === undefined) {
        const r = readState();
        if (r.status === 'unreadable') return null;
        source = r.state;
      }
      const file = {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: new Date(now()).toISOString(),
        state: isObj(source) ? clone(source) : source,
      };
      return checkBackup(file).ok ? file : null;
    }

    // inspectImport(parsed) -> { ok: true, summary } | { ok: false, error }.
    function inspectImport(parsed) {
      const r = checkBackup(parsed);
      return r.ok ? { ok: true, summary: r.summary } : { ok: false, error: r.error };
    }

    // importAll(parsed, opts?) -> true when the stored value was replaced.
    // Validates first; a refused import changes nothing. It also refuses to
    // write over an unreadable stored value (which may be a newer page's data)
    // unless opts.overwriteUnreadable is true, which the page sets only after
    // the person says so.
    function importAll(parsed, importOpts) {
      const r = checkBackup(parsed);
      if (!r.ok) return false;
      if (readState().status === 'unreadable' && !(importOpts && importOpts.overwriteUnreadable === true)) return false;
      if (!write(r.state)) return false;
      lastError = null;
      return true;
    }

    function readUi() {
      let raw = null;
      try { raw = storage ? storage.getItem(UI_KEY) : null; } catch (e) { return null; }
      if (raw == null) return {};
      try {
        const p = JSON.parse(raw);
        return isObj(p) && p.version === SCHEMA_VERSION ? p : null;
      } catch (e) { return null; }
    }

    // exportInfo() -> { lastExportedAt: ms | null }.
    function exportInfo() {
      const ui = readUi();
      const t = ui ? Number(ui.lastExportedAt) : 0;
      return { lastExportedAt: t > 0 ? t : null };
    }

    // markExported() -> true when saved. The page calls it once the file has
    // been handed to the browser.
    function markExported() {
      if (!storage) return false;
      try { storage.setItem(UI_KEY, JSON.stringify({ version: SCHEMA_VERSION, lastExportedAt: now() })); } catch (e) { return false; }
      return true;
    }

    return {
      load: load,
      save: save,
      changedElsewhere: changedElsewhere,
      get lastError() { return lastError; },
      exportAll: exportAll,
      inspectImport: inspectImport,
      importAll: importAll,
      exportInfo: exportInfo,
      markExported: markExported,
    };
  }

  return {
    STATE_KEY: STATE_KEY,
    UI_KEY: UI_KEY,
    EXPORT_FORMAT: EXPORT_FORMAT,
    createStore: createStore,
    validateState: validateState,
  };
});
