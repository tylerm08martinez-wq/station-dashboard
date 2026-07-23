'use strict';

// Recurrence Rollup (issue #387, ADR-0015 "Recurrence Rollup").
//
// A PURE grouping/counting pass over already-cleaned records (the kind
// lib/report-clean.js produces): group by a key, count, sort
// most-frequent-first. It answers "which ones happen over and over" from a
// single loaded report — the deliberate BYPASS of the Address Catcher's
// inbound gating, so a recurring bad address surfaces even when it is not on
// today's inbound. The standing reports are already multi-day windows
// (~11 / ~21 days), so recurrence is computable within one export.
//
// This module has NO DOM, NO storage, and NO dependency on the export wiring
// or on report-clean — it operates on plain record objects, so it stays
// independent (the CSV export and the in-tool facet are separate issues).
//
// Two address reports (ADR-0015). The preset field names are the REAL cleaned
// column names lib/report-clean.js emits (keyed on each report's actual header),
// so a rollup over report-clean's cleaned records groups instead of silently
// returning [] on a field-name mismatch (#386 reconciliation):
//  - Manual Assignment Detail -> group by ADDRESS + WORK_AREA1 (the report's
//    own header names). The rollup also names the consistent right area (it
//    rides in `parts`).
//  - Address Corrections -> group by "Original Address" -> "Corrected Address"
//    (the report's own header names). Re-sortable to the bare original
//    ({ by: 'Original Address' }) to expose AMBIGUOUS originals — one original
//    mapping to several corrected values.
//  (The Inbound and Van Scans report has NO rollup — package recurrence is
//   already Repeat History / Recurring IBNO.)
//
// If a rollup key field is missing/blank on a row, that row is EXCLUDED rather
// than emitted as a blank-keyed group.
//
// Dual-loadable with no build step:
// - Browser: window.RecurrenceRollup
// - Node: require('./lib/recurrence-rollup')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RecurrenceRollup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Preset key specs for the two address reports, keyed on the cleaned
  // records' column/field names (ADR-0015).
  const PRESETS = {
    'manual-assignment': { fields: ['ADDRESS', 'WORK_AREA1'] },
    'corrections': { fields: ['Original Address', 'Corrected Address'] },
  };

  const DEFAULT_SEPARATOR = ' — ';
  // Corrections read better with an arrow between original and corrected.
  const SEPARATOR_BY_REPORT = { 'corrections': ' → ' };

  // fieldValue(rec, name) -> trimmed string ('' when missing/blank). '' is the
  // signal that a key part is absent, which excludes the row.
  function fieldValue(rec, name) {
    if (rec == null) return '';
    const v = rec[name];
    return v == null ? '' : String(v).trim();
  }

  // resolveSpec(keySpec) -> { fields, separator, variantField }
  //   keySpec forms:
  //     'corrections' | 'manual-assignment'            (string preset)
  //     { report: 'corrections' }                      (preset)
  //     { report: 'corrections', by: 'Original Address' } (bare-key projection;
  //         groups on `Original Address`, the remaining preset field becomes
  //         the variant field used to detect ambiguous originals)
  //     { fields: ['a', 'b'], separator?, variantField? }   (generic)
  function resolveSpec(keySpec) {
    if (!keySpec) throw new Error('RecurrenceRollup.rollup: keySpec is required');

    let reportName = null;
    let base = null;

    if (typeof keySpec === 'string') {
      reportName = keySpec;
      base = PRESETS[keySpec];
    } else if (keySpec.report) {
      reportName = keySpec.report;
      base = PRESETS[keySpec.report];
    } else if (Array.isArray(keySpec.fields)) {
      base = { fields: keySpec.fields.slice(), variantField: keySpec.variantField || null };
    }

    if (!base || !Array.isArray(base.fields) || base.fields.length === 0) {
      throw new Error('RecurrenceRollup.rollup: could not resolve key fields from keySpec (unknown report or missing fields)');
    }

    let fields = base.fields.slice();
    let variantField = base.variantField || null;

    // Bare-key projection: group on the single named field, keep the other
    // preset field(s) as the variant field for ambiguity detection.
    if (typeof keySpec === 'object' && keySpec.by) {
      if (fields.indexOf(keySpec.by) === -1) {
        throw new Error('RecurrenceRollup.rollup: by="' + keySpec.by + '" is not one of the key fields');
      }
      variantField = fields.filter(function (f) { return f !== keySpec.by; })[0] || null;
      fields = [keySpec.by];
    }

    const separator = (typeof keySpec === 'object' && keySpec.separator) ||
      (reportName && SEPARATOR_BY_REPORT[reportName]) ||
      DEFAULT_SEPARATOR;

    return { fields: fields, separator: separator, variantField: variantField };
  }

  // rollup(records, keySpec) -> [{ key, count, parts[, variants, ambiguous] }]
  // sorted most-frequent-first (ties broken by key ascending for determinism).
  // Rows missing any key field (blank/whitespace-only/absent) are excluded.
  // When the resolved spec has a variantField (the bare-key projection), each
  // group also carries `variants` (distinct other-field values with their own
  // counts, most-frequent-first) and `ambiguous` (variants.length > 1).
  function rollup(records, keySpec) {
    const spec = resolveSpec(keySpec);
    const list = Array.isArray(records) ? records : [];
    const map = new Map();

    for (let i = 0; i < list.length; i++) {
      const rec = list[i];
      const parts = spec.fields.map(function (f) { return fieldValue(rec, f); });
      // Exclude any row with a blank/missing key part — never a blank group.
      let blank = false;
      for (let p = 0; p < parts.length; p++) { if (parts[p] === '') { blank = true; break; } }
      if (blank) continue;

      const key = parts.join(spec.separator);
      let g = map.get(key);
      if (!g) { g = { key: key, count: 0, parts: parts, records: [] }; map.set(key, g); }
      g.count++;
      if (spec.variantField) g.records.push(rec);
    }

    const groups = Array.from(map.values());

    if (spec.variantField) {
      groups.forEach(function (g) {
        const vmap = new Map();
        g.records.forEach(function (rec) {
          const v = fieldValue(rec, spec.variantField);
          if (v === '') return;
          vmap.set(v, (vmap.get(v) || 0) + 1);
        });
        g.variants = Array.from(vmap.entries())
          .map(function (e) { return { value: e[0], count: e[1] }; })
          .sort(function (a, b) {
            return b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
          });
        g.ambiguous = g.variants.length > 1;
      });
    }

    groups.sort(function (a, b) {
      return b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });

    // Emit a clean output shape (drop the internal `records` accumulator).
    return groups.map(function (g) {
      const out = { key: g.key, count: g.count, parts: g.parts };
      if (spec.variantField) { out.variants = g.variants; out.ambiguous = g.ambiguous; }
      return out;
    });
  }

  return {
    PRESETS: PRESETS,
    resolveSpec: resolveSpec,
    rollup: rollup,
  };
});
