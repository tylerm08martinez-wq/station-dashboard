'use strict';

// Writeups storage (issue #1091, spec #1090).
//
// Device-local only. Admin names, incidents and (from #1092) writeup history
// live in this browser's localStorage and are NEVER synced, uploaded or
// written to the repo (ADR 0005: discipline is never written to the repo).
// This module has no network path and none may be added.
//
// NAMESPACE. The hosted origin is shared by every hosted tool, so every key is
// `writeups:<name>`. Nothing here reads or writes an un-namespaced key.
//
// VERSIONED RECORD SETS. Each key holds { version, items }. A record set
// stamped with a version this page does not know is treated as unreadable
// AND read-only: the page shows it as empty and refuses every write to that
// key, so an older cached page can never overwrite newer data.
//
// Record shapes (spec #1090 "Record shapes"):
//   Admin:    { id, name, workDays? }   workDays (#1112): the days the admin
//             is scheduled, weekday numbers 0 = Sunday .. 6 = Saturday, sorted
//             and unique. Absent means not set; older records and backups
//             have none.
//   Incident: { id, adminId, date: 'YYYY-MM-DD', kind, ...the kind's fields,
//               createdAt }   e.g. Late: scheduledStart, clockIn ('HH:MM');
//               Call-off: notifiedAt ('HH:MM' or ''), protectedSick (boolean);
//               NCNS: contactedAt ('HH:MM' or '');
//               Left early (sick) (#1094): scheduledEnd, clockOut ('HH:MM'),
//               clockOutNextDay (boolean: the clock-out was after midnight).
//               It carries no protectedSick flag: every one is protected,
//               and lib/writeups.js decides that from the kind.
//   History:  { id, adminId, date: 'YYYY-MM-DD', docType: 'notice'|'final'|
//               'discussion', reason, incidentDates: ['YYYY-MM-DD'],
//               source: 'drafted'|'backfill', createdAt }   (#1092)
//             A drafted record also carries incidentIds and incidentKinds
//             (parallel lists) and sickPattern: true for a sick-pattern
//             Documented Discussion (#1094 review round 1). Older records
//             and backfills have none of the three.
//
// Settings (#1116): `writeups:settings` holds Tyler's in-page Settings as
// { key, value } items (naming, sentences, extraMedicalWords, stationPhrases,
// extraReasons, sickPatternMin). What a valid setting is lives in
// lib/writeups.js (checkSettings); the store refuses to save anything it
// refuses, and settings travel in the backup file from format 2 on.
//
// The page owns no storage logic: it creates one store over window.localStorage
// and calls these methods. Export/import (#1097): exportAll / inspectImport /
// importAll, plus exportInfo / markExported for the "last exported" line and
// the nudge. Import REPLACES (no merge) and refuses, untouched, anything it
// cannot fully check or any device whose current data is unreadable.
//
// Dual-loadable with no build step:
// - Browser: window.WriteupsStore
// - Node:    require('./lib/writeups-store')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WriteupsStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const NAMESPACE = 'writeups';
  const SCHEMA_VERSION = 1;
  // The backup file (#1097). The app id stops another tool's JSON importing
  // here; the format version is bumped whenever the file's shape changes, so an
  // older page refuses a newer file instead of half-reading it.
  const EXPORT_APP = 'station-849-writeups';
  // Format 2 (#1116) adds `settings`. A format 1 file (made before Settings)
  // still imports, and leaves this device's settings as they are.
  const EXPORT_FORMAT_VERSION = 2;
  const IMPORTABLE_FORMATS = [1, 2];
  // Written in a backup made while the Settings could not be read (#1119).
  const SETTINGS_OMITTED_NOTE = 'Settings were left out: the saved Settings on this device could not be read. ' +
    'Admins, incidents and history are all here.';
  const KEYS = { admins: 'admins', incidents: 'incidents', ui: 'ui', history: 'history', settings: 'settings' };
  // At most ONE incident per admin per shift date within each group. The
  // attendance kinds (Late, Call-off, NCNS) share a group, so a day never
  // counts twice toward a pattern. A sick early departure (#1094) has its own
  // group: it can share a day with a Late (late in, sick out), but two on one
  // day would list the same day twice in a sick-pattern Documented Discussion.
  //
  // Review round 1: an admin who called off or did not show cannot also have
  // left that shift early (sick), so a Left early (sick) is also refused on a
  // day that already holds a Call-off or NCNS, and the other way round. A
  // Late plus a sick early departure stays allowed (late in, sick out).
  const ONE_PER_DAY_GROUPS = [['late', 'calloff', 'ncns'], ['sickearly']];
  const NEVER_SAME_DAY = [['sickearly', 'calloff'], ['sickearly', 'ncns']];
  // kind -> every kind it can never share a shift date with.
  function dayGroup(kind) {
    let out = null;
    for (let i = 0; i < ONE_PER_DAY_GROUPS.length; i++) {
      if (ONE_PER_DAY_GROUPS[i].indexOf(kind) !== -1) out = ONE_PER_DAY_GROUPS[i].slice();
    }
    if (!out) return null;
    NEVER_SAME_DAY.forEach(function (pair) {
      const at = pair.indexOf(kind);
      if (at !== -1 && out.indexOf(pair[1 - at]) === -1) out.push(pair[1 - at]);
    });
    return out;
  }

  function fullKey(name) { return NAMESPACE + ':' + name; }

  function defaultNewId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // createStore(storage, opts) -> the store. `storage` is localStorage or any
  // { getItem, setItem }; null/undefined or a throwing storage degrades to
  // "nothing saved" rather than throwing. opts.now / opts.newId make ids and
  // timestamps deterministic in tests.
  function createStore(storage, opts) {
    const o = opts || {};
    const now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
    const newId = typeof o.newId === 'function' ? o.newId : defaultNewId;

    // read(name) -> { items, writable }
    function read(name) {
      let raw = null;
      // A storage that throws on read cannot be shown to be empty, so it is
      // unreadable (and read-only) rather than a clean slate to write over.
      try { raw = storage ? storage.getItem(fullKey(name)) : null; } catch (e) { return { items: [], writable: false }; }
      if (raw == null) return { items: null, writable: true };
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!parsed || typeof parsed !== 'object' || parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.items)) {
        // Unknown version or a damaged value: do not read it as data, and do
        // not overwrite it either. It stays for a person (or #1097's import
        // checks) to look at.
        return { items: [], writable: false };
      }
      return { items: parsed.items, writable: true };
    }

    function write(name, items) {
      if (!storage) return false;
      if (!read(name).writable) return false;
      try {
        storage.setItem(fullKey(name), JSON.stringify({ version: SCHEMA_VERSION, items: items }));
        return true;
      } catch (e) {
        return false;
      }
    }

    // unreadable() -> the names of stored record sets that hold something the
    // store cannot read (damaged JSON, a newer version, a storage that throws
    // on read). They read as empty and refuse writes, but "empty" and
    // "unreadable" must not look the same to the page, so the page asks here
    // and tells the person instead of showing a blank list.
    //
    // #1119 review round 1: Settings are NOT in this list. A damaged
    // `writeups:settings` must not block the admins, incidents and history
    // (or their backup): drafts then use the default settings, the page says
    // so through settingsUnreadable(), and offers resetSettings().
    function unreadable() {
      return Object.keys(KEYS).map(function (k) { return KEYS[k]; }).filter(function (name) {
        return name !== KEYS.settings && !read(name).writable;
      });
    }

    // settingsUnreadable() -> true when `writeups:settings` holds something
    // the store cannot read (damaged, newer version, a storage that throws).
    function settingsUnreadable() {
      return !read(KEYS.settings).writable;
    }

    function list(name) {
      return (read(name).items || []).slice();
    }

    function byName(a, b) {
      return String(a.name).localeCompare(String(b.name));
    }

    function admins() {
      return list(KEYS.admins).filter(function (a) { return a && a.id && a.name; }).sort(byName);
    }

    function cleanName(name) {
      return String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
    }

    // addAdmin(name) -> the new { id, name }, or null (blank, duplicate name
    // in any case, or the write was refused).
    function addAdmin(name) {
      const clean = cleanName(name);
      if (!clean) return null;
      const current = list(KEYS.admins);
      const lower = clean.toLowerCase();
      if (current.some(function (a) { return a && String(a.name).toLowerCase() === lower; })) return null;
      const admin = { id: newId('adm'), name: clean };
      return write(KEYS.admins, current.concat([admin])) ? admin : null;
    }

    // seedAdmins(names) -> true when it seeded. Only ever seeds a device that
    // has never stored an admin list, so the roster fills a fresh device once
    // and never re-adds a name Tyler has since changed. No roster (the hosted
    // build ships without lib/admins.js) is a no-op.
    function seedAdmins(names) {
      if (!Array.isArray(names) || names.length === 0) return false;
      if (read(KEYS.admins).items !== null) return false;
      const seen = {};
      const items = [];
      names.forEach(function (n) {
        const clean = cleanName(n);
        if (!clean || seen[clean.toLowerCase()]) return;
        seen[clean.toLowerCase()] = true;
        items.push({ id: newId('adm'), name: clean });
      });
      if (!items.length) return false;
      return write(KEYS.admins, items);
    }

    // The one shape a scheduled-days list may take: an array of unique
    // integers 0-6. Used to refuse a save and to refuse a backup.
    function validWorkDays(days) {
      if (!Array.isArray(days)) return false;
      const seen = {};
      for (let i = 0; i < days.length; i++) {
        const d = days[i];
        if (typeof d !== 'number' || d < 0 || d > 6 || d !== Math.floor(d) || seen[d]) return false;
        seen[d] = true;
      }
      return true;
    }

    // setAdminWorkDays(id, days) -> the updated admin, or null (unknown admin,
    // a list that is not unique integers 0-6, or the write was refused). An
    // empty list clears the setting: the key is removed, not kept empty.
    function setAdminWorkDays(id, days) {
      if (!validWorkDays(days)) return null;
      const current = list(KEYS.admins);
      const idx = current.findIndex(function (a) { return a && a.id === id; });
      if (idx === -1) return null;
      const next = Object.assign({}, current[idx]);
      delete next.workDays;
      if (days.length) next.workDays = days.slice().sort(function (a, b) { return a - b; });
      const items = current.slice();
      items[idx] = next;
      return write(KEYS.admins, items) ? next : null;
    }

    function adminExists(id) {
      return list(KEYS.admins).some(function (a) { return a && a.id === id; });
    }

    // incidents(adminId) -> that admin's incidents, newest first.
    function incidents(adminId) {
      return list(KEYS.incidents)
        .filter(function (i) { return i && i.adminId === adminId; })
        .sort(function (a, b) {
          if (a.date !== b.date) return a.date < b.date ? 1 : -1;
          return (b.createdAt || 0) - (a.createdAt || 0);
        });
    }

    // duplicateOnDay(incident) -> the OTHER saved attendance incident (Late,
    // Call-off or NCNS, ANY of the three) this admin already has on the same
    // shift date, or null. A Left early (sick) is checked against other Left
    // early (sick) incidents and against a Call-off or NCNS (#1094, review
    // round 1), never against a Late. For a Call-off or NCNS a Left early
    // (sick) on the day is found too. One attendance event per admin per shift date, so a
    // day never counts twice toward a pattern ("any 4 combined") or a "late on
    // 2 days" sentence. #1093 widened this from Lates only, then from per kind
    // to across kinds (review round 1: a Late plus a Call-off on one day both
    // saved and counted twice).
    function duplicateOnDay(incident) {
      const inc = incident || {};
      const group = dayGroup(inc.kind);
      if (!group || !inc.adminId || !inc.date) return null;
      const found = list(KEYS.incidents).filter(function (x) {
        return x && group.indexOf(x.kind) !== -1 && x.adminId === inc.adminId && x.date === inc.date &&
          (!inc.id || x.id !== inc.id);
      })[0];
      return found || null;
    }

    // duplicateLate(incident) -> duplicateOnDay for a Late only (#1101's name).
    function duplicateLate(incident) {
      return incident && incident.kind === 'late' ? duplicateOnDay(incident) : null;
    }

    // saveIncident(incident) -> the saved record, or null. A record with a
    // known id is edited in place (createdAt kept); otherwise it is new.
    // Validation of the kind's fields is the logic module's job
    // (Writeups.validateIncident); the page calls it before saving.
    function saveIncident(incident) {
      const inc = incident || {};
      if (!inc.adminId || !adminExists(inc.adminId)) return null;
      if (duplicateOnDay(inc)) return null;
      const current = list(KEYS.incidents);
      const idx = inc.id ? current.findIndex(function (x) { return x && x.id === inc.id; }) : -1;
      const record = Object.assign({}, inc);
      if (idx === -1) {
        record.id = inc.id || newId('inc');
        record.createdAt = now();
        current.push(record);
      } else {
        // An incident never moves to another admin: an edit saved under the
        // wrong admin would file discipline history against the wrong person.
        if (current[idx].adminId !== inc.adminId) return null;
        record.createdAt = current[idx].createdAt;
        current[idx] = record;
      }
      return write(KEYS.incidents, current) ? record : null;
    }

    function deleteIncident(id) {
      const current = list(KEYS.incidents);
      const next = current.filter(function (x) { return !x || x.id !== id; });
      if (next.length === current.length) return false;
      return write(KEYS.incidents, next);
    }

    // ── Writeup history (#1092) ─────────────────────────────────────────
    //
    // Written only by an explicit "Save to history" or "Add a past writeup".
    // Copying a box never reaches here. What a valid entry is (a real date not
    // after today, a known type and Reason) is the logic module's job
    // (Writeups.validateHistoryEntry); the store refuses only what it cannot
    // file safely.

    // history(adminId) -> that admin's writeups, newest first.
    function history(adminId) {
      return list(KEYS.history)
        .filter(function (h) { return h && h.adminId === adminId; })
        .sort(function (a, b) {
          if (a.date !== b.date) return a.date < b.date ? 1 : -1;
          return (b.createdAt || 0) - (a.createdAt || 0);
        });
    }

    function sameSet(a, b) {
      const x = (a || []).map(String).sort();
      const y = (b || []).map(String).sort();
      return x.length === y.length && x.every(function (d, i) { return d === y[i]; });
    }

    // duplicateHistory(entry) -> the saved writeup that is the same EVENT, or
    // null. A writeup is identified by admin + date + type + Reason + the set
    // of incident dates. A backfilled writeup has no incident dates, so when
    // either side has none the incident dates cannot tell them apart and
    // admin + date + type + Reason decides (a Workday backfill of a writeup
    // already saved from a draft is the same event). Two Notices the same day
    // for DIFFERENT incidents are two events and both save. A double click on
    // Save, or the same past writeup backfilled twice, must never count as two
    // Notices: that would move the next suggestion a step toward termination.
    function duplicateHistory(entry, exceptId) {
      const e = entry || {};
      const mine = Array.isArray(e.incidentDates) ? e.incidentDates : [];
      return list(KEYS.history).filter(function (h) {
        if (!h || h.adminId !== e.adminId || h.date !== e.date || h.docType !== e.docType) return false;
        if (exceptId && h.id === exceptId) return false;
        if (String(h.reason == null ? '' : h.reason) !== String(e.reason == null ? '' : e.reason)) return false;
        // A sick-pattern Documented Discussion and any other writeup are
        // never the same event (review round 1).
        if ((h.sickPattern === true) !== (e.sickPattern === true)) return false;
        // Both record their incident ids: the ids decide, never the dates.
        const myIds = Array.isArray(e.incidentIds) ? e.incidentIds : [];
        const theirIds = Array.isArray(h.incidentIds) ? h.incidentIds : [];
        if (myIds.length && theirIds.length) return sameSet(myIds, theirIds);
        const theirs = Array.isArray(h.incidentDates) ? h.incidentDates : [];
        if (!mine.length || !theirs.length) return true;
        return sameSet(mine, theirs);
      })[0] || null;
    }

    // addHistory(entry) -> the saved record, or null (unknown admin, no date
    // or type, a duplicate, or the write was refused).
    function addHistory(entry) {
      const e = entry || {};
      if (!e.adminId || !adminExists(e.adminId)) return null;
      if (!e.date || !e.docType) return null;
      if (duplicateHistory(e)) return null;
      const record = {
        id: newId('wu'),
        adminId: e.adminId,
        date: String(e.date),
        docType: String(e.docType),
        reason: String(e.reason == null ? '' : e.reason),
        incidentDates: Array.isArray(e.incidentDates) ? e.incidentDates.map(String) : [],
        source: e.source === 'drafted' ? 'drafted' : 'backfill',
        createdAt: now(),
      };
      // Review round 1: what the writeup covers, by id and kind, and the
      // sick-pattern tag. Stored only when given, so a backfill keeps its shape.
      if (Array.isArray(e.incidentIds) && e.incidentIds.length) {
        record.incidentIds = e.incidentIds.map(String);
        record.incidentKinds = Array.isArray(e.incidentKinds) ? e.incidentKinds.map(String) : [];
      }
      if (e.sickPattern === true) record.sickPattern = true;
      if (!write(KEYS.history, list(KEYS.history).concat([record]))) return null;
      bumpHistoryRev();
      return record;
    }

    function deleteHistory(id) {
      const current = list(KEYS.history);
      const next = current.filter(function (x) { return !x || x.id !== id; });
      if (next.length === current.length) return false;
      if (!write(KEYS.history, next)) return false;
      bumpHistoryRev();
      return true;
    }

    // ── Settings (#1116) ────────────────────────────────────────────────

    // The stored settings as one object (possibly sparse). An unreadable
    // record set reads as {} here; unreadable() still names it, the page says
    // so, and every write is refused.
    function storedSettings() {
      const out = {};
      list(KEYS.settings).forEach(function (x) {
        if (x && typeof x.key === 'string') out[x.key] = x.value;
      });
      return out;
    }

    // settings() -> the settings the page drafts with: every saved part that
    // passes lib/writeups.js's guards, the default for the rest.
    function settings() {
      const W = logicModule();
      return W ? W.normalizeSettings(storedSettings()) : storedSettings();
    }

    function settingsItems(clean) {
      return Object.keys(clean).map(function (k) { return { key: k, value: clean[k] }; });
    }

    // History records whose Reason is not in `reasons`, across every admin.
    function historyReasonsMissing(reasons) {
      const out = [];
      list(KEYS.history).forEach(function (h) {
        if (h && reasons.indexOf(h.reason) === -1 && out.indexOf(h.reason) === -1) out.push(h.reason);
      });
      return out;
    }

    // saveSettings(next) -> { ok, message, settings? }. Refuses, writing
    // nothing, anything checkSettings refuses, an unreadable device, and a
    // change that would drop a Reason a saved writeup still uses (the backup
    // would then refuse its own history).
    function saveSettings(next) {
      const W = logicModule();
      if (!W) return { ok: false, message: 'This page could not load the checks it needs to save Settings.' };
      if (settingsUnreadable()) {
        return { ok: false, message: 'The saved Settings on this device could not be read. Reset settings first. Nothing was changed.' };
      }
      if (unreadable().length) return { ok: false, message: 'Saved writeup data on this device could not be read. Nothing was changed.' };
      const problem = W.checkSettings(next);
      if (problem) return { ok: false, message: problem + ' Nothing was saved.' };
      const clean = W.normalizeSettings(next);
      const before = W.reasonsFor(settings());
      const lost = historyReasonsMissing(W.reasonsFor(clean)).filter(function (r) { return before.indexOf(r) !== -1; });
      if (lost.length) {
        return { ok: false, message: 'A writeup in history has the Reason "' + lost[0] + '". Delete it from history first. Nothing was saved.' };
      }
      if (!write(KEYS.settings, settingsItems(clean))) return { ok: false, message: 'This browser would not save the Settings.' };
      return { ok: true, message: '', settings: clean };
    }

    // resetSettings() -> true when written. The ONLY write that replaces an
    // unreadable record set, and only this one key: the page calls it after
    // Tyler confirms, and every other key is left exactly as it is. Settings
    // go back to the defaults.
    function resetSettings() {
      if (!storage) return false;
      try {
        storage.setItem(fullKey(KEYS.settings), JSON.stringify({ version: SCHEMA_VERSION, items: [] }));
        return true;
      } catch (e) {
        return false;
      }
    }

    // ── Export and import (#1097) ───────────────────────────────────────
    //
    // The backup file is the ONLY copy of this record that survives a cleared
    // browser, so both directions are strict.
    //
    //  * exportAll() refuses (null) while any record set is unreadable: a
    //    file built from "empty" would look like a real backup of nothing.
    //  * importAll() REPLACES this device's admins, incidents, history,
    //    selected admin and (from a format 2 file, #1116) settings (no merge).
    //    A format 1 file has no settings and leaves this device's alone. It refuses, writing nothing, on anything
    //    it cannot fully check, and on a device whose current data is
    //    unreadable. Every record passes the page's own validators
    //    (lib/writeups.js) so a file can never put in what the page could not.
    //  * The write is all-or-nothing: if any key fails to save, every key is
    //    put back to the exact bytes it held before.
    //
    // Device-local bookkeeping (when it was last exported, whether history has
    // changed since) lives in the ui record set and is NOT part of the file.

    function uiValue(key) {
      const rec = list(KEYS.ui).filter(function (x) { return x && x.key === key; })[0];
      return rec ? rec.value : undefined;
    }

    function setUiValues(values) {
      const names = Object.keys(values);
      const items = list(KEYS.ui).filter(function (x) { return !x || names.indexOf(x.key) === -1; });
      names.forEach(function (k) { items.push({ key: k, value: values[k] }); });
      return write(KEYS.ui, items);
    }

    // A saved or deleted writeup raises the "history changed since your last
    // export" nudge. A counter, not a timestamp, so an export in the same
    // millisecond as a save still compares correctly.
    function bumpHistoryRev() {
      return setUiValues({ historyRev: (Number(uiValue('historyRev')) || 0) + 1 });
    }

    // exportInfo() -> { lastExportedAt: ms | null, changedSinceExport }.
    // History saved before the counter existed has no historyRev, so history
    // that has NEVER been exported also counts as changed: otherwise the very
    // records most at risk (all of them, on a first backup) would never nudge.
    function exportInfo() {
      const last = Number(uiValue('lastExportedAt'));
      const lastExportedAt = last > 0 ? last : null;
      const raised = (Number(uiValue('historyRev')) || 0) > (Number(uiValue('exportedRev')) || 0);
      const neverExported = lastExportedAt === null && list(KEYS.history).length > 0;
      return { lastExportedAt: lastExportedAt, changedSinceExport: raised || neverExported };
    }

    // markExported() -> true when saved. Called by the page once the file has
    // been handed to the browser.
    function markExported() {
      return setUiValues({ lastExportedAt: now(), exportedRev: Number(uiValue('historyRev')) || 0 });
    }

    // exportAll() -> the one versioned backup object, or null when current
    // data is unreadable. Records are copied verbatim.
    function exportAll() {
      if (unreadable().length) return null;
      return JSON.parse(JSON.stringify(Object.assign({
        app: EXPORT_APP,
        formatVersion: EXPORT_FORMAT_VERSION,
        exportedAt: new Date(now()).toISOString(),
        admins: list(KEYS.admins),
        incidents: list(KEYS.incidents),
        history: list(KEYS.history),
        selectedAdminId: selectedAdminId(),
      }, settingsUnreadable() ? { settingsNote: SETTINGS_OMITTED_NOTE } : { settings: settings() })));
    }

    const REFUSED_TAIL = ' Nothing was imported and nothing was changed.';
    // `problem` is the bare sentence (no "nothing was changed" tail), kept for
    // verifyExport, which words the same finding for a file that was written.
    function refuse(message) { return { ok: false, problem: message, message: message + REFUSED_TAIL }; }

    // Local YYYY-MM-DD of a moment, the same day Tyler's calendar shows.
    function localIso(d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    // The shape exportAll writes (Date.toISOString). Date.parse alone also
    // takes "10/31/2026" and "Oct 31 2026", which no export ever contains.
    const EXPORTED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

    function logicModule() {
      if (o.logic) return o.logic;
      if (typeof globalThis !== 'undefined' && globalThis.Writeups) return globalThis.Writeups;
      if (typeof module !== 'undefined' && typeof require === 'function') {
        try { return require('./writeups'); } catch (e) { return null; }
      }
      return null;
    }

    function isObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
    function isNonEmptyString(x) { return typeof x === 'string' && x.trim() !== ''; }
    function isNumber(x) { return typeof x === 'number' && isFinite(x); }

    // An in-memory read-only storage shaped like localStorage, so the store's
    // OWN duplicate checks can judge a file before anything touches the device.
    function scratchStore(admins, incidents, history) {
      const data = {};
      data[fullKey(KEYS.admins)] = JSON.stringify({ version: SCHEMA_VERSION, items: admins });
      data[fullKey(KEYS.incidents)] = JSON.stringify({ version: SCHEMA_VERSION, items: incidents });
      data[fullKey(KEYS.history)] = JSON.stringify({ version: SCHEMA_VERSION, items: history });
      return createStore({
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
        setItem: function () { throw new Error('read-only scratch'); },
      }, o);
    }

    // checkImport(input) -> { ok:false, message } or { ok:true, file, counts, exportedAt }.
    // Never writes. `input` is the file's text or an already-parsed object.
    function checkImport(input) {
      const W = logicModule();
      if (!W) return refuse('This page could not load the checks it needs to read a backup.');
      if (unreadable().length) {
        return { ok: false, message: 'Saved writeup data on this device could not be read, so the backup was not imported. Existing data was left exactly as it is. Nothing was imported and nothing was changed.' };
      }
      let file = input;
      if (typeof input === 'string') {
        try { file = JSON.parse(input); } catch (e) { return refuse('That file is not readable JSON.'); }
      }
      if (!isObject(file) || file.app !== EXPORT_APP) {
        return refuse('That file is not a Writeups backup.');
      }
      if (typeof file.formatVersion !== 'number' || !isFinite(file.formatVersion) || file.formatVersion !== Math.floor(file.formatVersion) || file.formatVersion < 1) {
        return refuse('That backup has no usable version number.');
      }
      if (file.formatVersion > EXPORT_FORMAT_VERSION) {
        return refuse('That backup was made by a newer version of the Writeups page (format ' + file.formatVersion + '). Update this page first.');
      }
      if (IMPORTABLE_FORMATS.indexOf(file.formatVersion) === -1) {
        return refuse('That backup has an unknown version (format ' + file.formatVersion + ').');
      }
      // Format 2 carries Settings, checked by the same guards a save runs. A
      // format 1 file has none and leaves this device's settings alone.
      // A format 2 file made while this device's Settings were unreadable has
      // none, and says so in settingsNote (#1119): it imports like format 1.
      const settingsOmitted = file.formatVersion >= 2 && file.settings === undefined && typeof file.settingsNote === 'string';
      const hasSettings = file.formatVersion >= 2 && !settingsOmitted;
      if (hasSettings) {
        if (!isObject(file.settings)) return refuse('That backup is missing its settings.');
        const why = W.checkSettings(file.settings);
        if (why) return refuse('That backup has settings this page cannot use: ' + why);
      }
      const fileSettings = hasSettings ? W.normalizeSettings(file.settings) : W.defaultSettings();
      if (settingsOmitted && Array.isArray(file.history)) {
        // The extra Reasons went with the unreadable Settings. A history
        // Reason is still accepted when it passes the Reason guard, so the
        // file that rescues the history can be restored.
        file.history.forEach(function (h) {
          if (!h || typeof h.reason !== 'string') return;
          if (W.reasonsFor(fileSettings).indexOf(h.reason) !== -1) return;
          if (!W.extraReasonProblem(h.reason, fileSettings.extraReasons, fileSettings)) fileSettings.extraReasons.push(h.reason);
        });
      }
      if (typeof file.exportedAt !== 'string' || !EXPORTED_AT_RE.test(file.exportedAt) || isNaN(Date.parse(file.exportedAt))) {
        return refuse('That backup has no valid export date.');
      }
      if (typeof file.selectedAdminId !== 'string') {
        return refuse('That backup has no valid selected admin entry.');
      }
      const lists = ['admins', 'incidents', 'history'];
      for (let s = 0; s < lists.length; s++) {
        if (!Array.isArray(file[lists[s]])) return refuse('That backup is missing its ' + lists[s] + ' list.');
      }

      // Admins.
      // Sets, never plain objects: an id like "constructor" or "toString" is a
      // truthy property of {} and would read as already seen (or as a known
      // admin) when the file never mentioned it.
      const adminIds = new Set();
      const adminNameOf = new Map();
      const adminNames = new Set();
      for (let i = 0; i < file.admins.length; i++) {
        const a = file.admins[i];
        const at = 'Admin ' + (i + 1) + ' in the backup';
        if (!isObject(a) || !isNonEmptyString(a.id) || !isNonEmptyString(a.name)) return refuse(at + ' has no id or name.');
        if (adminIds.has(a.id)) return refuse(at + ' repeats an admin id.');
        if (Object.prototype.hasOwnProperty.call(a, 'workDays') && !validWorkDays(a.workDays)) {
          return refuse(at + ' has a work schedule that is not a list of days, Sunday to Saturday.');
        }
        const lower = cleanName(a.name).toLowerCase();
        if (adminNames.has(lower)) return refuse(at + ' repeats an admin name.');
        adminIds.add(a.id);
        adminNames.add(lower);
        adminNameOf.set(a.id, cleanName(a.name));
      }
      // "Incident 3 in the backup (Sam Example, 2026-10-01)": names the record.
      function labelOf(noun, i, rec) {
        const who = adminNameOf.get(rec && rec.adminId);
        const when = rec && typeof rec.date === 'string' ? rec.date : '';
        const bits = [who, when].filter(Boolean);
        return noun + ' ' + (i + 1) + ' in the backup' + (bits.length ? ' (' + bits.join(', ') + ')' : '');
      }

      // Incidents.
      const incidentIds = new Set();
      for (let i = 0; i < file.incidents.length; i++) {
        const inc = file.incidents[i];
        const at = labelOf('Incident', i, inc);
        if (!isObject(inc) || !isNonEmptyString(inc.id)) return refuse(at + ' has no id.');
        if (incidentIds.has(inc.id)) return refuse(at + ' repeats an incident id.');
        incidentIds.add(inc.id);
        if (!adminIds.has(inc.adminId)) return refuse(at + ' belongs to an admin that is not in the backup.');
        if (!isNumber(inc.createdAt)) return refuse(at + ' has no saved time.');
        const problem = W.validateIncident(inc);
        if (problem) return refuse(at + ' is not valid: ' + problem);
        if (inc.protectedSick !== undefined && typeof inc.protectedSick !== 'boolean') return refuse(at + ' has an unreadable Protected Sick Time flag.');
        if (inc.clockOutNextDay !== undefined && typeof inc.clockOutNextDay !== 'boolean') return refuse(at + ' has an unreadable after-midnight flag.');
      }

      // Writeup history.
      // A writeup cannot be dated after today, nor after the day the backup
      // was made (a date after either is a typo or a hand-edited file). Both
      // are local calendar days; the earlier one is the limit. The real clock,
      // not the store's injected one: "after today" means today.
      const latest = [localIso(new Date()), localIso(new Date(Date.parse(file.exportedAt)))].sort()[0];
      const historyIds = new Set();
      for (let i = 0; i < file.history.length; i++) {
        const h = file.history[i];
        const at = labelOf('History record', i, h);
        if (!isObject(h) || !isNonEmptyString(h.id)) return refuse(at + ' has no id.');
        if (historyIds.has(h.id)) return refuse(at + ' repeats a history id.');
        historyIds.add(h.id);
        if (!adminIds.has(h.adminId)) return refuse(at + ' belongs to an admin that is not in the backup.');
        if (!isNumber(h.createdAt)) return refuse(at + ' has no saved time.');
        const problem = W.validateHistoryEntry(h, '', fileSettings);
        if (problem) return refuse(at + ' is not valid: ' + problem);
        if (h.date > latest) return refuse(at + ' is dated after today or after the day the backup was made.');
        if (h.source !== 'drafted' && h.source !== 'backfill') return refuse(at + ' has an unknown source.');
        if (!Array.isArray(h.incidentDates) || !h.incidentDates.every(function (d) { return typeof d === 'string' && W.isIsoDate(d); })) {
          return refuse(at + ' has unreadable incident dates.');
        }
        const hasIds = h.incidentIds !== undefined;
        const hasKinds = h.incidentKinds !== undefined;
        if (hasIds !== hasKinds) return refuse(at + ' lists incident ids without kinds, or kinds without ids.');
        if (hasIds) {
          const strings = function (x) { return Array.isArray(x) && x.every(isNonEmptyString); };
          if (!strings(h.incidentIds) || !strings(h.incidentKinds) || h.incidentIds.length !== h.incidentKinds.length) {
            return refuse(at + ' has incident ids and kinds that do not match.');
          }
        }
        if (h.sickPattern !== undefined && h.sickPattern !== true) return refuse(at + ' has an unreadable sick-pattern tag.');
      }

      // The store's own one-per-day and same-event rules, applied to the file.
      // One scratch store for the whole file: each record is checked against
      // the rest of the file by id, so the file is serialised once, not once
      // per history entry.
      const scratch = scratchStore(file.admins, file.incidents, file.history);
      for (let i = 0; i < file.incidents.length; i++) {
        const other = scratch.duplicateOnDay(file.incidents[i]);
        if (other) {
          return refuse('The backup has two incidents for ' + adminNameOf.get(file.incidents[i].adminId) + ' on the same day (' +
            file.incidents[i].date + ': ' + file.incidents[i].kind + ' and ' + other.kind + '), which would count that day twice.');
        }
      }
      for (let i = 0; i < file.history.length; i++) {
        if (scratch.duplicateHistory(file.history[i], file.history[i].id)) {
          return refuse('The backup has the same writeup in history twice (' + adminNameOf.get(file.history[i].adminId) + ', ' +
            file.history[i].date + '), which would count as two Notices.');
        }
      }

      return {
        ok: true,
        file: file,
        settings: hasSettings ? fileSettings : null,
        counts: { admins: file.admins.length, incidents: file.incidents.length, history: file.history.length },
        exportedAt: file.exportedAt,
      };
    }

    // verifyExport(data) -> { ok:true } or { ok:false, message }. Runs the
    // import check on a file exportAll just built, so a backup that would be
    // refused on import is found while it can still be fixed, not on the day
    // it is needed. Writes nothing.
    function verifyExport(data) {
      const r = checkImport(JSON.parse(JSON.stringify(data)));
      if (r.ok) return { ok: true };
      return {
        ok: false,
        message: 'This file would be refused if you imported it. ' + (r.problem || r.message) +
          ' Fix or delete that record on this page, then export again.',
      };
    }

    // inspectImport(input) -> { ok, message?, counts?, exportedAt? }. What the
    // page shows Tyler before he confirms. Writes nothing.
    function inspectImport(input) {
      const r = checkImport(input);
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, counts: r.counts, exportedAt: r.exportedAt };
    }

    // importAll(input) -> { ok, message, counts? }. Replaces this device's
    // writeups data with the file's, all or nothing.
    function importAll(input) {
      const r = checkImport(input);
      if (!r.ok) return { ok: false, message: r.message };
      if (!storage) return refuse('This browser has no storage to import into.');
      const file = r.file;
      const hasSelected = file.admins.some(function (a) { return a.id === file.selectedAdminId; });
      const next = {};
      next[KEYS.admins] = file.admins;
      next[KEYS.incidents] = file.incidents;
      next[KEYS.history] = file.history;
      next[KEYS.ui] = [
        { key: 'selectedAdminId', value: hasSelected ? file.selectedAdminId : '' },
        { key: 'lastExportedAt', value: Date.parse(file.exportedAt) },
      ];
      if (r.settings) {
        // Never over unreadable Settings without Tyler's say-so (#1119).
        if (settingsUnreadable()) {
          return refuse('The saved Settings on this device could not be read. Reset settings first, then import.');
        }
        next[KEYS.settings] = settingsItems(r.settings);
      }
      const names = Object.keys(next);
      const prior = {};
      try {
        names.forEach(function (n) { prior[n] = storage.getItem(fullKey(n)); });
      } catch (e) {
        return refuse('This browser would not let the page read its saved data.');
      }
      const touched = [];
      try {
        names.forEach(function (n) {
          touched.push(n);
          storage.setItem(fullKey(n), JSON.stringify({ version: SCHEMA_VERSION, items: next[n] }));
        });
      } catch (e) {
        // Only getItem/setItem, the storage contract this store documents. A
        // key that held nothing goes back as an EMPTY record set, which the
        // store reads exactly like an absent key; every other key goes back
        // to its exact prior bytes.
        let restored = true;
        touched.forEach(function (n) {
          try {
            storage.setItem(fullKey(n), prior[n] == null
              ? JSON.stringify({ version: SCHEMA_VERSION, items: [] })
              : prior[n]);
          } catch (e2) { restored = false; }
        });
        return {
          ok: false,
          message: restored
            ? 'This browser would not save the imported data. Nothing was imported and nothing was changed.'
            : 'This browser would not save the imported data, and the saved data may now be incomplete. Reload the page and check the admins and history before trusting it.',
        };
      }
      return {
        ok: true,
        message: 'Imported ' + r.counts.admins + ' admins, ' + r.counts.incidents + ' incidents and ' + r.counts.history + ' history entries.',
        counts: r.counts,
      };
    }

    // The last-picked admin, so a reload opens where Tyler left off.
    function selectedAdminId() {
      const items = list(KEYS.ui);
      const rec = items.filter(function (x) { return x && x.key === 'selectedAdminId'; })[0];
      return rec ? rec.value : '';
    }

    function setSelectedAdminId(id) {
      const items = list(KEYS.ui).filter(function (x) { return x && x.key !== 'selectedAdminId'; });
      items.push({ key: 'selectedAdminId', value: String(id || '') });
      return write(KEYS.ui, items);
    }

    return {
      admins: admins,
      unreadable: unreadable,
      duplicateLate: duplicateLate,
      duplicateOnDay: duplicateOnDay,
      addAdmin: addAdmin,
      setAdminWorkDays: setAdminWorkDays,
      seedAdmins: seedAdmins,
      incidents: incidents,
      saveIncident: saveIncident,
      deleteIncident: deleteIncident,
      history: history,
      duplicateHistory: duplicateHistory,
      addHistory: addHistory,
      deleteHistory: deleteHistory,
      selectedAdminId: selectedAdminId,
      setSelectedAdminId: setSelectedAdminId,
      exportAll: exportAll,
      inspectImport: inspectImport,
      importAll: importAll,
      exportInfo: exportInfo,
      markExported: markExported,
      verifyExport: verifyExport,
      settings: settings,
      saveSettings: saveSettings,
      settingsUnreadable: settingsUnreadable,
      resetSettings: resetSettings,
    };
  }

  return {
    NAMESPACE: NAMESPACE,
    SCHEMA_VERSION: SCHEMA_VERSION,
    KEYS: KEYS,
    EXPORT_APP: EXPORT_APP,
    EXPORT_FORMAT_VERSION: EXPORT_FORMAT_VERSION,
    SETTINGS_OMITTED_NOTE: SETTINGS_OMITTED_NOTE,
    IMPORTABLE_FORMATS: IMPORTABLE_FORMATS,
    createStore: createStore,
  };
});
