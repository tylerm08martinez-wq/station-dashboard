'use strict';

// Schedule parsing + coverage for the Schedule Viewer and the dashboard hub.
//
// Two responsibilities, single-sourced here since issue #328:
//   1. The schedule PRIMITIVES that used to live in lib/tool-helpers.js —
//      SORT_AREAS, CANNOT_SKIP_AREA, parseScheduleInput, selectDay,
//      deriveCoverage, assigneesByArea. Moved verbatim (no behaviour change);
//      tool-helpers keeps only the generic cross-tool plumbing.
//   2. Coverage PRESENTATION (PRD #231, below).
//
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
  // Canonical sort areas + the cannot-skip High VAL cage (issue #79). Sourced
  // from the dashboard/coverage conventions in DASHBOARD.md / CONTEXT.md.
  const SORT_AREAS = ['A', 'B', 'C', 'ME', 'DMG'];
  const CANNOT_SKIP_AREA = 'A'; // Cage A = High VAL; never leave uncovered.

  // Weekday order, single-sourced from tool-helpers (never redefined here).
  const SCHEDULE_DAYS = (helpers && helpers.SCHEDULE_DAYS)
    ? helpers.SCHEDULE_DAYS
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function splitScheduleRow(line) {
    if (line.indexOf('|') !== -1) {
      let s = line.trim();
      if (s.startsWith('|')) s = s.slice(1);
      if (s.endsWith('|')) s = s.slice(0, -1);
      return s.split('|').map(function (c) { return c.trim(); });
    }
    if (line.indexOf('\t') !== -1) {
      return line.split('\t').map(function (c) { return c.trim(); });
    }
    // No delimiter — treat the whole line as a single field (won't pass >=2 check).
    return [line.trim()];
  }

  function parseScheduleInput(raw) {
    const result = { days: SCHEDULE_DAYS.slice(), areas: [], shifts: [], counts: [], helpers: [] };
    if (!raw || typeof raw !== 'string') return result;

    const lines = raw.replace(/\r\n?/g, '\n').split('\n');
    let section = null; // 'areas' | 'shifts' | 'counts' | 'helpers'

    for (let line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;

      // Section heading? Strip markdown heading markers and emphasis.
      const headingText = trimmed
        .replace(/^#+\s*/, '')
        .replace(/\*\*/g, '')
        .replace(/[:_]+$/, '')
        .trim()
        .toLowerCase();

      if (/^area assignments?$/.test(headingText)) { section = 'areas';  continue; }
      if (/^shift times?$/.test(headingText))      { section = 'shifts'; continue; }
      if (/^staffing counts?$/.test(headingText) ||
          /^counts?$/.test(headingText))           { section = 'counts'; continue; }
      // Modified Helpers — parsed into their own bucket so the Viewer can show
      // where each helper is, while staying OUT of `areas` (QA rows, coverage,
      // analyzeWeek and the QA counts all remain helper-free — Principle 15:
      // helpers add depth, they are not full area bodies). Heading may carry a
      // parenthetical, e.g. "Modified Helpers (separate category — not QA)".
      if (/^(modified\s+)?helpers?(\s*\(.*\))?$/.test(headingText)) { section = 'helpers'; continue; }
      // Ignore other headings (e.g. "Schedule Key") without consuming rows under them.
      if (/^#/.test(trimmed) || /^schedule key$/.test(headingText)) { section = null; continue; }

      if (!section) continue;

      const cells = splitScheduleRow(line);
      if (cells.length < 2) continue;

      // Skip markdown separator rows like |---|---|
      if (cells.every(function (c) { return /^:?-{2,}:?$/.test(c) || c === ''; })) continue;

      const label = cells[0].trim();
      if (label === '') continue;

      // Skip header rows.
      const labelLower = label.toLowerCase();
      if (labelLower === 'employee' || labelLower === 'count' || labelLower === 'code' || labelLower === 'name' || labelLower === 'helper') {
        continue;
      }

      // Take the next 7 fields as day cells; pad short rows with ''.
      const dayCells = [];
      for (let i = 0; i < 7; i++) {
        dayCells.push((cells[i + 1] !== undefined ? cells[i + 1] : '').trim());
      }

      if (section === 'counts') {
        result.counts.push({ label: label, cells: dayCells });
      } else if (section === 'shifts') {
        result.shifts.push({ employee: label, cells: dayCells });
      } else if (section === 'helpers') {
        result.helpers.push({ employee: label, cells: dayCells });
      } else {
        result.areas.push({ employee: label, cells: dayCells });
      }
    }

    return result;
  }

  // ─── TODAY SELECTOR + COVERAGE (pure; issue #79) ─────────────────────────

  // An off cell: blank or a dash (em/en/hyphen). Anything else = working.
  function isOffCell(cell) {
    const c = String(cell == null ? '' : cell).trim();
    return c === '' || /^[—–-]+$/.test(c);
  }

  // Split a combo assignment ("C/DMG") into its constituent area codes,
  // uppercased and trimmed. A plain cell yields a single-element list.
  function splitAreaCell(cell) {
    return String(cell == null ? '' : cell)
      .split('/')
      .map(function (p) { return p.trim().toUpperCase(); })
      .filter(function (p) { return p !== ''; });
  }

  // selectDay(parsed, weekdayIndex) — 0=Sun..6=Sat. Pure: caller passes the
  // weekday (no internal clock) so tests are deterministic. Returns today's
  // view: people working with their area + shift, today's counts keyed by
  // label, and the set of constituent area codes assigned today.
  function selectDay(parsed, weekdayIndex) {
    const empty = { weekday: null, weekdayIndex: weekdayIndex, people: [], counts: {}, assignedAreas: [] };
    if (!parsed || typeof parsed !== 'object') return empty;
    const idx = Number(weekdayIndex);
    if (!(idx >= 0 && idx <= 6)) return empty;

    const days = Array.isArray(parsed.days) ? parsed.days : SCHEDULE_DAYS;
    const weekday = days[idx] != null ? days[idx] : SCHEDULE_DAYS[idx];

    // Build a shift lookup by employee for today.
    const shiftByEmployee = {};
    (Array.isArray(parsed.shifts) ? parsed.shifts : []).forEach(function (row) {
      const cell = row && Array.isArray(row.cells) ? row.cells[idx] : '';
      shiftByEmployee[row.employee] = isOffCell(cell) ? '' : String(cell).trim();
    });

    const people = [];
    const assigned = {};
    (Array.isArray(parsed.areas) ? parsed.areas : []).forEach(function (row) {
      const cell = row && Array.isArray(row.cells) ? row.cells[idx] : '';
      if (isOffCell(cell)) return; // off today — excluded from people-working
      const area = String(cell).trim();
      people.push({
        name: row.employee,
        area: area, // combo preserved intact for display
        shift: shiftByEmployee[row.employee] || '',
      });
      splitAreaCell(area).forEach(function (code) { assigned[code] = true; });
    });

    const counts = {};
    (Array.isArray(parsed.counts) ? parsed.counts : []).forEach(function (row) {
      const cell = row && Array.isArray(row.cells) ? row.cells[idx] : '';
      counts[row.label] = String(cell == null ? '' : cell).trim();
    });

    return {
      weekday: weekday,
      weekdayIndex: idx,
      people: people,
      counts: counts,
      assignedAreas: Object.keys(assigned),
    };
  }

  // deriveCoverage(assignedAreas, sortAreas) — given the constituent area
  // codes covered today and the canonical sort-area set, return which areas
  // are covered/uncovered and flag the High VAL cage (cage A) as cannot-skip
  // when it is uncovered. Pure.
  function deriveCoverage(assignedAreas, sortAreas) {
    const areas = Array.isArray(sortAreas) && sortAreas.length ? sortAreas : SORT_AREAS;
    const have = {};
    (Array.isArray(assignedAreas) ? assignedAreas : []).forEach(function (a) {
      have[String(a).trim().toUpperCase()] = true;
    });
    const covered = [];
    const uncovered = [];
    areas.forEach(function (a) {
      if (have[String(a).toUpperCase()]) covered.push(a);
      else uncovered.push(a);
    });
    const cannotSkip = uncovered.filter(function (a) {
      return String(a).toUpperCase() === CANNOT_SKIP_AREA;
    });
    return { covered: covered, uncovered: uncovered, cannotSkip: cannotSkip };
  }

  // assigneesByArea(parsed, weekdayIndex) — { areaCode: [employeeName, …] } for
  // the day. Unlike selectDay's assignedAreas (just the set of covered codes),
  // this keeps WHO is in each area, which coverage reconciliation needs to know
  // who to remove. Combo cells ("C/DMG") put the admin in every constituent area.
  function assigneesByArea(parsed, weekdayIndex) {
    const view = selectDay(parsed, weekdayIndex);
    const map = {};
    view.people.forEach(function (p) {
      splitAreaCell(p.area).forEach(function (code) {
        if (!map[code]) map[code] = [];
        map[code].push(p.name);
      });
    });
    return map;
  }

  // Finding type → scheduling/principles.md rule number. The map is the contract
  // between the tab and principles.md; tests/schedule-coverage.test.js asserts
  // each cited rule still exists so a renumber can't make the panel cite the
  // wrong rule.
  //
  // Only findings that map to a named judgment are cited:
  //   cannotSkip    → rule 1 (Cage A cannot be uncovered)
  //   headcount     → rule 3 (counts/temps)
  // (The old damagesNoSolo → rule 4 citation was removed 2026-07-23: amended
  // Principle 4 says solo-capability is not a scheduling constraint, so the
  // flag was pure noise.)
  // `uncovered` (an ordinary unstaffed sort area) and `fragile` (Cage A covered
  // by exactly one person — a single point of failure) are mechanical
  // observations with no clean principle, so they render WITHOUT a rule pill
  // (principle: null); fragile is heatmap-only besides.
  const CITATIONS = { cannotSkip: 1, headcount: 3 };

  const AREA_NAME = { A: 'Cage A', B: 'Cage B', C: 'Cage C', ME: 'Middle Earth', DMG: 'Damages' };
  function areaLabel(code) {
    const key = String(code == null ? '' : code).trim().toUpperCase();
    return AREA_NAME[key] || key;
  }
  function areaList(finding, key) {
    return Array.isArray(finding[key]) ? finding[key] : [];
  }

  // summarize(dayFinding) → [{ type, area, message, principle }] panel lines,
  // ordered most-severe first: cannot-skip → uncovered → headcount.
  // `fragile` is intentionally excluded (heatmap-only — see below).
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

  return {
    summarize: summarize,
    statusByArea: statusByArea,
    CITATIONS: CITATIONS,
    SORT_AREAS: SORT_AREAS,
    CANNOT_SKIP_AREA: CANNOT_SKIP_AREA,
    parseScheduleInput: parseScheduleInput,
    selectDay: selectDay,
    deriveCoverage: deriveCoverage,
    assigneesByArea: assigneesByArea,
  };
});
