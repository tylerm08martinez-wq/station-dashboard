'use strict';

// The FedEx "Time Off / Submitted Requests Detail" report: rows in (from
// SpreadsheetLib.readSpreadsheet, any format), time off per person per date out.
// Pure logic, no storage, no DOM.
//
// Dual-loadable with no build step:
// - Browser: window.TimeOffReport
// - Node:    require('./lib/time-off-report')   (for tests)
//
// The report (verified against the 2026-11-05 export, see notes/report-registry.md):
// a preamble (title, "Time Period: ...", "Run Date: ..."), then a header row
// EMPLID, NAME, CO, REG, DIST, LOC, JOB FAMILY, REPORTS TO, SORT,
// SUBMISSION DTM, REQ DATE, PAYCODE, ENTRY METHOD / STATUS, DAILY HOURS,
// then one row per person per requested date. The header is found by its
// column names, never by position.
//
// parse(rows) -> { ok: true, runDate, period, rows: Row[], unknownStatuses }
//              | { ok: false, error }
//   Row = { employeeId, name, reportsTo, date: 'YYYY-MM-DD', payCode, status,
//           kind: 'approved' | 'asked', hours }
//   A REQ DATE that is not a real MM/DD/YYYY date, or a data row with no
//   EMPLID, fails the whole parse naming the row. Never a silently skipped row.
// forManager(rows, managerId) -> rows whose REPORTS TO is that ID.
// people(rows) -> [{ employeeId, name }], distinct, file order, first name only.
// dayIndex(rows) -> { [employeeId]: { [date]: { kind, label, payCodes, hours } } }
//   One entry per person per date. Approved beats asked. Only the winning
//   kind's pay codes count. label is 'VAC' when any of them is vacation, else
//   'OFF', so a sick day never shows as anything but OFF.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TimeOffReport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const REPORT_NAME = 'Time Off / Submitted Requests Detail';

  const COLUMNS = {
    employeeId: 'EMPLID',
    name: 'NAME',
    reportsTo: 'REPORTS TO',
    date: 'REQ DATE',
    payCode: 'PAYCODE',
    status: 'ENTRY METHOD / STATUS',
    hours: 'DAILY HOURS',
  };

  const APPROVED = ['REQ_APPROVED', 'MGR_CREATED', 'TIMECARD_ENTRY'];
  const ASKED = ['REQ_SUBMITTED'];

  function cell(v) {
    return v == null ? '' : String(v).trim();
  }

  function norm(h) {
    return cell(h).replace(/\s+/g, ' ').toUpperCase();
  }

  // The export decorates cells: "Vacation-NE_", "Vacation-NE_ | SUBMITTED",
  // and a text dump showed "REQ_APPROVED~". Keep the code itself.
  function cleanCode(v) {
    return cell(v).replace(/\s*\|.*$/, '').replace(/[~_]+$/, '').trim();
  }

  function findHeader(rows) {
    const wanted = Object.keys(COLUMNS).map(function (k) { return COLUMNS[k]; });
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || [];
      const names = r.map(norm);
      if (wanted.every(function (w) { return names.indexOf(w) !== -1; })) {
        const at = {};
        Object.keys(COLUMNS).forEach(function (k) { at[k] = names.indexOf(COLUMNS[k]); });
        return { index: i, at: at };
      }
    }
    return null;
  }

  function preambleValue(rows, upTo, label) {
    const re = new RegExp('^' + label + '\\s*:\\s*', 'i');
    for (let i = 0; i < upTo; i++) {
      const r = rows[i] || [];
      for (let c = 0; c < r.length; c++) {
        const v = cell(r[c]);
        if (v === '') continue;
        if (re.test(v)) return v.replace(re, '').trim();
        break; // only the first non-empty cell of a preamble row carries a label
      }
    }
    return '';
  }

  function daysInMonth(y, m) {
    return [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  }

  // 'MM/DD/YYYY' (one-digit month or day allowed) -> 'YYYY-MM-DD', or null.
  // String work only: no Date, so the result never depends on a time zone.
  function toIsoDate(v) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(cell(v));
    if (!m) return null;
    const mo = Number(m[1]), d = Number(m[2]), y = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
    return m[3] + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function notThisReport() {
    return {
      ok: false,
      error: 'This is not the ' + REPORT_NAME + ' report. Expected a header row with EMPLID, NAME, REPORTS TO, REQ DATE, PAYCODE, ENTRY METHOD / STATUS and DAILY HOURS.',
    };
  }

  function parse(rows) {
    if (!Array.isArray(rows)) return notThisReport();
    const header = findHeader(rows);
    if (!header) return notThisReport();
    const at = header.at;
    const out = [];
    const unknown = [];
    for (let i = header.index + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (!r.some(function (v) { return cell(v) !== ''; })) continue;
      const rowNo = i + 1;
      const employeeId = cell(r[at.employeeId]);
      const rawDate = cell(r[at.date]);
      if (employeeId === '') {
        return { ok: false, error: 'Row ' + rowNo + ' of the ' + REPORT_NAME + ' report has no EMPLID. Nothing was loaded.' };
      }
      const date = toIsoDate(rawDate);
      if (!date) {
        return { ok: false, error: 'Row ' + rowNo + ' of the ' + REPORT_NAME + ' report has REQ DATE "' + rawDate + '", expected MM/DD/YYYY. Nothing was loaded.' };
      }
      const status = cleanCode(r[at.status]);
      const approved = APPROVED.indexOf(status) !== -1;
      if (!approved && ASKED.indexOf(status) === -1 && unknown.indexOf(status) === -1) unknown.push(status);
      out.push({
        employeeId: employeeId,
        name: cell(r[at.name]),
        reportsTo: cell(r[at.reportsTo]),
        date: date,
        payCode: cleanCode(r[at.payCode]),
        status: status,
        kind: approved ? 'approved' : 'asked',
        hours: cell(r[at.hours]),
      });
    }
    return {
      ok: true,
      runDate: preambleValue(rows, header.index, 'Run Date'),
      period: preambleValue(rows, header.index, 'Time Period'),
      rows: out,
      unknownStatuses: unknown,
    };
  }

  function forManager(rows, managerId) {
    const id = cell(managerId);
    if (id === '') return [];
    return (rows || []).filter(function (r) { return r.reportsTo === id; });
  }

  // "Last, First M" -> "First". A name with no comma gives its first word.
  function firstName(full) {
    const s = cell(full);
    const comma = s.indexOf(',');
    const rest = comma === -1 ? s : s.slice(comma + 1).trim();
    return rest.split(/\s+/)[0] || s;
  }

  function people(rows) {
    const seen = {};
    const out = [];
    (rows || []).forEach(function (r) {
      if (Object.prototype.hasOwnProperty.call(seen, r.employeeId)) return;
      seen[r.employeeId] = true;
      out.push({ employeeId: r.employeeId, name: firstName(r.name) });
    });
    return out;
  }

  function isVacation(payCode) {
    return /^vacation\b/i.test(payCode);
  }

  // Hours of the winning rows added up when every one is a number, else the
  // first row's hours as written.
  function sumHours(list) {
    if (list.length === 1) return list[0];
    if (list.every(function (h) { return /^\d+(\.\d+)?$/.test(h); })) {
      return String(list.reduce(function (a, h) { return a + Number(h); }, 0));
    }
    return list[0];
  }

  // Rows with the same pay code are the same request exported twice, so the
  // largest of their hours counts once. Different pay codes add up.
  function dayHours(winners, payCodes) {
    return sumHours(payCodes.map(function (code) {
      const same = winners.filter(function (r) { return r.payCode === code; }).map(function (r) { return r.hours; });
      if (same.every(function (h) { return /^\d+(\.\d+)?$/.test(h); })) {
        return String(Math.max.apply(null, same.map(Number)));
      }
      return same[0];
    }));
  }

  function dayIndex(rows) {
    const groups = Object.create(null);
    (rows || []).forEach(function (r) {
      const person = groups[r.employeeId] || (groups[r.employeeId] = Object.create(null));
      (person[r.date] || (person[r.date] = [])).push(r);
    });
    const out = {};
    Object.keys(groups).forEach(function (id) {
      out[id] = {};
      Object.keys(groups[id]).forEach(function (date) {
        const all = groups[id][date];
        const kind = all.some(function (r) { return r.kind === 'approved'; }) ? 'approved' : 'asked';
        const winners = all.filter(function (r) { return r.kind === kind; });
        const payCodes = [];
        winners.forEach(function (r) { if (payCodes.indexOf(r.payCode) === -1) payCodes.push(r.payCode); });
        out[id][date] = {
          kind: kind,
          label: payCodes.some(isVacation) ? 'VAC' : 'OFF',
          payCodes: payCodes,
          hours: dayHours(winners, payCodes),
        };
      });
    });
    return out;
  }

  return {
    REPORT_NAME: REPORT_NAME,
    APPROVED_STATUSES: APPROVED.slice(),
    parse: parse,
    forManager: forManager,
    people: people,
    dayIndex: dayIndex,
    _internals: { cleanCode: cleanCode, toIsoDate: toIsoDate, firstName: firstName },
  };
});
