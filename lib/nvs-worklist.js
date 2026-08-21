'use strict';

// Filter + group core for the NVS Builder (issues #416 + #418, ADR-0017).
//
// Pure and DETERMINISTIC: `now` is passed IN, never read from the clock inside,
// so unit tests can pin it (the tool reads the live browser clock and passes it).
//
// What it does (folded in from prototypes/nvs-print-prototype.html, whose logic
// was validated against the real fixture at now = 08:55: 15 belts, 41 areas,
// 56 REG kept = 43 not-loaded + 13 misloaded across 12 misload sections):
//   1. Keep only DEVICE_DIM_CODE == REG (drop smalls SML and NCs IC).
//   2. Overdue FLOOR: keep only packages whose IB_TIME is at least
//      `thresholdMinutes` (default 45) before `now`. This is conveyor transit
//      lag — a van scan missing for less than transit time just means the
//      package is still travelling the belts, not missed. A time later than
//      `now` (clock skew) is treated as 0 overdue and excluded by the floor.
//      An UNPARSEABLE IB_TIME is kept and flagged (a find-the-missed-packages
//      tool must never silently drop a package over a bad timestamp).
//      The floor applies UNIFORMLY to both sections — no misload exemption
//      (Tyler's ruling, ADR-0017).
//   3. Classify each kept row by ISSUE_TYPE (lib/nvs-report.js): "No Van Scan"
//      -> notLoaded, "Misload - <area> | <handler> <time>" -> misloaded, with
//      the parsed { scannedArea, handler, time } attached for display. A misload
//      whose detail string doesn't parse is STILL misloaded — ''-fields with
//      the raw remainder in `misload.raw` for verbatim display (issue #419).
//      A row matching NEITHER kind is excluded from both sections and counted
//      in counts.excluded — not silently dropped (issue #419).
//   4. Misload routing (#441 misload-redesign verdict, 2026-07-08 — corrected
//      semantics): the parsed misload area is where the package was
//      mis-SCANNED, NOT a destination; the package BELONGS to the row's own
//      IB_WORK_AREA. Every kept misload therefore emits TWO line items:
//        - a HOME item in its own area's ticket (always renders — every
//          misload is guaranteed visible on its home sheet), and
//        - an ACTOR item routed to the mis-scanned-to area's ticket (that
//          area owns the action: the wrong truck has the package or the
//          wrong scan). The mis-scanned-to area may be on a DIFFERENT belt —
//          the area->belt map is derived from the report's own rows. Routing
//          to an area with no kept packages CREATES that ticket (it renders
//          with just its misload section). If the mis-scanned-to area appears
//          nowhere in the report (belt underivable), NO actor item is emitted
//          (Tyler's ruling, #443 final round): the home line already carries
//          everything ("...misload scanned to 403"), so a duplicate row in
//          the same ticket adds noise, not information — the never-hide rule
//          is satisfied by the home item. An unparseable misload detail (no
//          scannedArea) likewise emits the home item only.
//   5. Group belt -> work area -> { notLoaded, misloaded, actorMisloads },
//      each section sorted by SORT_SID ascending (Tyler, 2026-08-01). The
//      sheet is a lookup table, not a priority queue: a handler holding a
//      package needs to FIND its SID among ~30 chips. Superseded oldest-first.
//
// Dual-loadable with no build step (lib/nvs-report.js must be loaded first in
// the browser):
// - Browser: window.NvsWorklistLib / window.buildNvsWorklist
// - Node: require('./lib/nvs-worklist').buildNvsWorklist

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.NvsWorklistLib = api;
    root.buildNvsWorklist = api.buildNvsWorklist;
    root.timeToMinuteOfDay = api.timeToMinuteOfDay;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const reportApi = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./nvs-report')
    : (root && root.NvsReportLib);
  const isMisload = reportApi.isMisload;
  const isNoVanScan = reportApi.isNoVanScan;
  const parseMisload = reportApi.parseMisload;

  const DEFAULT_THRESHOLD = 45;
  // Default flagged work areas excluded from the belt sheets (#514): the
  // IBNO Coder's DEFAULT_FLAGGED_WORK_AREAS (lib/ibno-rules.js) + 9925.
  // Duplicated deliberately — the NVS tool must not take a runtime
  // dependency on the IBNO module for one constant; the in-tool textarea is
  // the override when the lists drift.
  const DEFAULT_EXCLUDED_WORK_AREAS = ['103', '2299', '302', '3399', '403', '300', '400', '500', '600', '999', '9925'];

  // "07:11 AM" / "07:11 PM" -> minute of day (0..1439). Unparseable -> null.
  function timeToMinuteOfDay(t) {
    const m = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(String(t == null ? '' : t));
    if (!m) return null;
    let h = (+m[1]) % 12;
    if (/PM/i.test(m[3])) h += 12;
    return h * 60 + (+m[2]);
  }

  // Accept `now` as a Date (browser clock) or a number (minute of day, for
  // tests). Returns minute of day.
  function nowToMinuteOfDay(now) {
    if (now == null) throw new Error('buildNvsWorklist requires a `now` (Date or minute-of-day number)');
    if (typeof now === 'number') return now;
    if (now instanceof Date || (now && typeof now.getHours === 'function')) {
      return now.getHours() * 60 + now.getMinutes();
    }
    throw new Error('buildNvsWorklist: `now` must be a Date or a minute-of-day number');
  }

  function buildNvsWorklist(records, options) {
    const opts = options || {};
    const nowMin = nowToMinuteOfDay(opts.now);
    const rawThreshold = opts.thresholdMinutes;
    const threshold = (rawThreshold == null || isNaN(+rawThreshold)) ? DEFAULT_THRESHOLD : +rawThreshold;

    const list = Array.isArray(records) ? records : [];

    // Flagged work-area exclusion (#514): hold/closure lanes (999, 302, …)
    // never appear on the belt sheets — the packages aren't supposed to be
    // van-scanned anyway, and the tickets mean nothing to the belt handlers
    // the sheets are for. opts.excludeAreas is LITERAL: undefined/null means
    // NO exclusion (the lib stays neutral; the tool applies the business
    // default), and an explicit array — even EMPTY — is honored as-is.
    const excludeSet = Object.create(null);
    if (opts.excludeAreas != null && Array.isArray(opts.excludeAreas)) {
      opts.excludeAreas.forEach(function (a) {
        const key = String(a == null ? '' : a).trim();
        if (key) excludeSet[key] = true;
      });
    }

    let keptReg = 0;
    let notLoadedCount = 0;
    let misloadedCount = 0;
    let excludedCount = 0;
    let areaExcludedCount = 0;
    const beltSet = Object.create(null);
    const areaSet = Object.create(null);

    // belt -> area -> { notLoaded: [pkg], misloaded: [pkg], actorMisloads: [item] }
    const beltMap = Object.create(null);

    function ensureArea(belt, area) {
      if (!beltMap[belt]) beltMap[belt] = Object.create(null);
      if (!beltMap[belt][area]) {
        beltMap[belt][area] = { notLoaded: [], misloaded: [], actorMisloads: [] };
      }
      return beltMap[belt][area];
    }

    // Area -> belt map derived from the report's OWN rows (all of them — not
    // just kept ones), so an actor item can route to the mis-scanned-to
    // area's belt even when that area has nothing overdue itself.
    const areaToBelt = Object.create(null);
    list.forEach(function (rec) {
      const a = String(rec && rec.IB_WORK_AREA || '').trim();
      const b = String(rec && rec.BELT || '').trim();
      if (a && b && areaToBelt[a] === undefined) areaToBelt[a] = b;
    });

    // Kept misloads waiting for actor routing (routed after the main pass so
    // created tickets never affect classification/floor of real rows).
    const pendingActors = [];

    list.forEach(function (rec) {
      const dim = String(rec && rec.DEVICE_DIM_CODE || '').trim().toUpperCase();
      if (dim !== 'REG') return; // drop smalls (SML) and NCs (IC)

      // Classify BEFORE the floor: an ISSUE_TYPE matching neither "No Van Scan"
      // nor "Misload" is excluded from both sections — counted, never bucketed
      // into notLoaded by default (issue #419).
      const misload = parseMisload(rec.ISSUE_TYPE);
      if (!misload && !isNoVanScan(rec.ISSUE_TYPE)) {
        excludedCount++;
        return;
      }

      const ibMin = timeToMinuteOfDay(rec.IB_TIME);
      let minutesOverdue;
      let unknownTime = false;

      if (ibMin == null) {
        // Unparseable timestamp: keep + flag rather than silently drop.
        unknownTime = true;
        minutesOverdue = null;
      } else {
        let age = nowMin - ibMin;
        if (age < 0) age = 0; // clock skew / stray PM -> 0, excluded by the floor
        // Apply the overdue floor — uniformly to BOTH sections (no misload
        // exemption). Unknown-time rows bypass the floor (kept).
        if (age < threshold) return;
        minutesOverdue = age;
      }

      const belt = String(rec.BELT || '').trim();
      const area = String(rec.IB_WORK_AREA || '').trim();
      // Excluded-area rows (#514) count NOWHERE — belts, areas, kept REG,
      // either section — as if the report didn't carry them, except the
      // areaExcluded tally. A belt whose rows are all excluded simply has no
      // sheet. Misloads homed here never reach the actor queue either.
      if (excludeSet[area]) { areaExcludedCount++; return; }

      // This row survives the filters and counts toward "kept REG".
      keptReg++;
      beltSet[belt] = true;
      areaSet[belt + '|' + area] = true;

      if (misload) misloadedCount++; else notLoadedCount++;

      const pkg = {
        sortSid: String(rec.SORT_SID || '').trim(),
        tracking: String(rec.PKG_LABEL_XREF || '').trim(),
        city: String(rec.LABEL_CITY || '').trim(),
        weight: String(rec.PKG_WEIGHT || '').trim(),
        statusCodes: String(rec.STATUS_CODES || '').trim(),
        belt: belt,
        area: area,
        // Raw inbound clock time (e.g. "03:44 AM"), carried through so the
        // Ticket Wall print layout (#441) can show "in at H:MM AM" without
        // re-deriving it from a side lookup, as the throwaway prototype did.
        // minutesOverdue (below) stays the source of truth for the floor/sort.
        ibTime: String(rec.IB_TIME || '').trim(),
        minutesOverdue: minutesOverdue,
        unknownTime: unknownTime,
        misload: misload, // { scannedArea, handler, time, raw } or null
      };

      ensureArea(belt, area)[misload ? 'misloaded' : 'notLoaded'].push(pkg);

      // Misload routing (#441 verdict): the HOME item above always renders in
      // the package's own area. A parsed scannedArea additionally queues an
      // ACTOR item for the mis-scanned-to area's ticket. Unparseable detail
      // (no scannedArea) has nowhere to route: home item only (issue #419).
      // A misload mis-scanned to its OWN area emits the home row only too —
      // an actor row beside it would double-show the package in one ticket
      // with a self-referential instruction (code-review finding).
      if (misload && misload.scannedArea && misload.scannedArea !== area) pendingActors.push(pkg);
    });

    // Route actor items. The mis-scanned-to area may live on another belt
    // (areaToBelt) or may need its ticket created. When the area appears
    // nowhere in the report (belt underivable) no actor item is emitted —
    // the home line already says "misload scanned to <area>", so a duplicate
    // row in the same ticket would only add noise (Tyler's ruling, #443
    // final round). Every emitted actor item is therefore ROUTED.
    let routedActorCount = 0;
    pendingActors.forEach(function (pkg) {
      const dest = pkg.misload.scannedArea;
      const destBelt = areaToBelt[dest];
      // #514: a mis-scan TO an excluded area routes no actor item either (the
      // scanner won't allow such scans anyway) — like an unroutable misload,
      // the home line is the only record and the package still counts
      // physically in its home truck.
      if (destBelt === undefined || excludeSet[dest]) return; // home line carries it; drop the actor row
      routedActorCount++;
      // Mark the HOME package as routed so the physical-count derivation
      // below (area.packageCount) can exclude it from its home ticket: it
      // now sits in the destination truck, where the actor item counts it.
      // An unroutable misload (no destBelt) is never marked, so it stays
      // physically present in its home ticket's count.
      pkg.routed = true;
      const item = {
        sortSid: pkg.sortSid,
        // Full tracking number (PKG_LABEL_XREF) rides along so the actor
        // ticket can print the confirm-the-package line — pulling the wrong
        // box from a neighbor's truck is worse than not pulling (Tyler,
        // #443 round).
        tracking: pkg.tracking,
        homeArea: pkg.area,
        homeBelt: pkg.belt,
        scannedArea: dest,
        handler: pkg.misload.handler,
        time: pkg.misload.time,
        // minutesOverdue is NOT rendered on actor rows, but bySid() below
        // uses ageRank() as its duplicate-SID tiebreak, and duplicate SIDs are
        // common (562 values repeat in the 7/31 export). Dropping this field
        // would silently flatten those ties to insertion order, so keep it.
        // unknownTime has no such use site (ageRank only checks null)
        // and is never rendered, so it is dropped as dead weight.
        minutesOverdue: pkg.minutesOverdue,
        statusCodes: pkg.statusCodes,
      };
      ensureArea(destBelt, dest).actorMisloads.push(item);
    });

    function ageRank(p) { return p.minutesOverdue == null ? Infinity : p.minutesOverdue; }

    // Chip order within a ticket is by SORT_SID ascending (Tyler, 2026-08-01:
    // "sort the sids to make it easier for them"). This REPLACES the previous
    // oldest-first order.
    //
    // Why the change: the sheet is a lookup table, not a priority queue. A
    // handler stands at the belt holding a package and needs to find ITS SID
    // among ~30 chips. Oldest-first made that a linear scan of every chip;
    // ascending SID makes it a jump. Nothing is dropped either way (the
    // overdue threshold is a floor, not a band), the chips never printed their
    // minutes-overdue, and the belt sheet has no other use for age order.
    //
    // Sorting is NATURAL, not lexicographic: a SID is 4 digits with an
    // optional letter suffix ("1039", "2037FL", and at least one "####SQ" in
    // the 7/31 export, so the suffix is not always FL). Plain string sort
    // would be fine for equal-width SIDs today, but a 3- or 5-digit SID would
    // land in the wrong place, and that failure is invisible until it bites.
    // So: numeric part first, then suffix, then most-overdue as the tiebreak
    // for genuine duplicates (562 SID values repeat in the 7/31 export).
    // Blank SIDs (52 of 2442 rows there) sort LAST rather than first: they
    // cannot be looked up, so they must not sit at the top of the lookup
    // table, but they still have to render (never hide a package).
    const SID_SPLIT = /^(\d+)(.*)$/;
    function sidKey(p) {
      const raw = String(p && p.sortSid != null ? p.sortSid : '').trim().toUpperCase();
      const m = raw && SID_SPLIT.exec(raw);
      if (!m) return { missing: raw ? 1 : 2, num: Infinity, rest: raw };
      return { missing: 0, num: +m[1], rest: m[2] };
    }
    function bySid(packages) {
      return packages.slice().sort(function (a, b) {
        const ka = sidKey(a);
        const kb = sidKey(b);
        if (ka.missing !== kb.missing) return ka.missing - kb.missing;
        if (ka.num !== kb.num) return ka.num - kb.num;
        if (ka.rest !== kb.rest) return ka.rest < kb.rest ? -1 : 1;
        return ageRank(b) - ageRank(a);
      });
    }

    const belts = Object.keys(beltMap).sort(compareBelts).map(function (beltName) {
      const areaMap = beltMap[beltName];
      const areas = Object.keys(areaMap).sort().map(function (areaName) {
        const notLoaded = bySid(areaMap[areaName].notLoaded);
        const misloaded = bySid(areaMap[areaName].misloaded);
        const actorMisloads = bySid(areaMap[areaName].actorMisloads);
        return {
          area: areaName,
          notLoaded: notLoaded,
          misloaded: misloaded,
          actorMisloads: actorMisloads,
          // Ticket count (Tyler's ruling, #443 code review): PHYSICAL packages
          // sitting in THIS area's truck. A ROUTED `misloaded` package (its
          // scannedArea resolved to a real belt, so it emitted an actor item
          // over there) has physically left this truck for the destination
          // truck, where it already counts as an actorMisload. Counting it
          // here too would double-count it across the wall. An UNROUTABLE
          // misload (no scannedArea, self-referential, or the destination
          // area is nowhere in the report) never got an actor item anywhere,
          // so it is still physically here and counts. The home misload ROWS
          // still render regardless (awareness, issue #419); only the count
          // excludes the routed ones.
          packageCount: notLoaded.length + actorMisloads.length +
            misloaded.filter(function (p) { return !p.routed; }).length,
        };
      });
      // Ticket Wall density tier (issue #441 addendum), attached once here —
      // a pure, testable derivation from this belt's own area/package counts
      // — rather than re-derived by every consumer on every render. Counts
      // RENDERED bulk: actor-created tickets and actor line items take page
      // space just like package chips do.
      const packageCount = areas.reduce(function (n, a) {
        return n + a.notLoaded.length + a.misloaded.length + a.actorMisloads.length;
      }, 0);
      return { belt: beltName, areas: areas, densityTier: densityTier(areas.length, packageCount) };
    });

    return {
      belts: belts,
      counts: {
        keptReg: keptReg,
        notLoaded: notLoadedCount,
        misloaded: misloadedCount, // kept misload PACKAGES (each also emits a home line)
        actorItems: routedActorCount, // ROUTED actor lines only (unroutable misloads render their home line alone)
        excluded: excludedCount,
        areaExcluded: areaExcludedCount, // kept-pattern rows dropped by the flagged-area exclusion (#514)
        // beltCount/areaCount describe where kept PACKAGES physically are;
        // actor-created tickets (a routed misload landing in an area with
        // nothing overdue of its own) render on top of these.
        beltCount: Object.keys(beltSet).length,
        areaCount: Object.keys(areaSet).length,
      },
      thresholdMinutes: threshold,
    };
  }

  // Belt sheet order (Tyler's ruling, #443 feedback round): by belt NUMBER
  // first, and within the same number ODD before EVEN — plain lexicographic
  // sort put "B- 01 EVEN" before "B- 01 ODD", which reads backwards on the
  // floor. A belt name matching neither pattern is never dropped and never
  // crashes the sort (the never-hide rule applies to belts too): unmatched
  // names sort AFTER all matched ones, lexicographically among themselves.
  function beltSortKey(name) {
    const m = /(\d+)\s*(EVEN|ODD)/i.exec(String(name == null ? '' : name));
    if (!m) return null;
    return { number: +m[1], odd: /ODD/i.test(m[2]) };
  }

  // Belt-pair grouping key (#513): the belt NUMBER two EVEN/ODD sides share,
  // as a canonical numeric string — "B- 01 ODD" and "B- 1 EVEN" both key to
  // "1", so the pair groups can never drift from compareBelts' numeric sort
  // groups. null when the name matches no number+EVEN/ODD pattern (such a
  // belt pairs with nothing).
  function beltPairKey(name) {
    const key = beltSortKey(name);
    return key ? String(key.number) : null;
  }

  function compareBelts(a, b) {
    const ka = beltSortKey(a);
    const kb = beltSortKey(b);
    if (ka && kb) {
      if (ka.number !== kb.number) return ka.number - kb.number;
      if (ka.odd !== kb.odd) return ka.odd ? -1 : 1; // ODD before EVEN
      return a < b ? -1 : a > b ? 1 : 0;
    }
    if (ka) return -1; // matched belts before unmatched
    if (kb) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  // Ticket Wall density tier (issue #441, addendum: "no empty real estate").
  // A belt sheet's per-area "ticket" grid scales UP when the belt is light, so
  // a small belt still fills the page and reads from a distance, instead of
  // leaving white space at the printed v3-prototype sizing. Deterministic and
  // count-based (never measures rendered pixels), so it is unit-testable and
  // reproducible in both the browser and Node.
  //
  // Two tiers only. A belt is LARGE when it clears BOTH light-belt caps, and
  // COMPACT otherwise. There is deliberately no third tier and no separate
  // COMPACT floor: one pair of caps is the single cliff, so the two sides of
  // one belt cannot drift into different layouts over a threshold nobody
  // remembers setting.
  //   LARGE    areaCount <= 8 AND packageCount <= 12. A genuinely light belt;
  //            scale up so the sheet isn't mostly blank.
  //   COMPACT  everything else. Tight full-width bands with the bare giant
  //            area numeral; matches the prototype's validated fit.
  //
  // STANDARD retired 2026-07-31 (Tyler's call). The old middle tier sat behind
  // a hard >=10-area cliff, so on the real 7/31 report at 05:10 B- 01 ODD had
  // 10 areas and printed COMPACT while B- 01 EVEN had 9 and printed STANDARD,
  // one area apart. Tyler reads the compact sheet faster and wants it
  // everywhere past a genuinely light belt.
  //
  // The area cap is 8, not 4, and that number is MEASURED, not guessed. With
  // the caps forced open, real belts were rendered through the tool and their
  // printed height compared against the US-Letter printable area the tool
  // calibrates to (720x960 CSS px at 96dpi). LARGE holds one page up to 9
  // areas (837px, 0.87 of a page) and overflows at 10 (1019px, 1.06). 8 leaves
  // a row of headroom. Re-measure before changing it; the tier's own CSS
  // sizing is what sets the ceiling, so editing that invalidates this number.
  //
  // Why the cap moved: at 4, the area arm alone demoted belts that were nearly
  // empty by package count. On the 7/31 report B- 05 ODD (5 areas, 5 packages)
  // and B- 02 ODD (6 areas, 8 packages) printed COMPACT, which is the tight
  // layout meant for a loaded belt. A near-empty sheet in dense type is the
  // exact complaint LARGE exists to prevent.
  const DENSITY_LARGE_MAX_AREAS = 8;
  const DENSITY_LARGE_MAX_PACKAGES = 12;

  function densityTier(areaCount, packageCount) {
    const areas = +areaCount || 0;
    const packages = +packageCount || 0;
    if (areas > DENSITY_LARGE_MAX_AREAS || packages > DENSITY_LARGE_MAX_PACKAGES) return 'compact';
    return 'large';
  }

  // Ticket width tier (2-page cap, 7/15 round). Every ticket used to be one
  // grid column wide with chips 2-across, so a heavy area became a tall
  // skinny tower (the real 7/15 export had a 69-chip area printing as a
  // 35-row column — 3 pages for a one-area belt). A chip-heavy ticket now
  // spans more of the 3-column wall and packs chips proportionally wider,
  // which keeps chip size CONSTANT while cutting ticket height by the span
  // factor. Deterministic and count-based like densityTier, for the same
  // testability reasons. Thresholds: a span-1 ticket holds up to 12 chips
  // (6 rows of 2) before it is taller than a span-2 ticket of the same
  // count at 5-across; past 30 chips (6 rows of 5) full width wins.
  const TICKET_SPAN2_MIN_CHIPS = 13;
  const TICKET_SPAN3_MIN_CHIPS = 31;

  function ticketLayout(chipCount, densityTier) {
    // COMPACT belts (7/15 print round 2): every ticket is a full-width band
    // with auto-filled chip columns. Mixed-width tickets in a 3-column grid
    // sized rows to the tallest neighbor, and the dead space under short
    // tickets forced a 64% print shrink on the densest real belt; full-width
    // bands stack with zero fragmentation and print at 100%.
    if (densityTier === 'compact') return { span: 3, chipCols: 'auto' };
    const chips = +chipCount || 0;
    if (chips >= TICKET_SPAN3_MIN_CHIPS) return { span: 3, chipCols: 7 };
    if (chips >= TICKET_SPAN2_MIN_CHIPS) return { span: 2, chipCols: 5 };
    return { span: 1, chipCols: 2 };
  }

  return {
    buildNvsWorklist: buildNvsWorklist,
    timeToMinuteOfDay: timeToMinuteOfDay,
    densityTier: densityTier,
    ticketLayout: ticketLayout,
    beltPairKey: beltPairKey,
    DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
    DEFAULT_EXCLUDED_WORK_AREAS: DEFAULT_EXCLUDED_WORK_AREAS,
  };
});
