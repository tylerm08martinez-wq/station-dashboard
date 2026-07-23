'use strict';

// Command Center view-model deriver (issues #142, #143, ADR-0006 / ADR-0004).
//
// Pure: no DOM, no localStorage. The hub (dashboard.html) reads the other tools'
// stored state, runs the schedule through ToolHelpers (parse → selectDay →
// deriveCoverage), and passes the results here; this module turns them into the
// Glance Wall + attendance view model.
//
// WORST BUG CLASS (attendance): the deriver NEVER re-implements attendance
// filters. What counts toward "attendance today" is decided by
// TimeOff.countsTowardTally; Flags come from AttendanceRules.evaluateByAdmin.
// Protected Sick Time and Scheduled Absences are excluded by countsTowardTally,
// so a protected absence can never become an event or a Flag — it surfaces only
// as neutral `outToday` coverage context. This routing is the invariant that
// keeps the hub and the Time-Off tool from ever disagreeing on who counts.
//
// Heads-ups (the approaching-threshold tier) arrive in #144.
//
// Dual-loadable with no build step:
// - Browser: window.CommandCenter (depends on window.TimeOff / AttendanceRules)
// - Node: require('./lib/command-center')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CommandCenter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const QaChecklist = (typeof require === 'function')
    ? require('./qa-checklist')
    : (root && root.QaChecklist);
  const TimeOff = (typeof require === 'function')
    ? require('./time-off')
    : (root && root.TimeOff);
  const AttendanceRules = (typeof require === 'function')
    ? require('./attendance-rules')
    : (root && root.AttendanceRules);
  const CoverageReconcile = (typeof require === 'function')
    ? require('./coverage-reconcile')
    : (root && root.CoverageReconcile);
  const BackfillBench = (typeof require === 'function')
    ? require('./backfill-bench')
    : (root && root.BackfillBench);
  const Backfill = (typeof require === 'function')
    ? require('./backfill')
    : (root && root.Backfill);

  // Coverage Decision Guide fallbacks now come from the maintained Backfill Bench
  // (scheduling/backfill-bench.md ↔ lib/backfill-bench.js, drift-guarded), so an
  // uncovered area reads "try A1 · A2 · A3" from a record Tyler can
  // grow by confirmation rather than a hard-coded map (PRD #248, ADR-0011).
  const COVERAGE_FALLBACKS = (BackfillBench && BackfillBench.BENCH) ? BackfillBench.BENCH : {};

  // deriveCoverageSection(scheduleView, coverage, fallbacks) — enrich the pure
  // ToolHelpers coverage with the weekday and each uncovered area's fallback
  // names. `scheduleView` is ToolHelpers.selectDay output (or null); `coverage`
  // is ToolHelpers.deriveCoverage output (or null when nothing is loaded).
  function deriveCoverageSection(scheduleView, coverage, fallbacks, namableNames) {
    const fb = fallbacks || COVERAGE_FALLBACKS;
    const loaded = !!(scheduleView && coverage);
    if (!loaded) {
      return {
        loaded: false,
        weekday: scheduleView && scheduleView.weekday ? scheduleView.weekday : null,
        allCovered: false,
        covered: [],
        uncovered: [],
        cannotSkip: [],
      };
    }
    const uncoveredCodes = Array.isArray(coverage.uncovered) ? coverage.uncovered : [];
    const cannotSkip = Array.isArray(coverage.cannotSkip) ? coverage.cannotSkip : [];
    const emptiedBy = coverage.emptiedBy && typeof coverage.emptiedBy === 'object' ? coverage.emptiedBy : {};
    // PRIVACY (ADR-0006 guardrail): the area still reads uncovered for ANY Floor
    // Absence, but only a name that already surfaces as a counted event may be
    // shown as the cause. Protected Sick / Scheduled Absence open the hole yet
    // are NEVER named in the attention framing — they remain neutral out-today
    // context. `namableNames` is the set of counted-today admins; when omitted,
    // no cause is named (fail safe).
    const namable = {};
    (Array.isArray(namableNames) ? namableNames : []).forEach(function (n) {
      namable[String(n == null ? '' : n).trim().toLowerCase()] = true;
    });
    // Present-by-area for the live backfill recommender (#250): today's plan
    // minus ANY Floor Absence, with combo cells ("C/DMG") split. Used to rank
    // who can cover a hole today and what moving them costs.
    const floorAbsent = {};
    Object.keys(emptiedBy).forEach(function (a) {
      (Array.isArray(emptiedBy[a]) ? emptiedBy[a] : []).forEach(function (n) {
        floorAbsent[String(n == null ? '' : n).trim().toLowerCase()] = true;
      });
    });
    const presentByArea = {};
    (Array.isArray(scheduleView.people) ? scheduleView.people : []).forEach(function (p) {
      const name = p && p.name != null ? String(p.name).trim() : '';
      if (!name || floorAbsent[name.toLowerCase()]) return;
      String(p.area != null ? p.area : '')
        .split('/').map(function (c) { return c.trim().toUpperCase(); }).filter(Boolean)
        .forEach(function (code) { (presentByArea[code] || (presentByArea[code] = [])).push(name); });
    });

    const uncovered = uncoveredCodes.map(function (area) {
      const guide = fb[String(area).toUpperCase()] || fb[area] || null;
      const emptied = Array.isArray(emptiedBy[area]) ? emptiedBy[area] : [];
      return {
        area: area,
        cannotSkip: cannotSkip.indexOf(area) !== -1,
        first: guide && Array.isArray(guide.first) ? guide.first.slice() : [],
        note: guide ? guide.note : '',
        // Names whose Floor Absence emptied this area today (ADR-0008), filtered
        // to counted absences only so protected/scheduled names never appear in
        // the attention framing. Empty for a plain plan gap.
        calledOff: emptied.filter(function (n) {
          return namable[String(n == null ? '' : n).trim().toLowerCase()] === true;
        }),
        // Live, cost-tiered backfill recommendation (#250): present Bench
        // candidates grouped by the cost of moving them. null if the recommender
        // isn't loaded (fail safe — the static `first` list still renders).
        backfill: Backfill ? Backfill.recommend(area, { bench: fb, presentByArea: presentByArea }) : null,
      };
    });
    return {
      loaded: true,
      weekday: scheduleView.weekday || null,
      allCovered: uncoveredCodes.length === 0,
      covered: Array.isArray(coverage.covered) ? coverage.covered.slice() : [],
      uncovered: uncovered,
      cannotSkip: cannotSkip.slice(),
    };
  }

  // deriveChecklistSection(checklistState, phases) — fold the QA checklist state
  // map ({ itemId: true }) into per-phase and overall done/total/percent. Counts
  // only ids in the canonical phase set so a stale key can't inflate the total.
  function deriveChecklistSection(checklistState, phases) {
    const list = Array.isArray(phases)
      ? phases
      : ((QaChecklist && QaChecklist.PHASES) || []);
    const map = checklistState && typeof checklistState === 'object' ? checklistState : {};
    let done = 0;
    let total = 0;
    const phaseOut = list.map(function (p) {
      const items = p && Array.isArray(p.items) ? p.items : [];
      const phaseDone = items.filter(function (id) { return map[id] === true; }).length;
      done += phaseDone;
      total += items.length;
      return { name: p && p.name, done: phaseDone, total: items.length };
    });
    return {
      done: done,
      total: total,
      percent: total ? Math.round((done / total) * 100) : 0,
      phases: phaseOut,
    };
  }

  // deriveIbnoSection(ibnoSession) — fold the IBNO Coder's persisted session
  // (lib/ibno-rules shape: { auto, manual, resolved, … }) into the hub's live
  // tile counts. `toCode` is the unresolved manual backlog; `autoReady` is the
  // auto-codeable count. Non-object / malformed input reads as not-loaded zeros.
  function deriveIbnoSection(ibnoSession) {
    const s = ibnoSession && typeof ibnoSession === 'object' ? ibnoSession : null;
    const auto = s && Array.isArray(s.auto) ? s.auto.length : 0;
    const manual = s && Array.isArray(s.manual) ? s.manual.length : 0;
    const resolved = s && Array.isArray(s.resolved) ? s.resolved.length : 0;
    return {
      loaded: (auto + manual + resolved) > 0,
      toCode: manual,
      autoReady: auto,
      resolved: resolved,
    };
  }

  // deriveMasterlistSection(masterlistRows) — how many manual assignments are
  // logged for today. Non-array input reads as zero.
  function deriveMasterlistSection(masterlistRows) {
    return { count: Array.isArray(masterlistRows) ? masterlistRows.length : 0 };
  }

  // Local YYYY-MM-DD for a reference date — matches how the Time-Off tool logs
  // entry.date (local date string). Used to scope "today".
  function ymd(d) {
    const x = d ? new Date(d) : new Date();
    if (isNaN(x.getTime())) return '';
    const m = String(x.getMonth() + 1).padStart(2, '0');
    const day = String(x.getDate()).padStart(2, '0');
    return x.getFullYear() + '-' + m + '-' + day;
  }

  // pruneDismissed(keys, refDate) — dismissal scoping (#146). Day-scoped
  // dismissals (cov:/evt:, date-stamped) auto-clear once their date is not the
  // reference day, so coverage and today's-event dismissals fall off at the next
  // sort. Attendance dismissals (att:/hu:) persist until restored OR the count
  // changes: the count is baked into the key, so an Admin climbing 3 → 4 yields
  // a new, undismissed key and the worsened Flag re-surfaces on its own. An
  // un-dateable cov:/evt: key is kept (conservative — never hide a re-surface
  // because a date couldn't be parsed).
  function pruneDismissed(keys, refDate) {
    const refKey = ymd(refDate);
    return (Array.isArray(keys) ? keys : []).filter(function (k) {
      const key = String(k);
      if (key.indexOf('cov:') === 0 || key.indexOf('evt:') === 0 || key.indexOf('nomap:') === 0) {
        const m = /(\d{4}-\d{2}-\d{2})$/.exec(key);
        return m ? m[1] === refKey : true;
      }
      return true; // att: / hu: (and anything else) persist
    });
  }

  // deriveAttendance(entries, refDate, thresholds) — the worst-bug-class core.
  // Everything routes through the tool's own logic:
  //   - todayCounted: today's entries where TimeOff.countsTowardTally is true.
  //   - outToday: today's entries that do NOT count and are protected-sick or a
  //     Scheduled Absence, mapped to neutral { name, reason } coverage context.
  //   - flagged: AttendanceRules.evaluateByAdmin rows that fired a Flag.
  function deriveAttendance(entries, refDate, thresholds) {
    // Drop tombstones first. A local delete in the Time-Off tool keeps the
    // entry's facts and just sets deleted:true (EntriesSync.tombstone), and the
    // tool's own activeList() excludes them — so the mirror MUST too, or a
    // deleted Call-off could still fire a Flag or show as an event (worst class:
    // wrongly advancing discipline against an Admin off a deleted record).
    const list = (Array.isArray(entries) ? entries : [])
      .filter(function (e) { return e && !e.deleted; });
    const ref = refDate ? new Date(refDate) : new Date();
    const refKey = ymd(ref);

    const todayEntries = list.filter(function (e) { return e && e.date === refKey; });
    const todayCounted = todayEntries.filter(function (e) {
      return TimeOff.countsTowardTally(e);
    });
    const outToday = todayEntries
      .filter(function (e) {
        if (TimeOff.countsTowardTally(e)) return false; // a counted event is not "out today" context
        return TimeOff.isProtectedSick(e) ||
          TimeOff.normalizeType(e.type) === 'Scheduled Absence';
      })
      .map(function (e) {
        return {
          name: e.employee || '',
          reason: TimeOff.isProtectedSick(e) ? 'sick (protected)' : 'scheduled',
        };
      });
    // Floor-Absent admins today (ADR-0008) — the COVERAGE presence set, not the
    // discipline tally. Used to re-derive coverage; a Late is never here.
    const floorAbsentNames = todayEntries
      .filter(function (e) { return TimeOff.isFloorAbsence(e); })
      .map(function (e) { return e.employee || ''; });
    const evals = AttendanceRules.evaluateByAdmin(list, thresholds, ref);
    const flagged = evals.filter(function (r) { return r.flags && r.flags.length; });
    // Heads-ups (#144): approaching admins (one countable event below a single
    // threshold). Same engine pass, same protected/scheduled exclusion — never
    // a re-implemented filter. Facts-only awareness, subordinate to a Flag.
    const approaching = evals.filter(function (r) { return r.headsups && r.headsups.length; });

    return {
      todayCounted: todayCounted,
      outToday: outToday,
      floorAbsentNames: floorAbsentNames,
      flagged: flagged,
      approaching: approaching,
      refKey: refKey,
    };
  }

  // buildAttention(coverage, attendance) — priority-ordered Needs Attention
  // items. Bands: 0 critical uncovered area (Cage A), 1 other uncovered area,
  // 2 Flag, 3 today's counted event. Each item carries a tier, a stable key
  // (dismissal scope lands in #144/#145), and its priority. Stable within band.
  function buildAttention(coverage, attendance) {
    const items = [];
    const refKey = attendance.refKey;

    (coverage.uncovered || []).forEach(function (u) {
      const calledOff = Array.isArray(u.calledOff) ? u.calledOff : [];
      const cause = calledOff.length ? ' (' + calledOff.join(', ') + ' out)' : '';
      items.push({
        tier: u.cannotSkip ? 'critical-area' : 'area',
        priority: u.cannotSkip ? 0 : 1,
        key: 'cov:' + u.area + ':' + refKey,
        area: u.area,
        first: u.first,
        note: u.note,
        backfill: u.backfill,
        cannotSkip: u.cannotSkip,
        calledOff: calledOff,
        title: 'Area ' + u.area + ' uncovered' + (u.cannotSkip ? ' — compliance risk' : '') + cause,
      });
    });

    // One item PER fired flag, not per admin. evaluateByAdmin can fire several
    // flags for one admin (Late + Call-off + NCNS + combination); surfacing only
    // flags[0] would silently drop the rest — including the `combination` flag,
    // which is the strongest signal and the most likely to co-fire.
    attendance.flagged.forEach(function (r) {
      r.flags.forEach(function (f) {
        items.push({
          tier: 'flag',
          priority: 2,
          key: 'att:' + r.admin + ':' + f.kind + ':' + f.count,
          admin: r.admin,
          kind: f.kind,
          count: f.count,
          message: f.message,
          title: r.admin + ' — Flag',
        });
      });
    });

    attendance.todayCounted.forEach(function (e) {
      const type = TimeOff.normalizeType(e.type);
      items.push({
        tier: 'event',
        priority: 3,
        key: 'evt:' + (e.employee || '') + ':' + type + ':' + refKey,
        name: e.employee || '',
        type: type,
        title: (e.employee || '') + ' — ' + type,
      });
    });

    // Heads-ups share band 3 with events but read as awareness, not a Flag.
    // One item per fired heads-up (an admin can approach more than one limit).
    (attendance.approaching || []).forEach(function (r) {
      r.headsups.forEach(function (h) {
        items.push({
          tier: 'headsup',
          priority: 3,
          key: 'hu:' + r.admin + ':' + h.kind + ':' + h.count,
          admin: r.admin,
          kind: h.kind,
          count: h.count,
          message: h.message,
          title: r.admin + ' — heads-up',
        });
      });
    });

    // No-map notes (#209, ADR-0008 fail-loud): a Floor Absence that matched no
    // area on today's schedule. Surfaced — never silently dropped — so a name
    // typo or roster drift can't hand a false all-clear. Sits in the area band
    // (a possible unplaced hole) but framed as a note, not a discipline signal.
    // Already privacy-filtered to counted absences by derive().
    (coverage.noMap || []).forEach(function (name) {
      items.push({
        tier: 'nomap',
        priority: 1,
        key: 'nomap:' + name + ':' + refKey,
        name: name,
        title: name + ' out — not on today’s schedule (no area mapped)',
      });
    });

    // Stable sort by priority band (Array.prototype.sort is stable).
    items.sort(function (a, b) { return a.priority - b.priority; });
    return items;
  }

  // derive(input) -> command-center view model. Pure. Any missing input degrades
  // to a safe empty section rather than throwing, so a malformed store can never
  // blank or break the hub. `refDate` scopes "today" for attendance (defaults to
  // now only as a safety net; callers/tests pass it for determinism).
  function derive(input) {
    const inp = input || {};
    const attendance = deriveAttendance(inp.entries, inp.refDate, inp.thresholds);
    // Reconcile coverage against today's Floor Absences when the caller supplies
    // the per-area roster (ADR-0008). Without it, fall back to the precomputed
    // plan-only coverage — preserving prior behavior for callers/tests that pass
    // `coverage` directly.
    let coverageInput = inp.coverage;
    if (inp.assigneesByArea && CoverageReconcile) {
      coverageInput = CoverageReconcile.reconcileCoverage(
        inp.assigneesByArea, inp.sortAreas, attendance.floorAbsentNames, inp.requiredBodies);
    }
    // Only counted-today admins may be named as a coverage cause (privacy: a
    // protected-sick / scheduled absentee opens the hole but is never named).
    const namable = attendance.todayCounted.map(function (e) { return e.employee || ''; });
    const coverage = deriveCoverageSection(inp.scheduleView, coverageInput, inp.fallbacks, namable);
    // Surface no-map notes only for counted absences. A protected-sick / scheduled
    // admin who is simply off today's schedule is benign AND must not be named in
    // the attention framing (ADR-0006) — so it is never raised as a no-map note.
    const namableNoMap = {};
    namable.forEach(function (n) { namableNoMap[String(n == null ? '' : n).trim().toLowerCase()] = true; });
    coverage.noMap = (coverageInput && Array.isArray(coverageInput.noMap) ? coverageInput.noMap : [])
      .filter(function (n) { return namableNoMap[String(n == null ? '' : n).trim().toLowerCase()] === true; });
    coverage.outToday = attendance.outToday; // neutral out-today coverage context
    return {
      coverage: coverage,
      checklist: deriveChecklistSection(inp.checklistState, inp.phases),
      masterlist: deriveMasterlistSection(inp.masterlistRows),
      ibno: deriveIbnoSection(inp.ibnoSession),
      attendance: {
        todayCount: attendance.todayCounted.length,
        today: attendance.todayCounted.map(function (e) {
          return { name: e.employee || '', type: TimeOff.normalizeType(e.type) };
        }),
      },
      attention: buildAttention(coverage, attendance),
    };
  }

  return {
    derive: derive,
    deriveCoverageSection: deriveCoverageSection,
    deriveChecklistSection: deriveChecklistSection,
    deriveMasterlistSection: deriveMasterlistSection,
    deriveIbnoSection: deriveIbnoSection,
    deriveAttendance: deriveAttendance,
    buildAttention: buildAttention,
    pruneDismissed: pruneDismissed,
    COVERAGE_FALLBACKS: COVERAGE_FALLBACKS,
  };
});
