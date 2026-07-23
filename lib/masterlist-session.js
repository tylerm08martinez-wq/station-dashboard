'use strict';

// MasterList builder session — the DOM-free composition behind
// masterlist-builder.html.
//
// lib/masterlist.js already owns the record-shaping primitives (parse the
// Manual Assignment Detail export, dedupe, detect days, analyze, build the
// TSV/artifact). This module composes those primitives the way the page does
// on import and on export, so that composition — which day is defaulted, how
// filter+dedupe+analyze chain into the downloadable artifact — is reachable
// from unit tests and a real-data verify instead of only the page's DOM.
//
// No DOM, no localStorage, no network: the page passes state in and owns the
// side effects (persisting, rendering, downloading).
//
// Dual-loadable with no build step:
// - Browser: window.MasterlistSession  (parseCSV + MasterlistLib on root)
// - Node: require('./lib/masterlist-session')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MasterlistSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function deps() {
    const parseCSV = (root && root.parseCSV) ||
      (typeof require === 'function' ? require('./csv').parseCSV : null);
    const ML = (root && root.MasterlistLib) ||
      (typeof require === 'function' ? require('./masterlist') : null);
    if (typeof parseCSV !== 'function' || !ML) {
      throw new Error('MasterlistSession dependencies unavailable (need parseCSV + MasterlistLib)');
    }
    return { parseCSV: parseCSV, ML: ML };
  }

  // loadReport(csvText) -> { assignments, days, day }
  // Parse a Manual Assignment Detail export into typed assignment rows, list
  // the days it spans (most-recent first), and pick the default selected day
  // (the most recent, or 'ALL' when the file carries no dated rows). Pure.
  function loadReport(csvText) {
    const d = deps();
    return loadReportRows(d.parseCSV(csvText == null ? '' : String(csvText)));
  }

  // loadReportRows(rows) — the parse-free core of loadReport. Accepts rows in
  // parseCSV shape so a caller that read an .xlsx/.xls through
  // SpreadsheetLib.readSpreadsheet can feed them in directly (#321).
  function loadReportRows(rows) {
    const d = deps();
    rows = Array.isArray(rows) ? rows : [];
    const assignments = d.ML.parseAssignmentRows(rows);
    const days = d.ML.detectDays(assignments);
    return {
      assignments: assignments,
      days: days,
      day: days.length ? days[0] : 'ALL',
    };
  }

  // viewForDay(assignments, day) -> { kept, removedCount }
  // The deduped view for one day; 'ALL' pools the whole file. Pure.
  function viewForDay(assignments, day) {
    const d = deps();
    const list = Array.isArray(assignments) ? assignments : [];
    const filtered = (day === 'ALL' || day == null)
      ? list
      : list.filter(function (a) { return a && a.scanDate === day; });
    return d.ML.dedupeAssignments(filtered);
  }

  // fileWorkAreaSet(assignments) -> { workArea: true, ... }
  // Every non-empty WORK AREA across the WHOLE file — reroutes resolve file-wide
  // (#66), not per selected day. Pure.
  function fileWorkAreaSet(assignments) {
    const set = Object.create(null);
    (Array.isArray(assignments) ? assignments : []).forEach(function (a) {
      if (a && a.workArea) set[a.workArea] = true;
    });
    return set;
  }

  // buildArtifact(assignments, day, entries, patterns, dateStr) -> markdown text
  // The downloadable MasterList artifact for the selected day: the deduped view
  // merged with the hand-typed entries, analyzed, and rendered. Mirrors the
  // page's Download Artifact exactly — analyze the MERGED rows with no separate
  // reroute set (the merged file is the universe here). Pure.
  function buildArtifact(assignments, day, entries, patterns, dateStr) {
    const d = deps();
    const view = viewForDay(assignments, day);
    const manual = (Array.isArray(entries) ? entries : []).map(d.ML.manualEntryToAssignment);
    const merged = view.kept.concat(manual);
    const analysis = d.ML.analyzeAssignments(merged);
    return d.ML.buildMasterlistArtifact(analysis, dateStr, patterns);
  }

  return {
    loadReport: loadReport,
    loadReportRows: loadReportRows,
    viewForDay: viewForDay,
    fileWorkAreaSet: fileWorkAreaSet,
    buildArtifact: buildArtifact,
  };
});
