'use strict';

// Shared Manual Assignment Detail helpers for the Station 849 MasterList tool.
//
// Dual-loadable with no build step:
// - Browser: window.MasterlistLib plus individual function globals
// - Node: require('./lib/masterlist')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.MasterlistLib = api;
    root.parseAssignmentRows = api.parseAssignmentRows;
    root.dedupeAssignments = api.dedupeAssignments;
    root.detectDays = api.detectDays;
    root.normalizeAddress = api.normalizeAddress;
    root.analyzeAssignments = api.analyzeAssignments;
    root.buildMasterlistTSV = api.buildMasterlistTSV;
    root.buildMasterlistArtifact = api.buildMasterlistArtifact;
    root.manualEntryToAssignment = api.manualEntryToAssignment;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const csvApi = (typeof require === 'function') ? require('./csv') : null;
  const toolHelpers = (typeof require === 'function') ? require('./tool-helpers') : (root && root.ToolHelpers);
  const parseCSV = csvApi && csvApi.parseCSV ? csvApi.parseCSV : (root && root.parseCSV);

  // headerKey(name) -> canonical lookup key. The real "Manual Assignment Detail
  // at IB Scan" export names columns with underscores and trailing digit
  // suffixes (TRACKING_ID, WORK_AREA1, SCAN_DT1, ORIGINAL_SCAN, ...). The shared
  // CsvLib.columnGetter only trims+uppercases, so it can't see TRACKING_ID as
  // "TRACKING ID". We canonicalize underscores->spaces, collapse whitespace, and
  // drop a trailing digit suffix so the underscored export and the legacy
  // space-separated shape both map to the same key. (Local to MasterList: the
  // digit-suffix strip would be unsafe in the shared getter, where IBNO relies
  // on suffixed columns like STATUS_CODES1 / VAN_SCAN_TIME1.)
  function headerKey(name) {
    return String(name == null ? '' : name)
      .trim().toUpperCase()
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s*\d+$/, '');
  }

  // columnGetter(headerRow) -> get(row, name). Header-name-keyed accessor matched
  // via headerKey() so column-order and naming-style changes don't break us.
  // First occurrence of a key wins; out-of-range / missing -> ''.
  function columnGetter(headerRow) {
    const map = Object.create(null);
    (Array.isArray(headerRow) ? headerRow : []).forEach(function (h, i) {
      const key = headerKey(h);
      if (key && map[key] === undefined) map[key] = i;
    });
    return function get(row, name) {
      const idx = map[headerKey(name)];
      if (!Array.isArray(row) || idx === undefined || idx < 0 || idx >= row.length) return '';
      const cell = row[idx];
      return String(cell == null ? '' : cell).trim();
    };
  }

  // findHeaderIndex(rows) -> index of the real header row. The export carries a
  // title/summary preamble ABOVE the header (a "Textbox4" line and a quoted
  // "Facility:/Scan Date(s):/..." block). TRACKING ID + ORIGINAL SCAN appear in
  // every export's header and never in a preamble line, so the first row
  // carrying both (after headerKey normalization) is the header. No match -> 0,
  // preserving the legacy rows[0]-is-header behavior. Mirrors IBNO's approach.
  const HEADER_SIGNATURE = ['TRACKING ID', 'ORIGINAL SCAN'];
  function findHeaderIndex(rows) {
    if (!Array.isArray(rows)) return 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      const keys = row.map(headerKey);
      if (HEADER_SIGNATURE.every(function (sig) { return keys.indexOf(sig) !== -1; })) return i;
    }
    return 0;
  }

  function parseOriginalCode(originalScan) {
    const raw = String(originalScan == null ? '' : originalScan).trim();
    if (!raw || raw === '-') return '';
    const parts = raw.split('-').map(function (p) { return p.trim(); }).filter(Boolean);
    if (parts.length === 0) return '';
    if (/^CLOSED$/i.test(parts[0]) && parts.length > 1) return parts[1];
    return parts[0];
  }

  // parseAssignmentRows(rows) -> assignment[]. The "Manual Assignment Detail at
  // IB Scan" export may carry a title/summary preamble above the header, so we
  // locate the real header (findHeaderIndex) instead of assuming rows[0].
  // Columns are matched by name (underscore/suffix/case-insensitive via
  // headerKey) so naming-style and column-order changes don't break us. Tolerant
  // of short and garbage rows: any row without a TRACKING ID is skipped.
  // originalCode is the operational route/work-area code from ORIGINAL SCAN; the
  // rare "CLOSED - <code>" prefix uses the code after CLOSED.
  function parseAssignmentRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const start = findHeaderIndex(rows);
    const get = columnGetter(rows[start]);
    const out = [];
    for (let r = start + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      const trackingId = get(row, 'TRACKING ID');
      if (!trackingId) continue;  // skip blank / unparseable rows
      const originalScan = get(row, 'ORIGINAL SCAN');
      const originalCode = parseOriginalCode(originalScan);
      out.push({
        scanDate:     get(row, 'SCAN DT'),
        scanTime:     get(row, 'SCAN TM'),
        facility:     get(row, 'FACILITY'),
        trackingId:   trackingId,
        scanBarcode:  get(row, 'SCAN BARCODE'),
        stopId:       get(row, 'STOP ID'),
        workArea:     get(row, 'WORK AREA'),
        address:      get(row, 'ADDRESS'),
        postalCode:   get(row, 'POSTAL CODE'),
        userName:     get(row, 'USER NAME'),
        originalScan: originalScan,
        originalCode: originalCode
      });
    }
    return out;
  }

  // dedupeAssignments(assignments) -> { kept, removedCount }. Collapses scan-gun
  // double-hits: same TRACKING ID + WORK AREA on the same SCAN DT. Distinct work
  // areas for one tracking/day are kept (a real second assignment); the same
  // tracking on different days is kept (different sort).
  function dedupeAssignments(assignments) {
    const list = Array.isArray(assignments) ? assignments : [];
    const seen = Object.create(null);
    const kept = [];
    let removedCount = 0;
    for (let i = 0; i < list.length; i++) {
      const a = list[i] || {};
      const key = (a.trackingId || '') + '\0' + (a.workArea || '') + '\0' + (a.scanDate || '');
      if (seen[key]) { removedCount++; continue; }
      seen[key] = true;
      kept.push(a);
    }
    return { kept: kept, removedCount: removedCount };
  }

  // 'MM/DD/YYYY' -> YYYYMMDD number for chronological sort (non-matching -> 0).
  function dayKey(mdY) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(mdY == null ? '' : mdY).trim());
    if (!m) return 0;
    return Number(m[3]) * 10000 + Number(m[1]) * 100 + Number(m[2]);
  }

  // detectDays(assignments) -> ['MM/DD/YYYY', ...] sorted most-recent first.
  function detectDays(assignments) {
    const list = Array.isArray(assignments) ? assignments : [];
    const set = Object.create(null);
    for (let i = 0; i < list.length; i++) {
      const d = list[i] && list[i].scanDate;
      if (d) set[d] = true;
    }
    return Object.keys(set).sort(function (a, b) { return dayKey(b) - dayKey(a); });
  }

  // Street-suffix variants -> canonical form. Used to (a) standardize the suffix
  // and (b) find where the street name ends so trailing city/state/ZIP can be cut.
  const STREET_SUFFIXES = {
    AVENUE: 'AVE', AVE: 'AVE', AV: 'AVE',
    STREET: 'ST', ST: 'ST',
    DRIVE: 'DR', DRV: 'DR', DR: 'DR',
    ROAD: 'RD', RD: 'RD',
    LANE: 'LN', LN: 'LN',
    BOULEVARD: 'BLVD', BLVD: 'BLVD', BLV: 'BLVD',
    COURT: 'CT', CT: 'CT',
    CIRCLE: 'CIR', CIR: 'CIR',
    PLACE: 'PL', PL: 'PL',
    TRAIL: 'TRL', TRL: 'TRL',
    WAY: 'WAY',
    PARKWAY: 'PKWY', PKWY: 'PKWY',
    HIGHWAY: 'HWY', HWY: 'HWY',
    PLAZA: 'PLZ', PLZ: 'PLZ',
    TERRACE: 'TER', TER: 'TER',
    LOOP: 'LOOP',
    POINT: 'PT', PT: 'PT',
    RIDGE: 'RDG', RDG: 'RDG',
    SQUARE: 'SQ', SQ: 'SQ',
    COVE: 'CV', CV: 'CV',
    PASS: 'PASS', RUN: 'RUN', PARK: 'PARK',
    CROSSING: 'XING', XING: 'XING'
  };

  // normalizeAddress(raw) -> base-building key. Collapses to house number +
  // street name + suffix so an apartment complex (5335 E SHEA BLVD, APT 1075 /
  // APT 2031) reads as ONE building, and the same physical address under
  // different stop IDs / formatting groups together. Drops everything after the
  // first comma (apt/lot/unit/notes), strips the "SHIP ADDRESS" prefix and
  // embedded phone numbers, truncates at the last street suffix (which removes a
  // trailing city/state/ZIP), standardizes the suffix, and uppercases. NOTE:
  // human names embedded mid-street (e.g. "5088 W KEVIN WANG ... CIR") are not
  // reliably separable from a street name; we strip the clearly-junk parts
  // (phone, trailing city/ZIP, post-comma) and group on what remains.
  function normalizeAddress(raw) {
    let s = String(raw == null ? '' : raw).toUpperCase();
    if (!s.trim()) return '';
    s = s.replace(/\./g, ' ');                  // "N." -> "N"
    s = s.replace(/^\s*SHIP ADDRESS\s+/, '');   // strip report prefix
    s = s.split(',')[0];                        // drop apt/lot/unit/notes
    s = s.replace(/\b\d{3}[-\s]?\d{3}[-\s]?\d{4}\b/g, ' '); // phone (3-3-4)
    s = s.replace(/\b\d{10,}\b/g, ' ');         // bare 10+ digit runs (phones)

    let tokens = s.split(/\s+/).filter(Boolean);

    // Split a glued directional + ordinal: "N69TH" -> "N", "69TH".
    const expanded = [];
    tokens.forEach(function (t) {
      const m = /^([NSEW]{1,2})(\d+(?:ST|ND|RD|TH)?)$/.exec(t);
      if (m) { expanded.push(m[1]); expanded.push(m[2]); }
      else expanded.push(t);
    });
    tokens = expanded;

    // Truncate after the LAST street-suffix token (cuts trailing city/state/ZIP)
    // and standardize that suffix. token[0] is the house number, so start at 1.
    let suffixIdx = -1;
    for (let i = tokens.length - 1; i >= 1; i--) {
      if (STREET_SUFFIXES[tokens[i]]) { suffixIdx = i; break; }
    }
    if (suffixIdx !== -1) {
      tokens = tokens.slice(0, suffixIdx + 1);
      tokens[suffixIdx] = STREET_SUFFIXES[tokens[suffixIdx]];
    } else {
      // No recognizable suffix: best-effort drop of trailing ZIP / state tokens.
      while (tokens.length > 1) {
        const last = tokens[tokens.length - 1];
        if (/^\d{5}(\d{4})?$/.test(last) || last === 'AZ') tokens.pop();
        else break;
      }
    }
    return tokens.join(' ').replace(/\s+/g, ' ').trim();
  }

  // analyzeAssignments(assignments) -> insight panels. Expects a deduped list for
  // the selected day.
  function analyzeAssignments(assignments, rerouteWorkAreas) {
    const list = Array.isArray(assignments) ? assignments : [];
    const buildings = Object.create(null);
    const workAreas = Object.create(null);
    const users = Object.create(null);
    const realWorkAreas = Object.create(null);

    list.forEach(function (a) {
      if (!a) return;
      if (a.workArea) {
        realWorkAreas[a.workArea] = true;
        workAreas[a.workArea] = (workAreas[a.workArea] || 0) + 1;
      }
      if (a.userName) users[a.userName] = (users[a.userName] || 0) + 1;

      const building = normalizeAddress(a.address);
      if (!building) return;  // can't group a blank address (e.g. closure rows)
      let b = buildings[building];
      if (!b) {
        b = buildings[building] = {
          building: building, count: 0,
          zipSet: Object.create(null), unitSet: Object.create(null), assignments: []
        };
      }
      b.count++;
      const zip5 = String(a.postalCode == null ? '' : a.postalCode).replace(/\D/g, '').slice(0, 5);
      if (zip5) b.zipSet[zip5] = true;
      const unit = String(a.address == null ? '' : a.address).trim();
      if (unit) b.unitSet[unit] = true;
      b.assignments.push(a);
    });

    const repeatedAddresses = Object.keys(buildings)
      .map(function (k) {
        const b = buildings[k];
        return {
          building: b.building,
          count: b.count,
          zips: Object.keys(b.zipSet).sort(),
          units: Object.keys(b.unitSet).sort(),
          // Distinct manual work areas the building's packages landed in (#309).
          // A single area = consistent sort; multiple = scatter / reroute signal.
          workAreas: Array.from(new Set(b.assignments
            .map(function (a) { return a && a.workArea ? String(a.workArea) : ''; })
            .filter(Boolean))).sort(),
          assignments: b.assignments.slice().sort(function (x, y) {
            const xt = String(x && x.scanTime || '');
            const yt = String(y && y.scanTime || '');
            if (xt !== yt) return xt < yt ? -1 : 1;
            const xl = String(x && x.trackingId || '');
            const yl = String(y && y.trackingId || '');
            return xl < yl ? -1 : (xl > yl ? 1 : 0);
          })
        };
      })
      .filter(function (b) { return b.count >= 2; })
      .sort(function (x, y) {
        if (y.count !== x.count) return y.count - x.count;
        return x.building < y.building ? -1 : (x.building > y.building ? 1 : 0);
      });

    const byWorkArea = Object.keys(workAreas)
      .map(function (k) { return { workArea: k, count: workAreas[k] }; })
      .sort(function (x, y) {
        if (y.count !== x.count) return y.count - x.count;
        return x.workArea < y.workArea ? -1 : (x.workArea > y.workArea ? 1 : 0);
      });

    const byUser = Object.keys(users)
      .map(function (k) { return { user: k, count: users[k] }; })
      .sort(function (x, y) {
        if (y.count !== x.count) return y.count - x.count;
        return x.user < y.user ? -1 : (x.user > y.user ? 1 : 0);
      });

    // A code counts as a real-route reroute only if it also appears as a WORK
    // AREA value. That reference set is file-wide when the caller supplies it
    // (reroutes are commonly cross-day — the original scan can be days old);
    // otherwise fall back to the work areas present in this list.
    const rerouteRef = rerouteWorkAreas || realWorkAreas;
    const reroutes = list.filter(function (a) {
      return !!(a && a.originalCode && rerouteRef[a.originalCode]);
    });

    return {
      repeatedAddresses: repeatedAddresses,
      byWorkArea: byWorkArea,
      byUser: byUser,
      reroutes: reroutes,
      total: list.length,
      dates: detectDays(list)
    };
  }

  // buildMasterlistTSV(entries, patterns, dateStr) -> tab-separated string with
  // a date header, one row per entry (#, time, tracking #, route, note), a grand
  // total line, and a free-text patterns section. No DOM access.
  function buildMasterlistTSV(entries, patterns, dateStr) {
    function clean(s) {
      return String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim();
    }
    const list = Array.isArray(entries) ? entries : [];
    const lines = [];
    lines.push('MasterList Manual Assignments\t' + clean(dateStr));
    lines.push('');
    lines.push(toolHelpers.buildTSV(
      ['#', 'Time', 'Tracking #', 'Route / Area', 'Note'],
      list.map(function (e, i) {
        return [
        i + 1,
        clean(toolHelpers.formatTime(e.timestamp)),
        clean(e.label),
        clean(e.route),
        clean(e.note)
        ];
      })
    ));
    lines.push('');
    lines.push('Grand Total\t' + list.length);
    lines.push('');
    lines.push('Patterns');
    lines.push(String(patterns == null ? '' : patterns).trim());
    return lines.join('\n');
  }

  // buildMasterlistArtifact(analysis, dateStr, patterns) -> Markdown report
  // matching reports/masterlists/masterlist-template.md. No DOM access.
  function buildMasterlistArtifact(analysis, dateStr, patterns) {
    function cleanCell(s) {
      return String(s == null ? '' : s).replace(/[|\t\r\n]+/g, ' ').trim();
    }
    const data = analysis || {};
    const repeated = Array.isArray(data.repeatedAddresses) ? data.repeatedAddresses : [];
    const workAreas = Array.isArray(data.byWorkArea) ? data.byWorkArea : [];
    const users = Array.isArray(data.byUser) ? data.byUser : [];
    const lines = [];

    lines.push('# MasterList Manual Assignments');
    lines.push('');
    lines.push('**Date:** ' + cleanCell(dateStr));
    lines.push('**Source:** Manual Assignment Detail at IB Scan');
    lines.push('');
    lines.push('| Address | Count | Notes |');
    lines.push('|---------|-------|-------|');
    repeated.forEach(function (b) {
      const zips = Array.isArray(b && b.zips) ? b.zips : [];
      lines.push('| ' + cleanCell(b && b.building) + ' | ' +
        cleanCell(b && b.count) + ' | ' + cleanCell(zips.join(', ')) + ' |');
    });
    lines.push('');
    lines.push('**Grand Total:** ' + cleanCell(data.total == null ? 0 : data.total));

    if (workAreas.length > 0) {
      lines.push('');
      lines.push('## Volume by Work Area');
      lines.push('');
      lines.push('| Work Area | Count |');
      lines.push('|-----------|-------|');
      workAreas.forEach(function (w) {
        lines.push('| ' + cleanCell(w && w.workArea) + ' | ' + cleanCell(w && w.count) + ' |');
      });
    }

    if (users.length > 0) {
      lines.push('');
      lines.push('## Volume by User');
      lines.push('');
      lines.push('| User | Count |');
      lines.push('|------|-------|');
      users.forEach(function (u) {
        lines.push('| ' + cleanCell(u && u.user) + ' | ' + cleanCell(u && u.count) + ' |');
      });
    }

    lines.push('');
    lines.push('## Patterns');
    lines.push('');
    lines.push(String(patterns == null ? '' : patterns));
    return lines.join('\n');
  }

  function manualEntryToAssignment(e) {
    return {
      trackingId: (e && e.label) || '',
      workArea: (e && e.route) || '',
      address: '',
      postalCode: '',
      userName: '',
      scanDate: toolHelpers.isoDate(),
      originalCode: ''
    };
  }

  return {
    parseCSV: parseCSV,
    parseOriginalCode: parseOriginalCode,
    findHeaderIndex: findHeaderIndex,
    parseAssignmentRows: parseAssignmentRows,
    dedupeAssignments: dedupeAssignments,
    detectDays: detectDays,
    normalizeAddress: normalizeAddress,
    analyzeAssignments: analyzeAssignments,
    buildMasterlistTSV: buildMasterlistTSV,
    buildMasterlistArtifact: buildMasterlistArtifact,
    manualEntryToAssignment: manualEntryToAssignment
  };
});
