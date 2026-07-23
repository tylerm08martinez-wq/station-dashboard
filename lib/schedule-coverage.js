'use strict';

// Coverage presentation for the Schedule Viewer (PRD #231). Turns one day's
// analyzeWeek finding (lib/schedule-analysis.js) into the lines the in-tab
// Coverage panel renders, each citing the scheduling/principles.md rule behind
// it. Pure — no DOM. Judgment stays in principles.md; this only presents the
// mechanical findings.
//
// Tracer slice (#232): cannot-skip (Cage A uncovered) only. Later slices widen
// summarize() to uncovered / fragile / headcount and add statusByArea() for the
// coverage strip.
//
// Dual-loadable, no build step (same pattern as lib/schedule-analysis.js):
//   - Browser: window.ScheduleCoverage
//   - Node:    require('./lib/schedule-coverage')

(function (root, factory) {
  let helpers = root && root.ToolHelpers ? root.ToolHelpers : null;
  if (!helpers && typeof require !== 'undefined') {
    try { helpers = require('./tool-helpers'); } catch (e) { helpers = null; }
  }
  const api = factory(helpers);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ScheduleCoverage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (helpers) {
  // Canonical sort areas, single-sourced from tool-helpers (never redefined).
  const SORT_AREAS = (helpers && helpers.SORT_AREAS) ? helpers.SORT_AREAS : ['A', 'B', 'C', 'ME', 'DMG'];

  // Finding type → scheduling/principles.md rule number. The map is the contract
  // between the tab and principles.md; tests/schedule-coverage.test.js asserts
  // each cited rule still exists so a renumber can't make the panel cite the
  // wrong rule.
  //
  // Only findings that map to a named judgment are cited:
  //   cannotSkip    → rule 1 (Cage A cannot be uncovered)
  //   headcount     → rule 3 (counts/temps)
  //   damagesNoSolo → rule 4 (Damages needs a Solo-capable runner)
  // `uncovered` (an ordinary unstaffed sort area) and `fragile` (Cage A covered
  // by exactly one person — a single point of failure) are mechanical
  // observations with no clean principle, so they render WITHOUT a rule pill
  // (principle: null); fragile is heatmap-only besides.
  const CITATIONS = { cannotSkip: 1, headcount: 3, damagesNoSolo: 4 };

  const AREA_NAME = { A: 'Cage A', B: 'Cage B', C: 'Cage C', ME: 'Middle Earth', DMG: 'Damages' };
  function areaLabel(code) {
    const key = String(code == null ? '' : code).trim().toUpperCase();
    return AREA_NAME[key] || key;
  }
  function areaList(finding, key) {
    return Array.isArray(finding[key]) ? finding[key] : [];
  }

  // summarize(dayFinding) → [{ type, area, message, principle }] panel lines,
  // ordered most-severe first: cannot-skip → uncovered → damagesNoSolo →
  // headcount. `fragile` is intentionally excluded (heatmap-only — see below).
  // `principle` is null when the finding has no cited rule.
  function summarize(dayFinding) {
    const out = [];
    if (!dayFinding) return out;
    areaList(dayFinding, 'cannotSkip').forEach(function (area) {
      out.push({ type: 'cannotSkip', area: area, message: areaLabel(area) + ' UNCOVERED — cannot-skip', principle: CITATIONS.cannotSkip });
    });
    areaList(dayFinding, 'uncovered').forEach(function (area) {
      out.push({ type: 'uncovered', area: area, message: areaLabel(area) + ' uncovered', principle: null });
    });
    // `fragile` (Cage A covered by one person) is deliberately NOT a panel line:
    // on a small roster A is single-person most days, so a daily nag would be
    // noise. It stays a heatmap-only signal (yellow cell via statusByArea) —
    // glanceable "thin here" without the reminder. (Tyler, 2026-06-11)
    // Rule 4: Damages staffed but by nobody Solo-capable (#242). Cited, panel
    // line only — the heatmap still reads "covered" since DMG is staffed.
    const noSolo = areaList(dayFinding, 'damagesNoSolo');
    if (noSolo.length) {
      out.push({ type: 'damagesNoSolo', area: 'DMG', message: 'Damages held without a solo-capable runner (' + noSolo.join(', ') + ')', principle: CITATIONS.damagesNoSolo });
    }
    const hc = dayFinding.headcount;
    if (hc && hc.mismatch) {
      out.push({ type: 'headcount', area: null, message: hc.assigned + ' assigned vs QA count ' + hc.expected, principle: CITATIONS.headcount });
    }
    return out;
  }

  // statusByArea(dayFinding, sortAreas) → { areaCode: status } for the coverage
  // strip, where status is 'cannot-skip' | 'uncovered' | 'fragile' | 'covered'.
  // Precedence (worst wins): cannot-skip > uncovered > fragile > covered.
  function toSet(arr) {
    const m = {};
    (Array.isArray(arr) ? arr : []).forEach(function (a) { m[String(a).trim().toUpperCase()] = true; });
    return m;
  }
  function statusByArea(dayFinding, sortAreas) {
    const areas = (Array.isArray(sortAreas) && sortAreas.length) ? sortAreas : SORT_AREAS;
    const finding = dayFinding || {};
    const cs = toSet(finding.cannotSkip);
    const un = toSet(finding.uncovered);
    const fr = toSet(finding.fragile);
    const out = {};
    areas.forEach(function (area) {
      const k = String(area).trim().toUpperCase();
      out[area] = cs[k] ? 'cannot-skip' : un[k] ? 'uncovered' : fr[k] ? 'fragile' : 'covered';
    });
    return out;
  }

  return { summarize: summarize, statusByArea: statusByArea, CITATIONS: CITATIONS, SORT_AREAS: SORT_AREAS };
});
