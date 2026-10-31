'use strict';

// THE STATION'S OWN FACTS, IN ONE PLACE (#998, spec #996).
//
// Packages addressed to the station itself (23000 N 7th Ave, Phoenix AZ 85027)
// arrive on Route 103, which is a Flagged Work Area, so every one of them lands
// in the IBNO Coder's Needs Review list on every drop. They are not IBNO work.
// The Station pane pulls them out, and this module is where the facts it needs
// live: which station, what its address is, which strings are known-messy
// spellings of that address, which route the packages ride in on, and how the
// copy text signs off.
//
// WHY A MODULE AND NOT SEVEN STRING LITERALS: spec #996 has later tickets that
// reuse these facts (a settings editor, the copy button, Address Catcher's own
// exclusion). One home means adding an alias fixes every consumer at once, and
// the drift-guard chain in CLAUDE.md's Code Architecture section is exactly the
// hazard this avoids.
//
// THE SAVED-LIST OVERRIDE IS READ, NOT WRITTEN, IN THIS TICKET. `load(saved)`
// takes whatever is in the tool's storage under STORAGE_KEY and folds it over
// the defaults, in the SAME shape the Flagged Work Areas saved list uses
// (`ibno_flagged_areas`): a device that has saved its own config keeps it, and
// a shipped default never overwrites it. #998 ships defaults only — no editor
// exists yet, so on every real device today `load(null)` is what runs. The
// shape is here so the later editor ticket has nothing to invent, and so a
// device that saved a config from a FUTURE build is not broken by this one.
//
// ROUTE 103 IS A HINT, NEVER THE RULE. It is carried here because Tyler reads
// it, and deliberately not consumed by IbnoRules.isStationPackage: a neighbor
// on 103 must stay in Needs Review, and a station package arriving on another
// route must still count. See spec #996 story 10.
//
// Dual-loadable with no build step:
// - Browser: window.StationConfig
// - Node:    require('./lib/station-config')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.StationConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // The tool storage key the override is read from. Same naming family as
  // `ibno_flagged_areas`, and read through the same toolStorage helper.
  const STORAGE_KEY = 'ibno_station_config';

  // STATION 849 / NPHO, Phoenix AZ. Hard-coded so the feature works on a fresh
  // device with nothing typed (spec #996 story 31).
  const DEFAULTS = {
    stationNumber: '849',
    stationName: 'NPHO',
    street: '23000 N 7th Ave',
    zip: '85027',
    // Known-messy spellings that the street match does not already fold. Ships
    // EMPTY on purpose: every variant seen so far (23000 N 7TH AVE, 23000 North
    // 7th Avenue, with a suite, missing city) already folds through the address
    // normalizer, and a speculative alias can only over-match — which silently
    // HIDES real IBNO work, the one failure this feature must not have.
    aliases: [],
    // Route 103. A hint for the reader; not part of the predicate.
    route: '103',
    // The last line of the Teams copy text (a later ticket builds the button).
    // Editable later so it reads the way Tyler actually talks.
    closingLine: 'Let me know which ones you find.',
  };

  function str(v) { return String(v == null ? '' : v).trim(); }

  // aliasList(value) -> a clean array of alias strings.
  //
  // Accepts an array (the saved shape) or a newline/comma separated string (what
  // a textarea editor will hand over, exactly as saveSettings() splits the
  // Flagged Work Areas box today), so the later editor ticket needs no parsing
  // of its own. Blanks and duplicates are dropped; order is preserved.
  function aliasList(value) {
    let raw;
    if (Array.isArray(value)) raw = value;
    else if (typeof value === 'string') raw = value.split(/[\n,]+/);
    else return null;
    const seen = Object.create(null);
    const out = [];
    raw.forEach(function (v) {
      const s = str(v);
      if (!s || seen[s.toUpperCase()]) return;
      seen[s.toUpperCase()] = true;
      out.push(s);
    });
    return out;
  }

  // normalize(saved) -> a complete config, defaults filled in for anything the
  // saved object does not carry.
  //
  // FIELD BY FIELD, NEVER WHOLESALE. A saved config written by an older or
  // newer build may be missing keys, and a wholesale "saved wins" would hand
  // back a config with no zip — which would make the predicate's zip gate
  // compare against '' and match every street in the country. Each field falls
  // back on its own, and a BLANK saved value falls back too (an editor's empty
  // box means "I did not set this", never "match nothing").
  //
  // `aliases` is the one field where empty is a real answer: clearing the alias
  // box must actually clear it, so an array (even an empty one) wins, and only
  // a missing/unusable value falls back to the default.
  function normalize(saved) {
    const s = (saved && typeof saved === 'object' && !Array.isArray(saved)) ? saved : {};
    const aliases = aliasList(s.aliases);
    return {
      stationNumber: str(s.stationNumber) || DEFAULTS.stationNumber,
      stationName:   str(s.stationName)   || DEFAULTS.stationName,
      street:        str(s.street)        || DEFAULTS.street,
      zip:           str(s.zip)           || DEFAULTS.zip,
      aliases:       aliases === null ? DEFAULTS.aliases.slice() : aliases,
      route:         str(s.route)         || DEFAULTS.route,
      closingLine:   str(s.closingLine)   || DEFAULTS.closingLine,
    };
  }

  // load(saved) -> the config this device should use. `saved` is whatever the
  // caller read out of toolStorage under STORAGE_KEY (null when nothing is
  // saved, which is every device today).
  function load(saved) { return normalize(saved); }

  // defaults() -> a fresh copy of the shipped 849 config. Callers may mutate
  // what they get back without poisoning the next reader.
  function defaults() { return normalize(null); }

  return {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    aliasList: aliasList,
    normalize: normalize,
    load: load,
    defaults: defaults,
  };
});
