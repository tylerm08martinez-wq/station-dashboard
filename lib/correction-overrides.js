'use strict';

// Correction Feedback Loop — the override-apply engine (issue #426, PRD #423,
// ADR-0018). Applies PROMOTED rejects from lib/correction-log.js to a
// trustedEntries()-shaped entry list. This is the `/verify`-gated logic: it
// is the first slice that changes what the Address Catcher actually
// suggests (matchInbound's inputs), so every effect here is conservative by
// construction — overrides only ever SUPPRESS, DEMOTE, or FIX an existing
// trusted correction. None of them can fabricate a new one.
//
// Effect follows the reject's reason category (mirrors CorrectionLog.CATEGORIES,
// ADR-0018 decision 3):
//   - "wrong destination"                    -> suppress the mapping entirely
//     (dropped from trustedEntries() output; matchInbound never sees it).
//   - "wrong work area"                      -> KEPT in trustedEntries, but
//     flagged so matchInbound suppresses just the `misroute` flag for that
//     mapping — the address correction and the proper-area display both
//     survive (misroute is computed inside matchInbound from
//     entry.workArea vs the inbound record's ibWorkArea; nulling workArea
//     would also kill the useful "proper area" pill, so this is a flag, not
//     a field wipe).
//   - "not always right / context-dependent" -> demoted OUT of trustedEntries
//     into a separate "manually-demoted" list — a NEW verify-first tier,
//     distinct from the name-gated Name-match Advisory (lib/address-match.js
//     matchNameAdvisories), which requires a recipient-name match this tier
//     does not.
//   - "outdated / forward ended"             -> aged out, same as "wrong
//     destination" (suppressed entirely).
//
// Overrides are keyed to the SPECIFIC original -> corrected mapping, not the
// original address alone — reusing lib/correction-log.js's own mappingKey()
// (built from the SAME originalDisplay/correctedDisplay strings the reject
// UI recorded against, per address-catcher.html's rejectGroup()). So if the
// dictionary later maps the same original to a DIFFERENT corrected value,
// that new mapping has a different key and is judged fresh — the old
// override simply does not match it. An override whose mapping key is not
// present among the CURRENT trustedEntries() output is inert: it has nothing
// to apply to, and applying it is a silent no-op, never an error. An empty
// (or no-promoted) log is an exact no-op on both entries and misroute keys.
//
// PURE: no DOM, no network, no clock read. Dual-loadable:
// - Browser: window.CorrectionOverrides
// - Node: require('./lib/correction-overrides')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CorrectionOverrides = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  function deps() {
    const CorrectionLog = (root && root.CorrectionLog) ||
      (typeof require === 'function' ? require('./correction-log') : null);
    if (!CorrectionLog) throw new Error('CorrectionOverrides dependency unavailable (need CorrectionLog)');
    return { CorrectionLog: CorrectionLog };
  }

  const CATEGORY = {
    WRONG_DESTINATION: 'wrong destination',
    WRONG_WORK_AREA: 'wrong work area',
    NOT_ALWAYS_RIGHT: 'not always right / context-dependent',
    OUTDATED: 'outdated / forward ended',
  };

  // ── Area Verdict Loop (issue #452, slice 6 of #446) ──────────────────────
  // The area side of the feedback loop: promoted AREA verdicts (kind:'area',
  // logged via CorrectionLog.logAreaVerdict) map to an effect verb that
  // AreaDictionary.matchInbound applies to its RESOLVED entries. The
  // category->verb mapping lives HERE (mirrors the correction category->effect
  // switch above); the mechanical application to resolved entries lives in
  // lib/area-dictionary.js (its applyAreaEffects) — the same split as the
  // correction side, where address-match honors a pre-computed suppress-set it
  // never has to understand. wrong-contractor maps to NO verb: it keeps the
  // flag and records the escalation (held in the log), changing no resolution
  // output. Nothing applies until explicit promotion (promotedAreaOverrides
  // filters to promoted), so a logged-but-unpromoted verdict is a total no-op.
  const AREA_CATEGORY = {
    CONFIRMED_MISSORT: 'confirmed missort',
    ROUTING_CHANGED: 'routing changed / history stale',
    MULTI_AREA: 'legitimately multi-area',
    WRONG_CONTRACTOR: 'wrong contractor / plotting issue reported',
  };

  // Effect verbs consumed by AreaDictionary.matchInbound(opts.areaEffects).
  // These string literals are the contract with lib/area-dictionary.js (kept
  // as literals on both sides so neither module has to import the other, same
  // discipline as the misroute-suppress Set). area-dictionary.js's
  // applyAreaEffects switches on these exact values.
  const AREA_EFFECT = { STRENGTHEN: 'strengthen', SUPPRESS: 'suppress', DEMOTE: 'demote' };

  function areaCategoryEffect(category) {
    switch (category) {
      case AREA_CATEGORY.CONFIRMED_MISSORT: return AREA_EFFECT.STRENGTHEN;
      case AREA_CATEGORY.ROUTING_CHANGED:   return AREA_EFFECT.SUPPRESS;
      case AREA_CATEGORY.MULTI_AREA:        return AREA_EFFECT.DEMOTE;
      case AREA_CATEGORY.WRONG_CONTRACTOR:  return null; // keep the flag, no resolution change
      default: return null;
    }
  }

  // promotedAreaOverrides(log) -> the active, PROMOTED, kind:'area' subset of
  // the log. The correction-side promotedOverrides() deliberately does NOT
  // filter by kind (its consumers key off correction mapping keys an area
  // verdict can never produce, so an area record is naturally inert there);
  // this one filters to area records so areaEffects() below only ever sees
  // area verdicts.
  function promotedAreaOverrides(log) {
    const d = deps();
    return d.CorrectionLog.activeRecords(log).filter(function (r) {
      return r && r.kind === 'area' && r.status === d.CorrectionLog.STATUS.PROMOTED;
    });
  }

  // areaEffects(overrides) -> { [areaMappingKey]: effectVerb }. overrides is
  // the result of promotedAreaOverrides(log). Keyed by the SAME areaMappingKey
  // each verdict was logged against (record.key = CorrectionLog.areaMappingKey
  // (areaKey, area)), so AreaDictionary looks each resolved entry up by its own
  // mappingKey(entry.key, entry.area) — a verdict whose area no longer matches
  // the current dominant area is inert (judged fresh, ADR-0018). Records with
  // no verb (wrong-contractor) contribute nothing; an empty overrides array
  // yields an empty map -> an EXACT no-op in matchInbound.
  function areaEffects(overrides) {
    const out = Object.create(null);
    (Array.isArray(overrides) ? overrides : []).forEach(function (o) {
      if (!o || !o.key) return;
      const verb = areaCategoryEffect(o.category);
      if (verb) out[o.key] = verb;
    });
    return out;
  }

  // promotedOverrides(log) -> the active, PROMOTED subset of a raw
  // correction log — the only records this module ever applies. Callers
  // (the page, tests) compute this once per render/case and pass the result
  // to applyToTrustedEntries()/misrouteSuppressKeys() below so both agree on
  // the exact same override set.
  function promotedOverrides(log) {
    const d = deps();
    return d.CorrectionLog.activeRecords(log).filter(function (r) {
      return r.status === d.CorrectionLog.STATUS.PROMOTED;
    });
  }

  // entryMappingKey(entry) -> the SAME key a reject was logged against
  // (CorrectionLog.mappingKey applied to the entry's own display strings).
  // trustedEntries() output always carries originalDisplay/correctedDisplay
  // straight from the dictionary entry that produced the worklist card, so
  // this is exactly the key address-catcher.html's rejectGroup() used.
  function entryMappingKey(entry) {
    const d = deps();
    return d.CorrectionLog.mappingKey(entry && entry.originalDisplay, entry && entry.correctedDisplay);
  }

  // indexByKey(overrides) -> { [mappingKey]: overrideRecord }. Later entries
  // win on a duplicate key, but promotedOverrides()/CorrectionLog already
  // guarantee at most one active record per key, so this is just a lookup
  // build, not a merge policy.
  function indexByKey(overrides) {
    const out = Object.create(null);
    (Array.isArray(overrides) ? overrides : []).forEach(function (o) {
      if (o && o.key) out[o.key] = o;
    });
    return out;
  }

  // applyToTrustedEntries(entries, overrides) -> { entries, demoted }
  //
  // entries: trustedEntries()-shaped array (must carry originalDisplay /
  //   correctedDisplay — the same shape AddressDictionary.trustedEntries()
  //   and lib/address-match.js already use).
  // overrides: the result of promotedOverrides(log) (an empty array is a
  //   valid, exact no-op input).
  //
  // Returns TWO entry lists, both STRICT SUBSETS (by reference) of the input
  // `entries` — this function only removes or re-labels members of the input,
  // it never adds anything not already present (the never-fabricate
  // invariant, enforced structurally here rather than merely by convention):
  //   - entries: what trustedEntries() should feed matchInbound with, after
  //     dropping wrong-destination/outdated mappings and demoted ones. A
  //     "wrong work area" override does NOT remove its entry here — see
  //     misrouteSuppressKeys() below for how that effect is applied.
  //   - demoted: entries pulled out for the "not always right" verify-first
  //     tier, each shallow-cloned with `demoted: true` / `demotedReason` so a
  //     caller can tell a manually-demoted entry apart from a regular one
  //     without re-deriving anything.
  function applyToTrustedEntries(entries, overrides) {
    const list = Array.isArray(entries) ? entries : [];
    const byKey = indexByKey(overrides);
    const kept = [];
    const demoted = [];
    list.forEach(function (entry) {
      const override = byKey[entryMappingKey(entry)];
      if (!override) { kept.push(entry); return; }
      switch (override.category) {
        case CATEGORY.WRONG_DESTINATION:
        case CATEGORY.OUTDATED:
          return; // suppressed / aged out -- dropped entirely, not carried anywhere
        case CATEGORY.NOT_ALWAYS_RIGHT:
          demoted.push(Object.assign({}, entry, { demoted: true, demotedReason: override.category }));
          return;
        case CATEGORY.WRONG_WORK_AREA:
        default:
          // Kept as-is here; the misroute-suppress flag is a separate,
          // additive signal (see misrouteSuppressKeys) so the entry's
          // workArea display is never touched.
          kept.push(entry);
      }
    });
    return { entries: kept, demoted: demoted };
  }

  // misrouteSuppressKeys(entries, overrides) -> Set<string>
  //
  // Builds the per-mapping "suppress misroute" flag set that
  // lib/address-match.js's matchInbound(..., { misrouteSuppressKeys }) reads.
  // Keyed by the dictionary's OWN entry identity (`originalKey + '|' +
  // correctedKey`) rather than the display mapping key, because that is the
  // identity matchInbound already looks entries up by internally — this
  // keeps address-match.js free of any dependency on correction-log.js's key
  // format. `entries` should be the FULL trustedEntries() output (before
  // applyToTrustedEntries() runs) so a "wrong work area" override's entry
  // (which applyToTrustedEntries() keeps) is still present to key off of.
  function misrouteSuppressKeys(entries, overrides) {
    const list = Array.isArray(entries) ? entries : [];
    const byKey = indexByKey(overrides);
    const out = new Set();
    list.forEach(function (entry) {
      const override = byKey[entryMappingKey(entry)];
      if (override && override.category === CATEGORY.WRONG_WORK_AREA) {
        out.add(String(entry.originalKey || '') + '|' + String(entry.correctedKey || ''));
      }
    });
    return out;
  }

  return {
    CATEGORY: CATEGORY,
    AREA_CATEGORY: AREA_CATEGORY,
    AREA_EFFECT: AREA_EFFECT,
    areaCategoryEffect: areaCategoryEffect,
    promotedOverrides: promotedOverrides,
    promotedAreaOverrides: promotedAreaOverrides,
    areaEffects: areaEffects,
    entryMappingKey: entryMappingKey,
    applyToTrustedEntries: applyToTrustedEntries,
    misrouteSuppressKeys: misrouteSuppressKeys,
  };
});
