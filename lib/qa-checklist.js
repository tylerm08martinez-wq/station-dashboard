'use strict';

// Shared QA checklist helpers (issue #93).
//
// Dual-loadable with no build step:
// - Browser: window.todayKey, window.completionStats (and window.QaChecklist)
// - Node: require('./lib/qa-checklist')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.QaChecklist = api;
    root.todayKey = api.todayKey;
    root.completionStats = api.completionStats;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function phoenixDateKey(date) {
    const d = date == null ? new Date() : new Date(date);
    if (isNaN(d.getTime())) return '';

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Phoenix',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);

    const lookup = {};
    parts.forEach(function (part) {
      lookup[part.type] = part.value;
    });
    return lookup.year + '-' + lookup.month + '-' + lookup.day;
  }

  function todayKey(date) {
    return 'qa_checklist_' + phoenixDateKey(date);
  }

  // Canonical checklist phases (counts-only: id, name, item ids). Mirrors the
  // PHASES defined in qa-checklist.html — the two MUST stay in sync until that
  // tool is refactored to consume this export. The command center reads this so
  // the hub's checklist tile counts the same items the QA tool does.
  const PHASES = [
    { id: 'pre-sort',    name: 'Pre-Sort',     items: ['cal', 'aging', 'dsw-12s', 'multiday', 'ibno', 'emails'] },
    { id: 'during-sort', name: 'During Sort',  items: ['inbound-van', 'walmart', 'masterlist', 'hazmat', 'swak-999', 'appts', 'team-time', 'extra-time'] },
    { id: 'closeout',    name: 'Closeout',     items: ['ussc-shutdown', 'closure-trailer'] },
  ];

  function itemId(item) {
    return item && typeof item === 'object' ? item.id : item;
  }

  function completionStats(state, items) {
    const list = Array.isArray(items) ? items : [];
    const doneMap = state && typeof state === 'object' ? state : {};
    const total = list.length;
    let done = 0;

    list.forEach(function (item) {
      if (doneMap[itemId(item)] === true) done++;
    });

    return {
      done: done,
      total: total,
      percent: total ? Math.round((done / total) * 100) : 0,
    };
  }

  return {
    todayKey: todayKey,
    completionStats: completionStats,
    PHASES: PHASES,
  };
});
