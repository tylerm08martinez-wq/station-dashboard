'use strict';

// Coverage reconciliation against today's Floor Absences (ADR-0008).
//
// Pure: no DOM, no localStorage. Given who is assigned to each QA Area today and
// who is Floor-Absent, re-derive coverage so an area whose every present assignee
// is gone reads UNCOVERED — instead of staying "covered" off the stale weekly
// plan. The discipline tally is never consulted here; the caller passes a
// Floor-Absence name list (TimeOff.isFloorAbsence), which is a presence predicate,
// not `countsTowardTally` (a Late is present and never reduces coverage).
//
// This module builds ON ToolHelpers.deriveCoverage rather than re-implementing the
// covered/uncovered/cannotSkip loop — single-sourcing the coverage rule so the
// hub can never disagree with itself on what "uncovered" means.
//
// Dual-loadable with no build step:
// - Browser: window.CoverageReconcile (depends on window.ToolHelpers)
// - Node: require('./lib/coverage-reconcile')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CoverageReconcile = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const ToolHelpers = (typeof require === 'function')
    ? require('./tool-helpers')
    : (root && root.ToolHelpers);

  // Normalized identity for matching a Time-Off `employee` to a schedule name:
  // trim + lowercase. Deliberately NOT fuzzy first-name — two admins sharing a
  // first name must never collapse onto each other and open the wrong cage.
  function normName(name) {
    return String(name == null ? '' : name).trim().toLowerCase();
  }

  // reconcileCoverage(assigneesByArea, sortAreas, absentNames, requiredBodies = 1)
  //
  //   assigneesByArea : { areaCode: [employeeName, …] } for the day
  //   sortAreas       : canonical area set (defaults to ToolHelpers.SORT_AREAS)
  //   absentNames     : names Floor-Absent today
  //   requiredBodies  : present assignees an area needs to stay covered (seam for
  //                     future per-area/per-day minimums; today fixed at 1)
  //
  // Returns the deriveCoverage shape { covered, uncovered, cannotSkip } PLUS:
  //   emptiedBy : { areaCode: [names] } — areas that went uncovered *because* their
  //               assignees were Floor-Absent (the "an admin called off" cause)
  //   noMap     : [names] — Floor-Absent admins who matched no assignee today
  //               (a typo, or off-schedule). Surfaced loud by the caller, never
  //               silently dropped.
  function reconcileCoverage(assigneesByArea, sortAreas, absentNames, requiredBodies) {
    const byArea = (assigneesByArea && typeof assigneesByArea === 'object') ? assigneesByArea : {};
    const req = Number(requiredBodies) > 0 ? Number(requiredBodies) : 1;

    const absent = {};
    (Array.isArray(absentNames) ? absentNames : []).forEach(function (n) {
      absent[normName(n)] = true;
    });

    const matched = {};        // normalized absent names that hit some assignee
    const reducedAssigned = []; // areas still meeting requiredBodies
    const emptiedBy = {};       // areas newly emptied by a Floor Absence

    Object.keys(byArea).forEach(function (area) {
      const assignees = Array.isArray(byArea[area]) ? byArea[area] : [];
      const present = [];
      const removed = [];
      assignees.forEach(function (name) {
        if (absent[normName(name)]) {
          removed.push(name);
          matched[normName(name)] = true;
        } else {
          present.push(name);
        }
      });
      if (present.length >= req) {
        reducedAssigned.push(area);
      } else if (removed.length > 0) {
        emptiedBy[area] = removed;
      }
    });

    const coverage = ToolHelpers.deriveCoverage(reducedAssigned, sortAreas);

    const noMap = [];
    const seen = {};
    (Array.isArray(absentNames) ? absentNames : []).forEach(function (n) {
      const key = normName(n);
      if (matched[key] || seen[key] || key === '') return;
      seen[key] = true;
      noMap.push(n);
    });

    return {
      covered: coverage.covered,
      uncovered: coverage.uncovered,
      cannotSkip: coverage.cannotSkip,
      emptiedBy: emptiedBy,
      noMap: noMap,
    };
  }

  return {
    reconcileCoverage: reconcileCoverage,
    normName: normName,
  };
});
