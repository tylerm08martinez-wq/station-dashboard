'use strict';

// Live backfill recommender (PRD #248, ADR-0011). Given an uncovered QA Area and
// today's *present* assignments, returns the present Backfill Bench candidates
// grouped by the mechanical cost of moving them — bench-with-facts, not a solver.
//
// Pure. Single-sources the cannot-skip designation from tool-helpers so it never
// disagrees with the rest of the domain.
//
// Dual-loadable, no build step:
//   - Browser: window.Backfill.recommend
//   - Node:    require('./lib/backfill').recommend

(function (root, factory) {
  let helpers = root && root.ToolHelpers ? root.ToolHelpers : null;
  if (!helpers && typeof require !== 'undefined') {
    try { helpers = require('./tool-helpers'); } catch (e) { helpers = null; }
  }
  let analysis = root && root.ScheduleAnalysis ? root.ScheduleAnalysis : null;
  if (!analysis && typeof require !== 'undefined') {
    try { analysis = require('./schedule-analysis'); } catch (e) { analysis = null; }
  }
  const api = factory(helpers, analysis);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Backfill = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (helpers, analysis) {
  const CANNOT_SKIP_AREA = (helpers && helpers.CANNOT_SKIP_AREA) ? helpers.CANNOT_SKIP_AREA : 'A';

  // Solo-capable runners (Scheduling Principle 4), single-sourced from the
  // analysis layer (#242) — never redefined here. For a Damages backfill, a
  // candidate not on this list covers DMG but leaves rule 4 unsatisfied.
  const SOLO_SET = {};
  ((analysis && analysis.SOLO_CAPABLE_RUNNERS) || []).forEach(function (n) {
    SOLO_SET[String(n).trim().toUpperCase()] = true;
  });
  function isSoloCapable(name) { return SOLO_SET[String(name).trim().toUpperCase()] === true; }

  // Cost tiers, worst-last. Lower rank = cheaper move = shown first.
  const TIER_RANK = { 'free': 0, 'reassign': 1, 'reopens-cannot-skip': 2 };

  // recommend(area, ctx) → { area, escalate, candidates }
  //   ctx.bench         — the Backfill Bench (per-area { first:[names], note })
  //   ctx.presentByArea — { AREA: [present names] }: today's plan minus Floor
  //                       Absences, combo cells ("C/DMG") split into constituents
  //
  // candidates is the present Bench candidates for `area`, ordered free →
  // reassign → reopens-cannot-skip, with the Bench's preference order kept WITHIN
  // a tier. Each: { name, tier, currentArea, opens:[areas a move would vacate] }.
  // escalate is true when no Bench candidate is present today.
  function recommend(area, ctx) {
    const bench = (ctx && ctx.bench) || {};
    const presentByArea = (ctx && ctx.presentByArea) || {};
    const cannotSkip = String(CANNOT_SKIP_AREA).toUpperCase();
    const isDamages = String(area).toUpperCase() === 'DMG';

    // name → [present areas they hold today]
    const areasByName = {};
    Object.keys(presentByArea).forEach(function (a) {
      (presentByArea[a] || []).forEach(function (name) {
        const key = String(name).trim();
        (areasByName[key] || (areasByName[key] = [])).push(String(a).toUpperCase());
      });
    });
    function countIn(a) { return (presentByArea[String(a).toUpperCase()] || []).length; }

    const entry = bench[String(area).toUpperCase()] || bench[area] || { first: [] };
    const tryOrder = Array.isArray(entry.first) ? entry.first : [];

    const candidates = [];
    tryOrder.forEach(function (name) {
      const present = areasByName[String(name).trim()];
      if (!present || present.length === 0) return; // off today or Floor-Absent → excluded

      // Areas this person SOLELY holds (moving them vacates those).
      const sole = present.filter(function (a) { return countIn(a) === 1; });
      let tier;
      if (sole.indexOf(cannotSkip) !== -1) tier = 'reopens-cannot-skip';
      else if (sole.length > 0) tier = 'reassign';
      else tier = 'free'; // every area they hold stays covered without them

      candidates.push({
        name: name,
        tier: tier,
        currentArea: present.join('/'),
        opens: sole.slice(),
        // Rule 4 (#251): a Damages backfill by a non-Solo-capable runner still
        // leaves DMG without someone who can run it alone.
        needsPartner: isDamages && !isSoloCapable(name),
      });
    });

    // Stable sort by tier rank; tryOrder already gives the within-tier order.
    candidates.sort(function (a, b) { return TIER_RANK[a.tier] - TIER_RANK[b.tier]; });

    return { area: area, escalate: candidates.length === 0, candidates: candidates };
  }

  return { recommend: recommend };
});
