'use strict';

// Command Center view-model deriver (issues #142, #143, ADR-0006 / ADR-0004).
//
// Pure: no DOM, no localStorage. The hub (dashboard.html) reads the other tools'
// stored state and passes it here; this module turns it into the Glance Wall +
// attendance view model. The hub no longer reads a schedule (#1130, ADR-0026):
// the coverage tile, the area-uncovered attention rows and the backfill bench
// went with the old Schedule Viewer, and the Schedule tile is a plain link.
//
// WORST BUG CLASS (attendance): the deriver NEVER re-implements attendance
// filters. What counts toward "attendance today" is decided by
// TimeOff.countsTowardTally; Flags come from AttendanceRules.evaluateByAdmin.
// Protected Sick Time and Scheduled Absences are excluded by countsTowardTally,
// so a protected absence can never become an event or a Flag — it surfaces only
// as the neutral `outToday` context line. This routing is the invariant that
// keeps the hub and the Time-Off tool from ever disagreeing on who counts.
//
// Heads-ups (the approaching-threshold tier) arrive in #144.
//
// Dual-loadable with no build step:
// - Browser: window.CommandCenter (depends on window.QaChecklist / TimeOff / AttendanceRules)
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
  // dismissals (evt:, date-stamped) auto-clear once their date is not the
  // reference day, so today's-event dismissals fall off at the next sort.
  // Attendance dismissals (att:/hu:) persist until restored OR the count
  // changes: the count is baked into the key, so an Admin climbing 3 → 4 yields
  // a new, undismissed key and the worsened Flag re-surfaces on its own. An
  // un-dateable evt: key is kept (conservative — never hide a re-surface
  // because a date couldn't be parsed).
  //
  // cov: and nomap: keys belong to the area rows the hub no longer builds
  // (#1130). Older builds stored them in the hub's own dismissed list; they can
  // never match a row again, so they are dropped here whatever their date.
  function pruneDismissed(keys, refDate) {
    const refKey = ymd(refDate);
    return (Array.isArray(keys) ? keys : []).filter(function (k) {
      const key = String(k);
      if (key.indexOf('cov:') === 0 || key.indexOf('nomap:') === 0) return false;
      if (key.indexOf('evt:') === 0) {
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
  //     Scheduled Absence, mapped to a neutral { name, reason } context line. No
  //     area is attached to anyone.
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
    const evals = AttendanceRules.evaluateByAdmin(list, thresholds, ref);
    const flagged = evals.filter(function (r) { return r.flags && r.flags.length; });
    // Heads-ups (#144): approaching admins (one countable event below a single
    // threshold). Same engine pass, same protected/scheduled exclusion — never
    // a re-implemented filter. Facts-only awareness, subordinate to a Flag.
    const approaching = evals.filter(function (r) { return r.headsups && r.headsups.length; });

    return {
      todayCounted: todayCounted,
      outToday: outToday,
      flagged: flagged,
      approaching: approaching,
      refKey: refKey,
    };
  }

  // buildAttention(attendance) — priority-ordered Needs Attention items.
  // Bands: 2 Flag, 3 today's counted event and Heads-up. (Bands 0 and 1 were the
  // uncovered-area rows; they left with the old schedule, #1130, and the band
  // numbers are kept so dismissal keys and ordering stay as they were.) Each item
  // carries a tier, a stable key, and its priority. Stable within band.
  function buildAttention(attendance) {
    const items = [];
    const refKey = attendance.refKey;

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
    return {
      checklist: deriveChecklistSection(inp.checklistState, inp.phases),
      masterlist: deriveMasterlistSection(inp.masterlistRows),
      ibno: deriveIbnoSection(inp.ibnoSession),
      attendance: {
        todayCount: attendance.todayCounted.length,
        today: attendance.todayCounted.map(function (e) {
          return { name: e.employee || '', type: TimeOff.normalizeType(e.type) };
        }),
        // Neutral context (protected sick, scheduled absence). Never counted,
        // never an attention row, never named anywhere but this line.
        outToday: attendance.outToday,
      },
      attention: buildAttention(attendance),
    };
  }

  return {
    derive: derive,
    deriveChecklistSection: deriveChecklistSection,
    deriveMasterlistSection: deriveMasterlistSection,
    deriveIbnoSection: deriveIbnoSection,
    deriveAttendance: deriveAttendance,
    buildAttention: buildAttention,
    pruneDismissed: pruneDismissed,
  };
});
