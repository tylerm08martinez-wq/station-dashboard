'use strict';

// Writeups logic (issue #1091, spec #1090, design
// docs/superpowers/specs/2026-10-30-writeups-design.md).
//
// Every rule and every word of a drafted Workday writeup lives here. The page
// (writeups.html) is view and wiring only: it collects the admin, incidents,
// checked ids and choices, calls draft(), and paints what comes back.
//
// PEOPLE/DISCIPLINE TIER (CLAUDE.md "Development Workflow"). A wrong sentence
// here can end up in a real Workday document about a real person. These rules
// follow from that and are not negotiable:
//   - Admins are non-package handlers. Every Discipline Details text ends with
//     the ONE canonical POLICY-010 citation below. HMR-057 never appears.
//   - Minutes late are computed from the two times, never typed, and there is
//     no grace-period sentence (the grace period is unknown; a wrong one is
//     worse than none).
//   - PROTECTED SICK TIME (#1093, ADR 0004). A call-off marked Protected Sick
//     Time is never drafted into a Notice and never counts toward any pattern.
//     One predicate, TimeOff.isProtectedSick() (the same one the attendance
//     rules read), decides both, so the two can never disagree. The pattern
//     counts come from lib/attendance-rules.js, which holds protected time out
//     of every tally.
//   - "Habitual" is Tyler's call. The toggle starts off; the page only says
//     when the checked incidents meet the house standard, worded as counts,
//     never as "writeup due".
//   - SICK EARLY DEPARTURES (#1094). Every "Left early (sick)" is Protected
//     Sick Time (no toggle). It never counts toward any pattern, never feeds
//     the habitual note, and is never drafted into a Notice or Final Notice.
//     Its only document is a Documented Discussion of at least two sick
//     early departures alone, which states dates, times and time missed and
//     nothing about why. Saved, it is tagged sickPattern and never becomes
//     prior discipline in any other writeup. Medical words warn on EVERY
//     draft; reason and note words on any draft with protected time ticked
//     (MEDICAL_LANGUAGE, SICK_REASON_LANGUAGE). See "Sick time" below.
//
// THE SEAM: draft(input) is pure. No DOM, no storage, no clock: "today" is an
// input. Later tickets extend it rather than reshape it:
//   #1092 history -> suggestion, Related Disciplinary Actions, prior discipline
//         sentence, Final Notice (done: see "History and the suggestion")
//   #1093 Call-off / NCNS kinds, the 30-day pattern line, the habitual toggle
//         (done: add a kind to INCIDENT_KINDS and its wording to WORDING)
//   #1094 Documented Discussion and the sick early-departure pattern
//         (done: DOC_TYPES.discussion, the sickearly kind, SICK_LANGUAGE)
//   #1095 Performance kind (done: the performance kind, PERFORMANCE_*, the
//         insubordination check; see "Performance")
//   #1096 hand edits and the text checks (done: `edits` replaces a box's
//         generated text, and every check judges that final text whatever
//         is ticked; see "Sentences", "Wrong citation", "Date consistency")
//
// Dual-loadable with no build step:
// - Browser: window.Writeups (load lib/time-off.js and lib/attendance-rules.js
//            first; both are required)
// - Node:    require('./lib/writeups')

(function (root, factory) {
  // The 30-day house-standard counts come from lib/attendance-rules.js (ADR
  // 0004), never from a re-implementation here.
  const TimeOff = (root && root.TimeOff) ||
    (typeof require === 'function' ? require('./time-off') : null);
  const AttendanceRules = (root && root.AttendanceRules) ||
    (typeof require === 'function' ? require('./attendance-rules') : null);
  const api = factory(AttendanceRules, TimeOff);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Writeups = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (AttendanceRules, TimeOff) {
  if (!TimeOff) throw new Error('Writeups requires lib/time-off');
  if (!AttendanceRules) throw new Error('Writeups requires lib/attendance-rules (and lib/time-off)');

  // ── Fixed wording (one constant each) ────────────────────────────────────

  // The one canonical citation. Every Discipline Details text ends with it.
  const CITATION = 'This is a violation of FedEx Acceptable Conduct, POLICY-010.';

  // Next Steps default, from Tyler's 08/2026 writeups. {name} is the naming
  // choice. They/their throughout: the admin record carries no pronoun.
  // A Documented Discussion (#1094) puts these two sentences in two boxes:
  // Required Corrective Action and Consequences.
  const EXPECTATION = '{name} is expected to be at work the days and shifts they are scheduled, ' +
    'and in their assigned work area at the start of each shift.';
  const CONSEQUENCE = 'Additional unexcused absences, ' +
    'tardiness, or no call no shows within the next 30 days will result in further disciplinary ' +
    'action, up to and including termination.';
  const NEXT_STEPS_DEFAULT = EXPECTATION + ' ' + CONSEQUENCE;
  // A performance writeup does not warn about absences. One constant, used in
  // Next Steps and in the Documented Discussion Consequences box (#1107).
  const PERFORMANCE_CONSEQUENCE = 'Failure to do so may result in further disciplinary action, up to and ' +
    'including termination.';

  // NCNS fact, verbatim from the spec. {name} is the naming choice.
  const NCNS_FACT = '{name} did not report to the scheduled shift and did not inform management of the ' +
    'absence beforehand.';

  // Why a checked Protected Sick Time incident is left out of the draft. The
  // kind comes from the record ("Call-off is Protected Sick Time. ...").
  const PROTECTED_NOT_DRAFTED = 'is Protected Sick Time. It is never drafted into a Notice and never ' +
    'counts toward a pattern.';

  // ── Performance (#1095) ──────────────────────────────────────────────────
  //
  // A performance writeup says what an admin was INSTRUCTED to do, and when,
  // then each time it was MISSED (Appointment Packages not handled correctly,
  // Overgoods not worked as instructed). Two entry roles share one kind:
  //   - "Instruction": the date and what was instructed (the first occurrence);
  //     it completes "{Name} was instructed to ...".
  //   - "Miss": the date and what was missed, typed as the sentence it should
  //     read ("Sam did not scan ..."), written as typed after "On {date},".
  // Tyler ticks ONE Instruction and at least one Miss on or after its date.
  //
  // THE WORD "INSUBORDINATION" NEVER APPEARS in generated text. POLICY-010 lists
  // insubordination as "the willful refusal to follow work instructions or
  // perform assigned work in a timely manner without valid reason"
  // (policies/HR Policy_ - Policy - FEC 003 Acceptable Conduct (Canada & United
  // States).md). Repeated mistakes are not a willful refusal, and the word
  // charges a person with something the facts do not show. No template here
  // uses it, and a check warns when it is in any box of a Performance draft,
  // typed into an entry or hand-edited.
  //
  // THE CITATION STAYS POLICY-010, one constant (CITATION). Whether performance
  // should cite POLICY-031 (Performance Improvement, a related policy POLICY-010
  // lists) is an unresolved open item in the design spec; nothing here cites it.
  //
  // A Performance draft is never mixed with attendance kinds: a Late and an
  // Instruction ticked together draft the Late and leave the Performance
  // entries out, with the reason (PERFORMANCE_NOT_MIXED).
  const PERFORMANCE_DOCUMENTED_AS = 'This is being documented as a performance issue.';
  // Next Steps / Required Corrective Action: the instruction becomes the
  // expectation. {name} is the naming choice, {instruction} the typed text.
  // No "every shift" is added: Tyler adds it by hand when the instruction is a
  // standing one. The stop comes from withStop so "by 4 a.m." is not doubled.
  const PERFORMANCE_EXPECTATION = '{name} is expected to {instruction}';
  const PERFORMANCE_NOT_MIXED = 'is drafted on its own, never mixed with attendance incidents. ' +
    'Untick the attendance incidents to draft it.';
  const INSUBORDINATION_WARNING = 'A performance writeup never says "insubordination": POLICY-010 means a willful ' +
    'refusal to follow work instructions, and repeated mistakes are not that. State the facts instead.';

  // ── Sick time (#1094) ────────────────────────────────────────────────────
  //
  // Paid Sick Time, local copy (policies/HR Policy_ - Policy - FEC 003 Paid
  // Sick Time (United States).md). The lines this section rests on:
  //
  //   "Non-package handler employees do not earn sick time but may utilize
  //    sick time as needed, as long as the company is notified in a timely
  //    manner, and such sick time is not habitual."  (Paid Sick Time Use,
  //    Locations Where Paid Sick Leave Is Required By Law)
  //   "In locations where paid sick leave is required by law, sick time must
  //    be treated as protected leave. FedEx managers cannot ask the employee
  //    to provide details about the medical condition or personal situation
  //    that led to the use of sick time. Managers cannot deny an employee the
  //    right to use paid sick time, nor can they discharge, threaten to
  //    discharge, demote, suspend, or in any manner discriminate or retaliate
  //    against an employee."  (Employee Rights, lines 1456-1461)
  //   "Employees who are absent from work without notifying the company as
  //    required, habitually late, habitually absent, or extend a leave of
  //    absence without authorization, may be subject to Policy - FEC 003
  //    Acceptable Conduct (Canada & United States)."  (lines 1462-1464)
  //   "Management should not ask employees to provide doctors' notes or
  //    reasonable documentation to support the use of sick time; however,
  //    FedEx reserves the right to request a doctor's note or reasonable
  //    documentation for absences of three consecutive days or longer."
  //   "Management cannot request the employee provide documentation that
  //    contains medical information or specific reasons as to why the
  //    employee requested or used sick time."  (Documentation, 1466-1474)
  //
  // So (Tyler, 2026-10-30): a HABITUAL pattern of sick early departures gets
  // a Documented Discussion, on the policy's own hook ("habitually absent ...
  // may be subject to" Acceptable Conduct), stating facts only: dates,
  // scheduled end, clock-out and time missed. Never a reason, never a medical
  // word, never a note, documentation or accommodation. It is habitual by
  // definition (no toggle). Nothing else ever counts or drafts a sick early
  // departure.

  const SICK_DOCUMENTED_AS = 'This pattern of leaving before the end of the scheduled shift is being ' +
    'documented as habitual absence.';
  // Required Corrective Action and Consequences of a sick-pattern Documented
  // Discussion. Protected time is never called "unexcused", and "may" follows
  // the policy's own "may be subject to".
  const SICK_EXPECTATION = '{name} is expected to be at work the days and shifts they are scheduled, ' +
    'through the scheduled end of each shift.';
  const SICK_CONSEQUENCE = 'Continued habitual absence may result in further disciplinary action, up to ' +
    'and including termination.';
  // Why a ticked sick early departure is left out. The kind comes from the record.
  const SICK_NOT_IN_NOTICE = 'is Protected Sick Time. It belongs only in a Documented Discussion, and is ' +
    'never drafted into a Notice or counted toward a pattern.';
  // D1 (review round 1): at least two sick early departures make a pattern.
  const SICK_PATTERN_MIN = 2;
  // The minimum can be raised in Settings (#1116), never lowered below 2.
  function sickNotAPattern(min) {
    return 'is Protected Sick Time. ' + (min > SICK_PATTERN_MIN
      ? 'Fewer than ' + min + ' sick early departures are not a pattern under Settings'
      : 'A single sick early departure is not a pattern') +
      ', so nothing is drafted. A sick-pattern Documented Discussion needs at least ' + min + ' sick early departures.';
  }
  const SICK_NOT_MIXED = 'is Protected Sick Time. It is drafted only in a Documented Discussion of sick ' +
    'early departures alone. Untick the other incidents to draft it.';

  // THE SICK-LANGUAGE CHECK: two lists, one constant each (design "Checks";
  // review round 1, D3).
  //
  //   MEDICAL_LANGUAGE runs on EVERY draft, whatever is ticked: a Late Notice
  //     that says "left because they had a doctor appointment" puts medical
  //     detail about protected time into a writeup, and that warns.
  //   SICK_REASON_LANGUAGE runs only on a SICK-RELATED draft (a sick early
  //     departure or a Protected Sick Time call-off is ticked): reason words
  //     ("because", "due to", "family", "personal", "emergency") and note and
  //     feeling words. Tyler's real Late and NCNS writeups legitimately say
  //     "because", so these stay quiet there.
  //
  // Each entry is a word or phrase, matched as a whole word with an optional
  // plural or possessive ("note" finds notes and note's); a trailing * makes
  // it a stem ("doctor*" finds doctors, doctor's, doctored). A phrase's spaces
  // also match a hyphen ("urgent care", "urgent-care"). Lower-case entries
  // match in any case; MEDICAL_ABBREVIATIONS match ONLY in capitals, so "er"
  // and "md" inside or as ordinary words never match.
  //
  // Never a hit: a station term (STATION_TERMS: "appointment package", a
  // GLOSSARY term) and the admin's own name tokens, as typed in the admin's
  // name (an admin called "Doc" or "Ill" never trips the check on text that
  // names them; "felt ill" in lower case still does).
  //
  // The text is normalized first (see sickNormalize): NFKC, every format
  // character removed, accents and combining marks removed, Cyrillic and
  // Greek lookalike letters read as Latin, curly apostrophes made straight,
  // and a word hyphenated across a line break read both ways.
  const MEDICAL_LANGUAGE = [
    // doctors and where they work
    'doctor*', 'dr', 'doc', 'physician*', 'nurse*', 'clinic*', 'hospital*', 'urgent care',
    'emergency room', 'dentist*', 'dental', 'ambulance*', 'pharmac*', 'telehealth',
    // notes from them (the bare word "note" is a sick-draft word below)
    'sick note', 'fit note', 'released to work', 'work restriction*',
    // medical words and illness detail
    'medic*', 'meds', 'diagnos*', 'illness*', 'ill', 'sick*', 'unwell', 'symptom*', 'migraine*',
    'headache*', 'flu', 'influenza', 'covid*', 'fever*', 'virus*', 'infection*', 'nause*',
    'vomit*', 'threw up', 'throwing up', 'dizz*', 'stomach*', 'pain', 'allerg*', 'seizure*',
    'cancer*', 'chemo*', 'surgery', 'surgeries', 'surgical', 'surgeon*', 'outpatient*',
    'pregnan*', 'miscarriage*', 'went into labor', 'in labor', 'prescri*', 'therap*', 'physio*',
    'rehab*', 'vaccin*', 'blood work', 'x ray*', 'checkup*', 'bed rest', 'tested positive',
    'mental', 'anxiety', 'depress*',
    // #1106: everyday spellings. Safe on every draft: none is an ordinary word at the station.
    'gyn*', 'obgyn', 'psychiatr*', 'chiropract*', 'ultrasound*', 'diabet*', 'asthma', 'blood pressure',
    'sore throat', 'quarantin*', 'hosp', 'er visit',
    // appointments, accommodations and leave
    'appointment*', 'appt*', 'accommodat*', 'fmla', 'leave of absence', 'on leave',
  ];
  // Capitals only (case-sensitive), whole word.
  const MEDICAL_ABBREVIATIONS = ['OB/GYN', 'OB', 'E.R.', 'E.R', 'E R', 'ER', 'PCP', 'Rx', 'MD', 'PT', 'MRI', 'LOA', 'FMLA', 'ADA'];
  const SICK_REASON_LANGUAGE = [
    // a reason
    'because', 'due to', 'family emergency', 'family', 'personal reasons', 'personal', 'emergency',
    // notes and documentation (Documentation, lines 1466-1474)
    'note', 'note from', 'documentation', 'proof', 'excuse*',
    // feelings and everyday words that read as health detail next to sick time
    'feel', 'feeling*', 'felt', 'condition*', 'health*', 'treatment*', 'injur*', 'disab*',
    // #1106: ambiguous in ordinary text (a cramped dock, grammatical contractions, a route
    // specialist), so they warn only on a sick-related draft.
    'cramp*', 'contraction*', 'specialist*',
  ];
  const SICK_LANGUAGE_WARNING = 'A sick-related document states dates and times only: no reason, no medical words, ' +
    'and no mention of notes or accommodations.';
  const MEDICAL_LANGUAGE_WARNING = 'Medical details never go in a writeup: sick time is protected leave. ' +
    'State the facts of the incident only.';
  // Every word either check can name (the two case-insensitive lists).
  const SICK_LANGUAGE = MEDICAL_LANGUAGE.concat(SICK_REASON_LANGUAGE);
  // Never a hit: station terms (GLOSSARY "Appointment Package").
  const STATION_TERMS = ['appointment package'];

  function termSource(term, caseSensitive) {
    const stem = /\*$/.test(term);
    const words = term.replace(/\*$/, '').split(' ').map(function (w) {
      return w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    });
    return '(?<![\\p{L}\\p{N}])' + words.join('[\\s\\-]+') +
      (stem ? "[\\p{L}\\p{N}']*" : (caseSensitive ? "(?:s|'s|')?" : "(?:e?s)?(?:'s|')?") + '(?![\\p{L}\\p{N}])');
  }
  function termsRe(terms, flags, caseSensitive) {
    return new RegExp(terms.map(function (t) { return termSource(t, caseSensitive); }).join('|'), flags);
  }
  const MEDICAL_RE = termsRe(MEDICAL_LANGUAGE, 'giu', false);
  const MEDICAL_ABBR_RE = termsRe(MEDICAL_ABBREVIATIONS, 'gu', true);
  const SICK_REASON_RE = termsRe(SICK_REASON_LANGUAGE, 'giu', false);
  const STATION_TERMS_RE = termsRe(STATION_TERMS, 'giu', false);

  // Cyrillic and Greek letters that look like Latin ones. Written as \u
  // escapes (an editor can turn a literal one back into Latin unseen).
  const LOOKALIKES = {
    // Cyrillic lower: a e o p c y x i j s d h k t v
    '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y',
    '\u0445': 'x', '\u0456': 'i', '\u0458': 'j', '\u0455': 's', '\u0501': 'd', '\u04bb': 'h',
    '\u043a': 'k', '\u0442': 't', '\u0475': 'v',
    // Cyrillic capitals: A B E K M H O P C T X Y I J S
    '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041a': 'K', '\u041c': 'M', '\u041d': 'H',
    '\u041e': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0425': 'X', '\u0423': 'Y',
    '\u0406': 'I', '\u0408': 'J', '\u0405': 'S',
    // Greek lower: o v a i k p t u x
    '\u03bf': 'o', '\u03bd': 'v', '\u03b1': 'a', '\u03b9': 'i', '\u03ba': 'k', '\u03c1': 'p',
    '\u03c4': 't', '\u03c5': 'u', '\u03c7': 'x',
    // Greek capitals: A B E Z H I K M N O P T Y X
    '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I',
    '\u039a': 'K', '\u039c': 'M', '\u039d': 'N', '\u039f': 'O', '\u03a1': 'P', '\u03a4': 'T',
    '\u03a5': 'Y', '\u03a7': 'X',
  };
  const LOOKALIKE_RE = new RegExp('[' + Object.keys(LOOKALIKES).join('') + ']', 'g');
  // A hyphen or dash (ASCII, soft hyphen, U+2010-U+2015) then a line break.
  const LINE_DASH_RE = /[-\u00ad\u2010-\u2015]([ \t]*\r?\n)/g;

  // text -> the text the sick-language lists are matched against.
  function sickNormalize(text) {
    return String(text == null ? '' : text)
      .normalize('NFKC')
      // A soft hyphen or dash at a line break is a real hyphen there; it must
      // survive the format-character strip so the split word is rejoined.
      .replace(LINE_DASH_RE, '-$1')
      .replace(/\p{Cf}/gu, '')
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(LOOKALIKE_RE, function (c) { return LOOKALIKES[c]; })
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      // Dotless i (U+0131) survives NFKD; fold it so "hosp\u0131tal" is still caught (#1119 round 2).
      .replace(/\u0131/g, 'i');
  }

  // The admin's name tokens as typed ("Doc", "Ill"), normalized the same way.
  function nameTokens(admin) {
    return sickNormalize(admin && admin.name).split(/[^\p{L}\p{N}']+/u).filter(function (t) {
      return t.replace(/'/g, '') !== '';
    });
  }

  // A hyphen at a line break is read both ways: a split word rejoined
  // ("doc-\ntor") and a compound kept ("non-\nmedical"). Shared by the
  // sick-language and the insubordination checks.
  const LINE_HYPHEN_RE = /(\p{L})-[ \t]*\r?\n[ \t]*(\p{L})/gu;
  function lineHyphenVariants(t) {
    return [t.replace(LINE_HYPHEN_RE, '$1$2'), t.replace(LINE_HYPHEN_RE, '$1-$2')];
  }

  // sickWords(text, opts) -> the distinct words found (normalized; lower
  // case except capitals-only abbreviations). opts.reason adds the sick-draft
  // list; opts.names are name tokens to ignore (case-sensitive).
  //
  // Settings (#1116) can ADD to both sides, never take away: opts.extra is
  // Tyler's extra medical words (checked on every draft, like the built-in
  // list, which always runs), and opts.allow his extra station phrases (exact
  // phrases that never warn; see stationPhraseProblem for why a bare medical
  // word can never be one).
  const extraReCache = new Map();
  function extraTermsRe(terms) {
    const list = (terms || []).filter(function (t) { return typeof t === 'string' && t !== ''; });
    if (!list.length) return null;
    const key = JSON.stringify(list);
    if (!extraReCache.has(key)) extraReCache.set(key, termsRe(list, 'giu', false));
    return extraReCache.get(key);
  }
  function sickWords(text, opts) {
    const o = opts || {};
    let t = sickNormalize(text).replace(STATION_TERMS_RE, ' ');
    const allowRe = extraTermsRe(o.allow);
    if (allowRe) t = t.replace(allowRe, ' ');
    (o.names || []).forEach(function (n) {
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp("(?<![\\p{L}\\p{N}])" + esc + "(?:'s|')?(?![\\p{L}\\p{N}])", 'gu'), ' ');
    });
    const res = [[MEDICAL_RE, true], [MEDICAL_ABBR_RE, false]];
    const extraRe = extraTermsRe(o.extra);
    if (extraRe) res.push([extraRe, true]);
    if (o.reason) res.push([SICK_REASON_RE, true]);
    const found = [];
    lineHyphenVariants(t).forEach(function (variant) {
      res.forEach(function (pair) {
        const re = pair[0];
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(variant)) !== null) {
          let w = m[0].replace(/\s+/g, ' ');
          if (pair[1]) w = w.toLowerCase();
          if (found.indexOf(w) === -1) found.push(w);
        }
      });
    });
    return found;
  }

  // Reason/Rating when the text covers a habitual pattern or more than one
  // kind (spec #1090 "Reason / Rating mapping": Habitual or sick pattern ->
  // Attendance / Attendance).
  const PATTERN_PICKS = { reason: 'Attendance', rating: 'Attendance' };

  // Final Notice adds this to Next Steps (design "Wording"). It goes in Next
  // Steps, not Discipline Details, because nothing but "Prior discipline:"
  // sentences may follow the citation.
  const FINAL_NOTICE_LINE = 'This is a final notice.';

  // The history panel's words when this device holds no writeup for the
  // admin. An empty device must never read as a clean record.
  const NO_HISTORY_MESSAGE = 'No writeups recorded on this device. Add past ones from Workday.';

  // The suggestion line when history holds nothing: still a Notice, but said
  // to rest on nothing.
  const NO_HISTORY_REASON = 'Based on no history: no writeups are recorded on this device.';

  // A Final Notice in the last 12 months. The page names the policy's next
  // step, drafts nothing for it and pre-selects nothing. {date} is MM/DD/YYYY.
  const TERMINATION_STEP = 'Final Notice on {date}: next step under policy is termination, decided by HR and management.';

  // THE WRONG CITATION (#1096). HMR-057 is the PACKAGE HANDLER attendance
  // process; admins are non-package handlers, and 11 of 19 real writeups cited
  // it anyway. Case-insensitive, and loose on what sits between the prefix and
  // the number: a short run (up to 5) of anything that is not a letter or a
  // digit, so "hmr-057", "Policy - 057", "HMR (057)", "HMR/057", "HMR-\n057"
  // (wrapped) and every Unicode dash or invisible joiner a copy can carry
  // (non-breaking, soft, minus, fullwidth, zero-width space) all match. An
  // optional "No." / "number" and a dotted "H.M.R." are read too.
  //   - With the HMR prefix, 57 or 057 ("HMR Policy No. 57").
  //   - With the bare "policy" prefix, the number needs its leading zero
  //     ("Policy No. 057") or a dash joined straight to the word ("policy-57"),
  //     so prose such as "Under the policy 57 minutes is too many" is not it.
  // No letter or digit before the prefix and no digit after the number, so
  // shmr-057, HMR-0570 and HMR-157 are not it. The check replaces the whole
  // sentence when it holds no facts, and only the citation otherwise (see
  // "Wrong citation"): every wrong citation in the real set carries a
  // "which states ..." paraphrase of the package handler process.
  //
  // WRONG_CITATION_RE is exported NOT global, so repeated .test() calls agree;
  // the scanner below uses its own global copy.
  const CITE_GAP = '[^\\p{L}\\p{N}]{0,5}';
  const CITE_NUMBER_WORD = '(?:(?:no|nr|num|number)\\.?' + CITE_GAP + ')?';
  const CITE_DASH = '[\\-\\u00ad\\u2010-\\u2015\\u2212\\ufe58\\ufe63\\uff0d]';
  const CITE_INVISIBLE = '[\\u00ad\\u200b-\\u200d\\u2060\\ufeff]*';
  // Round 2: spaced letters ("H M R-057", "H. M. R. 057") and, with the hmr
  // prefix only, a letter O typed for the zero ("HMR-O57").
  // #1119 review round 1: the letters may be split by up to three spaces,
  // non-breaking spaces or dashes ("H  M  R 057", "H-M-R-057", "pol-icy 057"),
  // and the digits by up to two spaces or dashes ("HMR-0 57"). A digit of
  // another kind between them still ends it: "HMR 157" is not it.
  const CITE_LETTER_SPACE = '(?:[\\s\\-\\u2010-\\u2015\\u2212\\ufe58\\ufe63\\uff0d]{0,3})';
  const CITE_DIGIT_SPACE = '(?:[ \\t\\u00a0\\-\\u2010-\\u2015\\u2212]{0,2})';
  function citeWord(word) {
    return word.split('').join('\\.?' + CITE_LETTER_SPACE);
  }
  const WRONG_CITATION_SOURCE = '(?<![\\p{L}\\p{N}])(?:' +
    'h\\.?' + CITE_LETTER_SPACE + 'm\\.?' + CITE_LETTER_SPACE + 'r\\.?' + CITE_GAP + '(?:policy' + CITE_GAP + ')?' + CITE_NUMBER_WORD +
      '(?:[0o]' + CITE_DIGIT_SPACE + ')*5' + CITE_DIGIT_SPACE + '7' +
    '|' + citeWord('policy') + '(?:' + CITE_GAP + CITE_NUMBER_WORD + '0(?:' + CITE_DIGIT_SPACE + '0)*' + CITE_DIGIT_SPACE +
      '5' + CITE_DIGIT_SPACE + '7|' + CITE_INVISIBLE + CITE_DASH + CITE_INVISIBLE + '57)' +
    ')(?!\\p{N})';
  const WRONG_CITATION_RE = new RegExp(WRONG_CITATION_SOURCE, 'iu');

  // text -> every wrong-citation match, in order ({ index, end, raw }), with
  // index and end in the text AS TYPED.
  //
  // #1119 review round 1: the pattern is matched against the text as typed
  // AND against its sickNormalize reading (NFKC, format characters and
  // combining marks stripped, Cyrillic and Greek lookalikes folded), so a
  // Cyrillic H, a soft hyphen or zero-width space inside "HMR", fullwidth
  // letters or digits, and an accent on a letter are all found. The
  // normalized reading is built one character at a time with a map back to
  // the typed text, so Replace still cuts exactly the typed citation and
  // keeps the facts around it. Overlapping matches from the two readings are
  // one match.
  function citeRaw(s) {
    const re = new RegExp(WRONG_CITATION_SOURCE, 'giu');
    const out = [];
    let m;
    while ((m = re.exec(s)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out.push({ index: m.index, end: m.index + m[0].length });
    }
    return out;
  }
  // text -> { text, from, to }: sickNormalize's reading, where normalized
  // character j came from typed characters from[j] up to to[j] (exclusive).
  function normalizeMapped(s) {
    let t = '';
    const from = [];
    const to = [];
    let i = 0;
    while (i < s.length) {
      const len = s.codePointAt(i) > 0xffff ? 2 : 1;
      const ch = s.slice(i, i + len);
      let piece;
      // A soft hyphen or dash at a line break is a real hyphen there.
      if (/[\-\u00ad\u2010-\u2015]/.test(ch) && /^[ \t]*\r?\n/.test(s.slice(i + len))) piece = '-';
      else {
        piece = ch.normalize('NFKC').replace(/\p{Cf}/gu, '').normalize('NFKD').replace(/\p{M}/gu, '')
          .replace(LOOKALIKE_RE, function (c) { return LOOKALIKES[c]; })
          .replace(/[\u2018\u2019\u02bc]/g, "'");
      }
      for (let k = 0; k < piece.length; k++) { from.push(i); to.push(i + len); }
      t += piece;
      i += len;
    }
    return { text: t, from: from, to: to };
  }
  function wrongCitationMatches(text) {
    const s = String(text == null ? '' : text);
    const found = citeRaw(s);
    const n = normalizeMapped(s);
    if (n.text !== s) {
      citeRaw(n.text).forEach(function (m) { found.push({ index: n.from[m.index], end: n.to[m.end - 1] }); });
    }
    found.sort(function (a, b) { return a.index - b.index || b.end - a.end; });
    const out = [];
    found.forEach(function (m) {
      const last = out[out.length - 1];
      if (last && m.index < last.end) { last.end = Math.max(last.end, m.end); return; }
      out.push({ index: m.index, end: m.end });
    });
    out.forEach(function (m) { m.raw = s.slice(m.index, m.end); });
    return out;
  }

  // text with every wrong citation cut out, each replaced by `by`.
  function withoutCitations(text, by) {
    const s = String(text == null ? '' : text);
    let out = '';
    let at = 0;
    wrongCitationMatches(s).forEach(function (m) { out += s.slice(at, m.index) + by; at = m.end; });
    return out + s.slice(at);
  }

  function hasWrongCitation(text) {
    return wrongCitationMatches(text).length > 0;
  }

  // THE WORD "INSUBORDINATION" (#1095). Read after sickNormalize, so case,
  // invisible characters, accents and Cyrillic or Greek lookalike letters
  // cannot hide it; a hyphen or space inside it ("in-subordination") is read
  // too. "Insubordinate" is the same charge.
  //
  // "in subordinate roles" is ordinary English, so a plain space is NOT a join:
  // the word is "in" then (optionally) a hyphen or dash, any Unicode dash
  // included, then "subord". The stem catches "insubord." and "insubordinate".
  // A hyphen or dash at a line break is read both ways, as the sick-language
  // check does (lineHyphenVariants). A dotless i (U+0131) is an i.
  const INSUBORDINATION_RE = /(?<![\p{L}\p{N}])in(?:\s*[\-\u2010-\u2015]+\s*)?subord/iu;
  function hasInsubordination(text) {
    const t = sickNormalize(text).replace(/\u0131/g, 'i');
    return lineHyphenVariants(t).some(function (v) { return INSUBORDINATION_RE.test(v); });
  }

  // ── Document types and their Workday free-text fields ────────────────────

  // Notice of Deficiency and Final Notice of Deficiency (both w/o PIP) have
  // identical Workday fields; only the form title differs.
  const NOTICE_FIELDS = [
    { id: 'disciplineDetails', label: 'Discipline Details' },
    { id: 'nextSteps', label: 'Next Steps' },
  ];

  // Documented Discussion (Workday "FXG Documented Discussion DA"; fields
  // from the 2023-2024 examples, design "Document types"). No Rating.
  const DISCUSSION_FIELDS = [
    { id: 'incidentDescription', label: 'Incident Detailed Description' },
    { id: 'previousCounseling', label: 'Previous Counseling Given' },
    { id: 'requiredAction', label: 'Required Corrective Action' },
    { id: 'consequences', label: 'Consequences' },
  ];

  // Per type: `citationField` is the box that ends with the one citation
  // (and that the policy-010 check reads); `priorField` is the box that
  // lists prior discipline (and that the prior-discipline check reads).

  const DOC_TYPES = {
    notice: {
      id: 'notice',
      label: 'Notice of Deficiency',
      workdayForm: 'Notice of Deficiency w/o PIP',
      hasRating: true,
      fields: NOTICE_FIELDS,
      citationField: 'disciplineDetails',
      priorField: 'disciplineDetails',
      nextStepsClosing: '',
    },
    final: {
      id: 'final',
      label: 'Final Notice',
      workdayForm: 'Final Notice of Deficiency w/o PIP',
      hasRating: true,
      fields: NOTICE_FIELDS,
      citationField: 'disciplineDetails',
      priorField: 'disciplineDetails',
      nextStepsClosing: FINAL_NOTICE_LINE,
    },
    // Never suggested (the suggestion picks only Notice or Final Notice) and
    // never counted as a Notice. Tyler picks it.
    discussion: {
      id: 'discussion',
      label: 'Documented Discussion',
      workdayForm: 'FXG Documented Discussion DA',
      hasRating: false,
      fields: DISCUSSION_FIELDS,
      citationField: 'incidentDescription',
      priorField: 'previousCounseling',
      nextStepsClosing: '',
    },
  };

  // What a writeup in history can be. A Documented Discussion is drafted
  // (#1094) or backfilled; it never counts as a Notice.
  const HISTORY_TYPES = [
    { id: 'notice', label: 'Notice of Deficiency' },
    { id: 'final', label: 'Final Notice' },
    { id: 'discussion', label: 'Documented Discussion' },
  ];

  // Workday Reason dropdown values seen in the real exports (spec #1090).
  const REASONS = ['Attendance', 'Punctuality', 'No Call No Show', 'Performance', 'Misconduct'];

  function historyType(id) {
    for (let i = 0; i < HISTORY_TYPES.length; i++) {
      if (HISTORY_TYPES[i].id === id) return HISTORY_TYPES[i];
    }
    return null;
  }

  // ── Incident kinds ───────────────────────────────────────────────────────
  //
  // What the page offers in its "Add incident" row, and the fields each kind
  // takes. The page builds its form from this list, so a later kind is added
  // here, not hand-built in the page. `patternType` is the event type
  // lib/attendance-rules.js counts it as (null: never counted). A mixed draft
  // lists its incidents in date order, not in this order.

  const INCIDENT_KINDS = [
    {
      id: 'late',
      label: 'Late',
      reason: 'Punctuality',
      rating: 'Attendance',
      patternType: 'Late',
      habitualWording: true,
      fields: [
        { key: 'scheduledStart', label: 'Scheduled start', type: 'time' },
        { key: 'clockIn', label: 'Clock-in', type: 'time' },
      ],
    },
    {
      id: 'calloff',
      label: 'Call-off',
      reason: 'Attendance',
      rating: 'Attendance',
      patternType: 'Call-off',
      habitualWording: true,
      fields: [
        { key: 'notifiedAt', label: 'Time notified', type: 'time', optional: true },
        { key: 'protectedSick', label: 'Protected Sick Time', type: 'checkbox' },
      ],
    },
    {
      id: 'ncns',
      label: 'NCNS',
      reason: 'No Call No Show',
      rating: 'Attendance',
      patternType: 'NCNS',
      habitualWording: false,
      fields: [
        { key: 'contactedAt', label: 'Later contact (if any)', type: 'time', optional: true },
      ],
    },
    {
      // #1094. EVERY one is Protected Sick Time (alwaysProtectedSick), so it
      // has no toggle. patternType 'Left Early' is lib/time-off's own type,
      // which attendance-rules never counts: two independent layers keep it
      // out of every pattern. discussionOnly: it is drafted only into a
      // Documented Discussion of sick early departures alone.
      id: 'sickearly',
      label: 'Left early (sick)',
      reason: 'Attendance',
      rating: 'Attendance',
      patternType: 'Left Early',
      habitualWording: false,
      alwaysProtectedSick: true,
      discussionOnly: true,
      fields: [
        { key: 'scheduledEnd', label: 'Scheduled end', type: 'time' },
        { key: 'clockOut', label: 'Clock-out', type: 'time' },
        // Review round 1: a clock-out after midnight names its own date, as
        // a Late's punch does. Only Tyler knows the shift crossed midnight
        // (the kind has no scheduled start), so he says so.
        { key: 'clockOutNextDay', label: 'Clock-out was after midnight (next day)', type: 'checkbox' },
      ],
    },
    {
      // #1095. Free facts: it counts toward no attendance pattern (patternType
      // null). The page paints `hint` under the form and builds the `select`
      // from `options`. The two roles are described under "Performance".
      id: 'performance',
      label: 'Performance',
      reason: 'Performance',
      rating: 'Performance',
      patternType: null,
      habitualWording: false,
      hint: 'Performance entries are drafted on their own, with one Instruction and at least one Miss. ' +
        'Do not tick attendance incidents with them.',
      fields: [
        {
          key: 'role',
          label: 'Entry',
          type: 'select',
          options: [
            { value: '', label: 'Choose Instruction or Miss' },
            { value: 'instruction', label: 'Instruction (first occurrence)' },
            { value: 'miss', label: 'Miss' },
          ],
        },
        {
          key: 'text',
          label: 'What was instructed, or what was missed',
          type: 'text',
          placeholder: 'Instruction: scan every package. Miss: write the sentence as it should read',
        },
      ],
    },
  ];

  function kindOf(id) {
    for (let i = 0; i < INCIDENT_KINDS.length; i++) {
      if (INCIDENT_KINDS[i].id === id) return INCIDENT_KINDS[i];
    }
    return null;
  }

  // THE protected-sick predicate is TimeOff.isProtectedSick, the same one the
  // attendance rules use. Drafting and counting both read it (counting through
  // the entry handed to attendance-rules, whose countsTowardTally drops it), so
  // "not in the Notice" and "not in the count" cannot drift apart. Any truthy
  // flag counts as protected: when in doubt, the admin is protected.
  //
  // isProtected(inc) is that predicate over the incident as the rules see it:
  // a kind that is always protected (Left early (sick), #1094) is handed over
  // with protectedSick: true whatever the record holds. Drafting, the list
  // line and the attendance-rules entry all call THIS, never the raw flag.
  function asProtectedView(inc) {
    const kind = kindOf(inc && inc.kind);
    return kind && kind.alwaysProtectedSick ? Object.assign({}, inc, { protectedSick: true }) : inc;
  }
  function isProtected(inc) {
    return TimeOff.isProtectedSick(asProtectedView(inc));
  }
  function isPerformance(inc) {
    return !!(inc && inc.kind === 'performance');
  }
  function isSickEarly(inc) {
    const kind = kindOf(inc && inc.kind);
    return !!(kind && kind.discussionOnly);
  }

  // ── Small formatting helpers ─────────────────────────────────────────────

  const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

  function isIsoDate(s) {
    const m = ISO_DATE_RE.exec(String(s == null ? '' : s));
    if (!m) return false;
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1) return false;
    // A real calendar day: 2026-02-30 and 2026-04-31 do not exist.
    const dt = new Date(Date.UTC(Number(m[1]), month - 1, day));
    return dt.getUTCFullYear() === Number(m[1]) && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
  }

  // 'YYYY-MM-DD' -> a LOCAL Date at midnight (null when invalid). Never
  // new Date('YYYY-MM-DD'): that parses as UTC midnight, which is the evening
  // before in Phoenix, and would shift every 30-day window by a day.
  function localDate(iso) {
    if (!isIsoDate(iso)) return null;
    const m = ISO_DATE_RE.exec(iso);
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  // 'YYYY-MM-DD' -> the next calendar day, same shape ('' when invalid).
  function nextDay(iso) {
    if (!isIsoDate(iso)) return '';
    const m = ISO_DATE_RE.exec(iso);
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
    return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(dt.getUTCDate()).padStart(2, '0');
  }

  // 'YYYY-MM-DD' -> 'MM/DD/YYYY'; '' for anything else.
  function formatDate(iso) {
    if (!isIsoDate(iso)) return '';
    const m = ISO_DATE_RE.exec(iso);
    return m[2] + '/' + m[3] + '/' + m[1];
  }

  function minutesOfDay(hhmm) {
    const m = TIME_RE.exec(String(hhmm == null ? '' : hhmm));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function hasTime(hhmm) {
    return hhmm != null && String(hhmm) !== '';
  }

  // 'HH:MM' (24h, what <input type=time> gives) -> '4:12 AM'.
  function formatTime(hhmm) {
    const mins = minutesOfDay(hhmm);
    if (mins == null) return '';
    const h = Math.floor(mins / 60);
    const mm = String(mins % 60).padStart(2, '0');
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + mm + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  // "a 4:00 AM" but "an 8:00 AM" / "an 11:00 PM".
  function withArticle(timeText) {
    return (/^(8|11):/.test(timeText) ? 'an ' : 'a ') + timeText;
  }

  // Minutes from scheduled start to clock-in. A clock-in up to 12 hours after
  // the start counts as late, so a punch past midnight (11:50 PM start, 12:10
  // AM in) is 20 minutes late, and a punch shortly before the start (including
  // the night before an early start) is 0. null when either time is invalid.
  function minutesLate(scheduledStart, clockIn) {
    const s = minutesOfDay(scheduledStart);
    const c = minutesOfDay(clockIn);
    if (s == null || c == null) return null;
    let diff = c - s;
    if (diff <= -720) diff += 1440;
    if (diff > 720) diff -= 1440;
    return diff > 0 ? diff : 0;
  }

  // True when the punch is on the NEXT calendar day: the clock-in is earlier
  // in the day than the scheduled start, yet still counts as late (11:50 PM
  // start, 12:10 AM in). The incident's date is the SHIFT date.
  function punchIsNextDay(scheduledStart, clockIn) {
    const s = minutesOfDay(scheduledStart);
    const c = minutesOfDay(clockIn);
    return s != null && c != null && c < s && minutesLate(scheduledStart, clockIn) > 0;
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  // Minutes from clock-out to the scheduled end (#1094), the mirror of
  // minutesLate: a clock-out up to 12 hours before the end counts, so a shift
  // ending after midnight (1:00 AM end, out at 11:15 PM) is 105 minutes, and
  // a clock-out at or after the end is 0. null when either time is invalid.
  function minutesMissed(scheduledEnd, clockOut) {
    return minutesLate(clockOut, scheduledEnd);
  }

  // 125 -> '2 hours 5 minutes'; 45 -> '45 minutes'; 120 -> '2 hours'.
  function durationText(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (!h) return plural(m, 'minute');
    return plural(h, 'hour') + (m ? ' ' + plural(m, 'minute') : '');
  }

  function firstName(displayName) {
    const first = String(displayName == null ? '' : displayName).trim().split(/\s+/)[0];
    return first || 'Admin';
  }

  // The naming choice: 'first' (default) or 'admin'.
  function nameFor(admin, naming) {
    if (naming === 'admin') return 'Admin';
    return firstName(admin && admin.name);
  }

  // Replace {name} literally ($& and $1 in a name stay as typed).
  function withName(template, name) {
    return template.replace(/\{name\}/g, function () { return name; });
  }

  // ── Work schedule (#1112) ────────────────────────────────────────────────
  //
  // An admin's scheduled days are an optional list of weekday numbers, 0 =
  // Sunday .. 6 = Saturday (what Date.getDay() answers), on the admin record.
  // Call-off, NCNS and sick-pattern drafts say them in one sentence so the
  // document shows the admin was scheduled the day they missed.
  const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Any input -> the valid days only: integers 0-6, unique, ascending. Junk is
  // dropped, never guessed at, so a damaged list reads as "not set" at worst.
  function cleanWorkDays(days) {
    if (!Array.isArray(days)) return [];
    const seen = {};
    days.forEach(function (d) {
      if (typeof d === 'number' && d >= 0 && d <= 6 && d === Math.floor(d)) seen[d] = true;
    });
    return [0, 1, 2, 3, 4, 5, 6].filter(function (d) { return seen[d]; });
  }

  // 'Sun-Thu' when the days are one contiguous run (a run may wrap the week
  // end: 'Fri-Mon'), a single day alone ('Wed'), else a list in week order
  // ('Sun, Tue, Thu'). '' when there are no valid days.
  function workDaysText(days) {
    const list = cleanWorkDays(days);
    if (!list.length) return '';
    if (list.length === 1) return WEEKDAY_SHORT[list[0]];
    if (list.length === 7) return WEEKDAY_SHORT[0] + '-' + WEEKDAY_SHORT[6];
    const has = {};
    list.forEach(function (d) { has[d] = true; });
    // A run starts on a day whose previous day (circularly) is not scheduled.
    const starts = list.filter(function (d) { return !has[(d + 6) % 7]; });
    if (starts.length === 1) {
      const from = starts[0];
      const to = (from + list.length - 1) % 7;
      return WEEKDAY_SHORT[from] + '-' + WEEKDAY_SHORT[to];
    }
    return list.map(function (d) { return WEEKDAY_SHORT[d]; }).join(', ');
  }

  // 'YYYY-MM-DD' -> 0-6 weekday of that LOCAL calendar day (-1 when invalid).
  function weekdayOf(iso) {
    const dt = localDate(iso);
    return dt ? dt.getDay() : -1;
  }

  // The kinds the schedule line belongs on: an absence (the sick pattern is
  // handled by the draft itself). The kinds the off-schedule check judges.
  function absenceKind(kindId) { return kindId === 'calloff' || kindId === 'ncns'; }
  function offScheduleKind(kindId) { return kindId === 'calloff' || kindId === 'ncns' || kindId === 'sickearly'; }

  const SCHEDULE_LINE = "{name}'s work schedule is {days}.";

  // ── Incidents ────────────────────────────────────────────────────────────

  // validateIncident(incident) -> '' when it can be saved, else one plain
  // sentence saying what is wrong. The page shows it and refuses the save.
  function validateIncident(incident) {
    const inc = incident || {};
    const kind = kindOf(inc.kind);
    if (!kind) return 'Pick an incident kind.';
    if (!isIsoDate(inc.date)) return 'Enter the date.';
    if (kind.id === 'late') {
      if (minutesOfDay(inc.scheduledStart) == null) return 'Enter the scheduled start time.';
      if (minutesOfDay(inc.clockIn) == null) return 'Enter the clock-in time.';
      if (!(minutesLate(inc.scheduledStart, inc.clockIn) > 0)) {
        return 'The clock-in is not after the scheduled start, so this is not a Late.';
      }
    }
    if (kind.id === 'calloff' && hasTime(inc.notifiedAt) && minutesOfDay(inc.notifiedAt) == null) {
      return 'Enter the time you were notified, or leave it blank.';
    }
    if (kind.id === 'ncns' && hasTime(inc.contactedAt) && minutesOfDay(inc.contactedAt) == null) {
      return 'Enter the later contact time, or leave it blank.';
    }
    if (kind.id === 'performance') {
      if (inc.role !== 'instruction' && inc.role !== 'miss') return 'Choose Instruction or Miss.';
      if (perfText(inc.text) === '') {
        return inc.role === 'instruction' ? 'Enter what was instructed.' : 'Enter what was missed.';
      }
    }
    if (kind.id === 'sickearly') {
      if (minutesOfDay(inc.scheduledEnd) == null) return 'Enter the scheduled end time.';
      if (minutesOfDay(inc.clockOut) == null) return 'Enter the clock-out time.';
      if (!(minutesMissed(inc.scheduledEnd, inc.clockOut) > 0)) {
        return 'The clock-out is not before the scheduled end, so this is not an early departure.';
      }
      // After midnight, the clock-out and the end are both on the next day,
      // so the clock-out is earlier in that day than the end.
      if (inc.clockOutNextDay && !(minutesOfDay(inc.clockOut) < minutesOfDay(inc.scheduledEnd))) {
        return 'A clock-out after midnight must be earlier than the scheduled end. Untick "after midnight" if the clock-out was before midnight.';
      }
    }
    return '';
  }

  // describeIncident(incident) -> the one-line summary the incident list shows.
  function describeIncident(incident) {
    const inc = incident || {};
    const kind = kindOf(inc.kind);
    const label = kind ? kind.label : String(inc.kind || '');
    if (inc.kind === 'late') {
      const n = minutesLate(inc.scheduledStart, inc.clockIn);
      return formatDate(inc.date) + ' · ' + label + ' · ' + (n == null ? '?' : n) + ' min (' +
        formatTime(inc.scheduledStart) + ' start, clocked in ' + formatTime(inc.clockIn) +
        (punchIsNextDay(inc.scheduledStart, inc.clockIn) ? ' the next day' : '') + ')';
    }
    const parts = [formatDate(inc.date), label];
    if (inc.kind === 'calloff') {
      if (minutesOfDay(inc.notifiedAt) != null) parts.push('notified ' + formatTime(inc.notifiedAt));
      if (isProtected(inc)) parts.push('Protected Sick Time, not counted');
    }
    if (inc.kind === 'ncns' && minutesOfDay(inc.contactedAt) != null) {
      parts.push('contacted ' + formatTime(inc.contactedAt));
    }
    if (inc.kind === 'performance') {
      parts.push(inc.role === 'instruction' ? 'Instruction' : 'Miss');
      parts.push(perfText(inc.text));
    }
    if (inc.kind === 'sickearly') {
      const n = minutesMissed(inc.scheduledEnd, inc.clockOut);
      parts.push((n == null ? '?' : durationText(n)) + ' missed (clocked out ' + formatTime(inc.clockOut) +
        (inc.clockOutNextDay ? ' the next day' : '') + ', ' +
        formatTime(inc.scheduledEnd) + ' scheduled end)');
      if (isProtected(inc)) parts.push('Protected Sick Time, not counted');
    }
    return parts.join(' · ');
  }

  // ── Wording per kind ─────────────────────────────────────────────────────

  function lateClause(inc) {
    // A punch past midnight names its own calendar date; the incident date
    // stays the shift date.
    const onDate = punchIsNextDay(inc.scheduledStart, inc.clockIn) ? ' on ' + formatDate(nextDay(inc.date)) : '';
    return 'at ' + formatTime(inc.clockIn) + onDate + ' for ' + withArticle(formatTime(inc.scheduledStart)) +
      ' scheduled start, ' + plural(minutesLate(inc.scheduledStart, inc.clockIn), 'minute') + ' late';
  }

  // One incident is one sentence; several of the same kind are ONE sentence
  // with a list, oldest first: "{name} {listVerb} on N days: on A ...; and on B ...".
  function listSentence(list, name, verb, listVerb, clause) {
    // A clause may be empty (a Call-off with no notified time states no timing).
    function tail(inc) { const c = clause(inc); return c ? ' ' + c : ''; }
    if (list.length === 1) {
      return 'On ' + formatDate(list[0].date) + ', ' + name + ' ' + verb + tail(list[0]) + '.';
    }
    const items = list.map(function (inc, i) {
      const lead = i === list.length - 1 ? 'and on ' : 'on ';
      return lead + formatDate(inc.date) + tail(inc);
    });
    return name + ' ' + listVerb + ' on ' + list.length + ' days: ' +
      items.join('; ') + '.';
  }

  // Tyler chose the kind (Call-off) and the form has no scheduled-start field,
  // so the text never says WHEN the call came relative to the shift. With a
  // notified time it states that time; without, it states nothing.
  function callOffClause(inc) {
    return minutesOfDay(inc.notifiedAt) != null ? 'at ' + formatTime(inc.notifiedAt) : '';
  }

  // A sick early departure: the facts only (#1094). Never a reason.
  function sickClause(inc) {
    // A clock-out after midnight names its own calendar date (review round
    // 1); the incident date stays the shift date.
    const onDate = inc.clockOutNextDay ? ' on ' + formatDate(nextDay(inc.date)) : '';
    return 'at ' + formatTime(inc.clockOut) + onDate + ' for ' + withArticle(formatTime(inc.scheduledEnd)) +
      ' scheduled end, ' + durationText(minutesMissed(inc.scheduledEnd, inc.clockOut)) + ' missed';
  }

  // Per kind: the facts, then the "documented as" line. `habitual` is the
  // toggle; only kinds with habitualWording read it.
  const WORDING = {
    late: {
      facts: function (list, name) { return listSentence(list, name, 'clocked in', 'clocked in late', lateClause); },
      documentedAs: function (list, habitual) {
        return 'This is being documented as ' + (habitual ? 'habitual tardiness' : 'tardiness') + '.';
      },
    },
    calloff: {
      facts: function (list, name) { return listSentence(list, name, 'called off', 'called off', callOffClause); },
      documentedAs: function (list, habitual) {
        if (habitual) return 'This is being documented as habitual absence.';
        return 'This is being documented as ' + (list.length === 1 ? 'an unexcused absence' : 'unexcused absences') + '.';
      },
    },
    ncns: {
      // One sentence per NCNS: each is a full absence with its own facts.
      facts: function (list, name) {
        return list.map(function (inc) {
          let s = 'On ' + formatDate(inc.date) + ', ' + withName(NCNS_FACT, name);
          if (minutesOfDay(inc.contactedAt) != null) {
            s += ' ' + name + ' contacted management at ' + formatTime(inc.contactedAt) + '.';
          }
          return s;
        }).join(' ');
      },
      documentedAs: function (list) {
        return list.length === 1
          ? 'This absence is being documented as a no call/no show.'
          : 'These absences are being documented as no call/no shows.';
      },
    },
    // Habitual by definition: the toggle is never read.
    sickearly: {
      facts: function (list, name) { return listSentence(list, name, 'clocked out', 'clocked out early', sickClause); },
      documentedAs: function () { return SICK_DOCUMENTED_AS; },
    },
  };

  // ── Performance wording (#1095) ──────────────────────────────────────────

  // Typed text -> one line: whitespace runs collapsed, ends trimmed, and a
  // trailing . ! or ? dropped (the sentence adds its own stop), unless the
  // text ends in an abbreviation ("by 4 a.m.") whose stop is part of it.
  function perfText(raw) {
    const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    return ABBREV_BEFORE_RE.test(s) ? s : s.replace(/[.!?]+$/, '').trim();
  }

  // The instruction as it follows "was instructed to" / "is expected to": a
  // leading "to" dropped, the first letter lowercased unless the first word is
  // an acronym (two or more capitals: "ULD checks"). Nothing is appended.
  function perfInstruction(raw) {
    let s = perfText(raw).replace(/^to\s+/i, '');
    if (s !== '' && !/^\p{Lu}{2,}(?![\p{Ll}])/u.test(s)) s = s.charAt(0).toLowerCase() + s.slice(1);
    return s;
  }

  // Words that start a subject ("The packages were not scanned"), so a capital
  // there is a sentence start and is lowercased after "On {date}, ". Any other
  // capitalised word may be a person's name and is left as typed.
  const MISS_SUBJECT_STARTERS = ['the', 'a', 'an', 'this', 'that', 'these', 'those', 'his', 'her', 'their',
    'its', 'our', 'my', 'your', 'all', 'both', 'each', 'every', 'some', 'several', 'many', 'few', 'no', 'any',
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'they', 'he', 'she', 'it',
    'there', 'someone', 'nobody', 'everyone'];
  // Words that start a miss with a verb and no subject ("did not work overgoods").
  const MISS_VERB_STARTERS = ['did', "didn't", 'does', "doesn't", 'do', "don't", 'was', "wasn't", 'were', "weren't",
    'is', "isn't", 'has', "hasn't", 'had', "hadn't", 'have', "haven't", 'could', "couldn't", 'would', "wouldn't",
    'should', "shouldn't", 'will', "won't", 'cannot', "can't", 'failed', 'forgot', 'left', 'missed', 'skipped',
    'refused', 'neglected', 'never', 'still', 'again', 'kept', 'put', 'took', 'went', 'came', 'ran', 'sent',
    'stopped', 'started', 'began', 'got', 'made', 'let', 'set'];
  const NOT_PAST_VERBS = ['need', 'speed', 'feed', 'seed', 'shed', 'bed', 'red', 'weed', 'deed', 'creed'];
  function startsWithVerb(word) {
    const w = word.toLowerCase();
    return MISS_VERB_STARTERS.indexOf(w) !== -1 || (/^[a-z]{3,}ed$/.test(w) && NOT_PAST_VERBS.indexOf(w) === -1);
  }

  // The Miss as the sentence after "On {date}, ", honouring the naming choice.
  // The admin's name tokens (any case) or "Admin" at the start become the
  // chosen name; a subject starter is lowercased; a bare verb gets the name.
  function perfMiss(raw, name, admin) {
    const s = perfText(raw);
    const m = /^(\S+?)(['\u2019]s)?(?=[\s,;:]|$)/u.exec(s);
    if (!m) return s;
    const tokens = nameTokens(admin).map(function (t) { return t.replace(/'/g, '').toLowerCase(); });
    tokens.push('admin');
    const isName = function (w) { return tokens.indexOf(sickNormalize(w).replace(/'/g, '').toLowerCase()) !== -1; };
    if (isName(m[1])) {
      // Swallow a run of name tokens ("Sam Example") so the name is said once.
      let rest = s.slice(m[1].length);
      let possessive = m[2] || '';
      if (possessive) rest = rest.slice(possessive.length);
      let n;
      while (!possessive && (n = /^\s+(\S+?)(?=[\s,;:]|$)/u.exec(rest)) && isName(n[1])) rest = rest.slice(n[0].length);
      return name + possessive + rest;
    }
    if (startsWithVerb(m[1])) return name + ' ' + s.charAt(0).toLowerCase() + s.slice(1);
    if (MISS_SUBJECT_STARTERS.indexOf(m[1].toLowerCase()) !== -1 && /^\p{Lu}/u.test(m[1])) {
      return s.charAt(0).toLowerCase() + s.slice(1);
    }
    return s;
  }

  // "10/12/2026", "10/12/2026 and 10/14/2026", "10/12/2026, 10/14/2026, and 10/16/2026".
  function dateList(isoDates) {
    const f = isoDates.map(formatDate);
    if (f.length <= 2) return f.join(' and ');
    return f.slice(0, -1).join(', ') + ', and ' + f[f.length - 1];
  }

  // performancePlan(ticked) -> { ok, instruction, misses, whyNot } for the
  // Performance entries ticked on their own. ok is true for exactly one
  // Instruction and at least one Miss dated on or after it. whyNot maps an
  // entry id to why it cannot be drafted (one plain sentence, no date).
  function performancePlan(ticked) {
    const instructions = ticked.filter(function (inc) { return inc.role === 'instruction'; });
    const misses = ticked.filter(function (inc) { return inc.role === 'miss'; });
    const whyNot = {};
    function blame(list, why) { list.forEach(function (inc) { whyNot[inc.id] = why; }); }
    if (instructions.length === 0) {
      blame(ticked, 'needs the Instruction ticked too: it records what was instructed and when.');
    } else if (instructions.length > 1) {
      blame(ticked, 'cannot be drafted with more than one Instruction ticked. A performance writeup has one ' +
        'Instruction, the first occurrence. Untick the others.');
    } else if (misses.length === 0) {
      blame(ticked, 'needs at least one Miss ticked too: a performance writeup records the Instruction and what was missed.');
    } else {
      const first = instructions[0];
      const early = misses.filter(function (inc) { return inc.date < first.date; });
      if (early.length) {
        blame(ticked, 'cannot be drafted: a Miss is dated before the Instruction on ' + formatDate(first.date) +
          '. Check the dates.');
      } else {
        return { ok: true, instruction: first, misses: misses, whyNot: whyNot };
      }
    }
    return { ok: false, instruction: null, misses: [], whyNot: whyNot };
  }

  // The facts of a Performance draft: the instruction, then each miss in date
  // order (the caller sorted them). Consecutive misses with identical text are
  // one "On {dates}, ..." sentence, so the order of dates never changes.
  function performanceFacts(plan, name, admin) {
    const sentences = [withStop('On ' + formatDate(plan.instruction.date) + ', ' + name + ' was instructed to ' +
      perfInstruction(plan.instruction.text))];
    const groups = [];
    plan.misses.forEach(function (inc) {
      const text = perfMiss(inc.text, name, admin);
      const last = groups[groups.length - 1];
      if (last && last.text === text) {
        if (last.dates.indexOf(inc.date) === -1) last.dates.push(inc.date);
      } else {
        groups.push({ text: text, dates: [inc.date] });
      }
    });
    groups.forEach(function (g) { sentences.push(withStop('On ' + dateList(g.dates) + ', ' + g.text)); });
    return sentences;
  }

  // Workday Reason/Rating for what is actually in the text (spec mapping).
  function picksFor(drafted, habitual) {
    const kinds = [];
    drafted.forEach(function (inc) { if (kinds.indexOf(inc.kind) === -1) kinds.push(inc.kind); });
    if (kinds.length === 0) return { reason: '', rating: '' };
    if (kinds.length > 1) return PATTERN_PICKS;
    const kind = kindOf(kinds[0]);
    if (habitual && kind.habitualWording) return PATTERN_PICKS;
    return { reason: kind.reason, rating: kind.rating };
  }

  // ── The 30-day pattern (house standard, ADR 0004) ────────────────────────
  //
  // Writeup incidents are mapped onto the attendance-rules entry shape
  // ({ date, type, protectedSick }) and counted THERE. Nothing here counts.

  function toAttendanceEntry(inc) {
    const kind = kindOf(inc.kind);
    return {
      id: inc.id,
      date: inc.date,
      type: (kind && kind.patternType) || 'Other',
      protectedSick: isProtected(inc),
    };
  }

  function thresholds() {
    return AttendanceRules.DEFAULT_THRESHOLDS;
  }

  function countPhrase(kind, n) {
    if (kind === 'NCNS') return n + ' NCNS';
    if (kind === 'combination') return n + ' combined';
    return plural(n, kind);
  }

  // pattern(incidents, today) -> { counts, protectedSick, text }: the admin's
  // last-30-days counts from attendance-rules, worded as counts only.
  function pattern(incidents, today) {
    const t = thresholds();
    const ref = localDate(today);
    const zero = { 'Late': 0, 'Call-off': 0, 'NCNS': 0, 'combination': 0 };
    if (!ref) return { counts: zero, protectedSick: 0, text: '' };
    const entries = incidents.map(toAttendanceEntry);
    const counts = AttendanceRules.evaluate(entries, t, ref).counts;
    const protectedSick = entries.filter(function (e) {
      return e.protectedSick && e.type === 'Call-off' &&
        AttendanceRules.inWindow(localDate(e.date), ref, t['Call-off'].windowDays);
    }).length;
    let text = 'Last ' + t.combination.windowDays + ' days: ' +
      ['Late', 'Call-off', 'NCNS', 'combination'].map(function (k) { return countPhrase(k, counts[k]); }).join(', ') +
      '. House standard: Late ' + t.Late.count + ', Call-off ' + t['Call-off'].count + ', NCNS ' + t.NCNS.count +
      ', any ' + t.combination.count + ' combined.';
    if (protectedSick > 0) {
      text += ' ' + plural(protectedSick, 'Protected Sick Time call-off') + ' not counted.';
    }
    // Sick early departures (#1094) get their own figure, in the same window.
    const sickEarly = incidents.filter(function (inc) {
      return isSickEarly(inc) && AttendanceRules.inWindow(localDate(inc.date), ref, t.combination.windowDays);
    }).length;
    if (sickEarly > 0) {
      text += ' ' + plural(sickEarly, 'sick early departure') + ' not counted.';
    }
    return { counts: counts, protectedSick: protectedSick, text: text };
  }

  // habitualNote(checked) -> '' or one line saying the CHECKED incidents meet
  // the house standard. A rolling window: the checked set is evaluated with
  // each checked date as the window's end, so a pattern from August still
  // reads as one in October. It never turns the toggle on.
  function habitualNote(checked) {
    const t = thresholds();
    const entries = checked.map(toAttendanceEntry);
    const best = {};
    const dates = [];
    checked.forEach(function (inc) { if (dates.indexOf(inc.date) === -1) dates.push(inc.date); });
    dates.forEach(function (d) {
      AttendanceRules.evaluate(entries, t, localDate(d)).flags.forEach(function (f) {
        if (!best[f.kind] || f.count > best[f.kind].count) best[f.kind] = f;
      });
    });
    // NCNS is never a habitual signal here: its house standard is 1, so a lone
    // NCNS would always "meet" it. An NCNS still counts toward any 4 combined.
    const parts = ['Late', 'Call-off', 'combination'].filter(function (k) { return best[k]; }).map(function (k) {
      const f = best[k];
      if (k === 'combination') {
        return f.count + ' incidents in ' + f.windowDays + ' days (standard any ' + f.threshold + ')';
      }
      return countPhrase(k, f.count) + ' in ' + f.windowDays + ' days (standard ' + f.threshold + ')';
    });
    return parts.length ? 'The checked incidents meet the house standard: ' + parts.join('; ') + '.' : '';
  }

  // ── History and the suggestion (#1092) ───────────────────────────────────
  //
  // Performance and Conduct Discipline policy, local copy
  // (policies/HR Policy_ - Policy - US FEC 001 & 003 Performance and Conduct
  // Discipline (United States).md, lines 117-137), the progression table:
  //
  //   Step 1 Notice of Deficiency: "You may receive up to 2 notices within a
  //     12-month period"
  //   Step 2 Final Notice: "Your third notice within a 12-month period, or /
  //     If you have been issued a Final Notice between the last / 12-18
  //     months, or / May be given for the first offense as determined by HR
  //     and management"
  //   Step 3 Termination: "If you have received a Final Notice in the last 12
  //     / months, or / If your conduct or performance issue is grounds for
  //     immediate termination"
  //
  // Encoded as (first match wins):
  //   a Final Notice in the last 12 months -> TERMINATION_STEP, no type
  //   2 or more Notices in the last 12 months -> Final Notice ("3rd notice")
  //   a Final Notice 12-18 months ago        -> Final Notice
  //   otherwise                               -> Notice of Deficiency
  // Documented Discussions never count as Notices (GLOSSARY "Documented
  // Discussion": not a step). The policy also lets HR and management skip
  // steps, so this is only ever a suggestion; Tyler picks any type.
  //
  // "IN THE LAST N MONTHS" is calendar months: a writeup is inside when it is
  // dated AFTER the same day N months before today (clamped to the month's
  // last day: 18 months before 10/31/2026 is 04/30/2025) and not after today.
  // The anniversary itself is OUT: a Notice from 10/31/2025 has had its full
  // 12 months on 10/31/2026. That is day 365 in a year with no Feb 29 (day 364
  // in, 365 and 366 out). Where the two disagree, the edge lands on the side
  // that counts LESS against the admin.

  // 'YYYY-MM-DD' -> the same day n calendar months earlier, clamped to that
  // month's last day ('' when invalid).
  function monthsBefore(iso, n) {
    if (!isIsoDate(iso)) return '';
    const m = ISO_DATE_RE.exec(iso);
    let y = Number(m[1]);
    let mo = Number(m[2]) - n;
    while (mo < 1) { mo += 12; y -= 1; }
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const d = Math.min(Number(m[3]), lastDay);
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  // Inside "the last n months" ending today (ISO strings compare as dates).
  function withinMonths(iso, today, n) {
    return iso <= today && iso > monthsBefore(today, n);
  }

  function ordinal(n) {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return n + 'th';
    return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  }

  function historyLabel(entry) {
    const t = historyType(entry.docType);
    return t ? t.label : String(entry.docType || '');
  }

  // "Notice of Deficiency issued 03/02/2026": how a writeup is named in the
  // prior-discipline sentence and the checks.
  function issuedPhrase(entry) {
    return historyLabel(entry) + ' issued ' + formatDate(entry.date);
  }

  function byDateAsc(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  }

  // validateHistoryEntry(entry, today, settings) -> '' when "Add a past
  // writeup" can save it, else one plain sentence saying what is wrong. The
  // Reason is one of reasonsFor(settings): the built-in values plus the extra
  // ones in Settings (#1116).
  function validateHistoryEntry(entry, today, settings) {
    const e = entry || {};
    if (!isIsoDate(e.date)) return 'Enter the date of the writeup.';
    if (isIsoDate(today) && e.date > today) return 'That date is after today. Enter the date the writeup was issued.';
    if (!historyType(e.docType)) return 'Pick the document type.';
    if (reasonsFor(settings).indexOf(e.reason) === -1) return 'Pick the Reason.';
    return '';
  }

  function sameDates(a, b) {
    if (a.length !== b.length) return false;
    const sa = a.slice().sort();
    const sb = b.slice().sort();
    return sa.every(function (d, i) { return d === sb[i]; });
  }

  // WHICH INCIDENTS A SAVED WRITEUP COVERS (review round 1). A writeup saved
  // from a draft records its incident ids and kinds; it is matched on the
  // ids, so a Late and a sick early departure on the same day are never
  // mistaken for one another. A record with no ids (a backfill, or one saved
  // before ids were recorded) falls back to its dates, compared only with
  // the drafted incidents that are NOT sick early departures: no id-less
  // record can cover one (the kind is newer than those records, and a
  // backfill records no incident dates).
  function idsOf(h) {
    return Array.isArray(h.incidentIds) ? h.incidentIds.map(String) : [];
  }
  function datesOfRecord(h) {
    return Array.isArray(h.incidentDates) ? h.incidentDates : [];
  }
  function uniqueDates(list) {
    const out = [];
    list.forEach(function (inc) { if (out.indexOf(inc.date) === -1) out.push(inc.date); });
    return out;
  }
  // The drafted incidents this record covers.
  function coveredBy(h, drafted) {
    const ids = idsOf(h);
    if (ids.length) return drafted.filter(function (inc) { return ids.indexOf(String(inc.id)) !== -1; });
    const dates = datesOfRecord(h);
    return drafted.filter(function (inc) { return !isSickEarly(inc) && !isPerformance(inc) && dates.indexOf(inc.date) !== -1; });
  }
  // This record IS the drafted set (the writeup on screen, saved already).
  function isSameWriteup(h, drafted) {
    if (!drafted.length) return false;
    const ids = idsOf(h);
    if (ids.length) return sameDates(ids, drafted.map(function (inc) { return String(inc.id); }));
    const dates = datesOfRecord(h);
    if (!dates.length || drafted.some(isSickEarly) || drafted.some(isPerformance)) return false;
    return sameDates(dates, uniqueDates(drafted));
  }
  // A saved sick-pattern Documented Discussion (D2). Protected sick use never
  // raises another writeup: it is left out of every NON-sick draft's prior
  // discipline, Previous Counseling Given and Related Disciplinary Actions.
  function isSickRecord(h) {
    return !!(h && h.sickPattern === true);
  }

  // historyView(admin, history, drafted, today, sickDraft) -> everything history
  // decides: the panel, the suggestion, Related Disciplinary Actions, the
  // prior-discipline list and the already-saved overlap.
  //
  // "THIS WRITEUP" IS NOT PRIOR DISCIPLINE. A saved entry whose incident dates
  // are exactly the drafted incident dates is the writeup on screen, saved
  // already (Save to history, then copy). It is left out of the count, the
  // prior-discipline sentence and Related, so the text Tyler copies after
  // saving is the text he saved, and a check says it is already saved. An
  // entry that covers only SOME of the drafted dates is a different, earlier
  // writeup: it counts as usual, and the same check names the shared day.
  function historyView(admin, history, draftedIncidents, today, sickDraft) {
    const all = (history || []).filter(function (h) {
      return h && h.adminId === admin.id && isIsoDate(h.date) && historyType(h.docType);
    });
    const dated = all.filter(function (h) { return !isIsoDate(today) || h.date <= today; });
    const drafted = draftedIncidents || [];

    const self = dated.filter(function (h) { return isSameWriteup(h, drafted); });
    // Every saved writeup (future-dated too) whose incident dates are exactly
    // the drafted ones: Save is refused for these, under any type, and the
    // type shown is the newest one's.
    const saved = all.filter(function (h) { return isSameWriteup(h, drafted); }).sort(byDateAsc);
    const overlap = drafted.length ? dated.filter(function (h) {
      return self.indexOf(h) === -1 && coveredBy(h, drafted).length > 0;
    }).sort(byDateAsc) : [];
    const lastOverlap = overlap.length ? overlap[overlap.length - 1] : null;
    const overlapDates = lastOverlap ? uniqueDates(coveredBy(lastOverlap, drafted)).sort() : [];
    const prior = dated.filter(function (h) { return self.indexOf(h) === -1; }).sort(byDateAsc);
    // What a prior-discipline sentence, Previous Counseling Given and Related
    // may name: a sick-pattern record only on a sick-pattern draft (D2).
    const listed = prior.filter(function (h) { return sickDraft || !isSickRecord(h); });

    const in12 = isIsoDate(today) ? prior.filter(function (h) { return withinMonths(h.date, today, 12); }) : [];
    const in18 = isIsoDate(today) ? prior.filter(function (h) { return withinMonths(h.date, today, 18); }) : [];
    const notices12 = in12.filter(function (h) { return h.docType === 'notice'; });
    const finals12 = in12.filter(function (h) { return h.docType === 'final'; });
    const finals12to18 = in18.filter(function (h) { return h.docType === 'final' && in12.indexOf(h) === -1; });

    // The panel counts every Notice in the window (this writeup included once
    // saved); the suggestion counts the ones prior to the writeup on screen.
    const panelNotices = isIsoDate(today) ? dated.filter(function (h) {
      return h.docType === 'notice' && withinMonths(h.date, today, 12);
    }).length : 0;

    const panelFinals = isIsoDate(today) ? dated.filter(function (h) {
      return h.docType === 'final' && withinMonths(h.date, today, 12);
    }).length : 0;

    // "No history" is decided from writeups dated today or earlier: a lone
    // future-dated entry (it cannot be added, but can be on the device) does
    // not make the suggestion "based on" anything.
    const noHistory = dated.length === 0;

    let suggestion;
    if (noHistory) {
      suggestion = { docType: 'notice', reason: NO_HISTORY_REASON, noHistory: true };
    } else if (finals12.length) {
      const latest = finals12[finals12.length - 1];
      suggestion = { docType: null, reason: TERMINATION_STEP.replace('{date}', formatDate(latest.date)), noHistory: false };
    } else if (notices12.length >= 2) {
      suggestion = { docType: 'final', reason: ordinal(notices12.length + 1) + ' notice in 12 months.', noHistory: false };
    } else if (finals12to18.length) {
      const latest = finals12to18[finals12to18.length - 1];
      suggestion = { docType: 'final', reason: 'Final Notice on ' + formatDate(latest.date) + ', 12 to 18 months ago.', noHistory: false };
    } else {
      suggestion = { docType: 'notice', reason: ordinal(notices12.length + 1) + ' notice in 12 months.', noHistory: false };
    }
    suggestion.noticeCount = notices12.length;
    suggestion.text = suggestion.docType
      ? 'Suggested: ' + DOC_TYPES[suggestion.docType].label + '. ' + suggestion.reason
      : suggestion.reason;

    const latestPrior = listed.length ? listed[listed.length - 1] : null;
    const related = latestPrior ? {
      id: latestPrior.id,
      date: formatDate(latestPrior.date),
      docType: latestPrior.docType,
      label: historyLabel(latestPrior),
      reason: latestPrior.reason || '',
      text: historyLabel(latestPrior) + ', ' + formatDate(latestPrior.date) + ', ' + (latestPrior.reason || ''),
    } : null;

    const entries = all.slice().sort(byDateAsc).reverse().map(function (h) {
      return {
        id: h.id,
        date: formatDate(h.date),
        docType: h.docType,
        label: historyLabel(h),
        reason: h.reason || '',
        source: h.source || '',
        line: formatDate(h.date) + ' · ' + historyLabel(h) + ' · ' + (h.reason || ''),
      };
    });

    return {
      suggestion: suggestion,
      related: related,
      priorIn12: in12.filter(function (h) { return listed.indexOf(h) !== -1; }),
      self: self,
      saved: saved,
      overlap: overlap,
      overlapDates: overlapDates,
      panel: {
        empty: noHistory,
        entries: entries,
        noticeCount: panelNotices,
        text: noHistory ? NO_HISTORY_MESSAGE : plural(panelNotices, 'Notice') +
          (panelFinals ? ' and ' + plural(panelFinals, 'Final Notice') : '') + ' in the last 12 months.',
      },
    };
  }

  // "Prior discipline: {type} issued {date} for {reason}." one per writeup in
  // the last 12 months, oldest first. Every type is listed, Documented
  // Discussions included: they are prior discipline even though they are not
  // counted as Notices.
  function priorSentences(priorIn12, reasons) {
    return priorIn12.map(function (h) {
      // Only a Workday Reason value is ever written here (#1104 review): a
      // free-text reason ("Lateness, HMR-057") from an old or hand-made record
      // would carry the wrong citation into a sentence Replace never removes.
      // An extra Reason from Settings passed the same guards (#1116).
      return 'Prior discipline: ' + issuedPhrase(h) + (reasons.indexOf(h.reason) !== -1 ? ' for ' + h.reason : '') + '.';
    });
  }

  // ── Sentences (#1096) ────────────────────────────────────────────────────
  //
  // Both text checks work in SENTENCES: the wrong-citation fix replaces a
  // whole sentence, and the date check skips "Prior discipline:" sentences
  // (and only those). A sentence ends at . ! or ? (plus any closing quote or
  // bracket) followed by whitespace or the end, or at a blank line. A single
  // line break does NOT end one: a pasted sentence can wrap. A full stop after
  // an abbreviation ("a.m.", "Oct.", "No.") ends a sentence only when a
  // capital follows, so "by 4 a.m. for each shift" and "Oct. 2nd" stay whole.

  const ABBREV_BEFORE_RE = /(?:(?:^|[^A-Za-z])(?:[A-Za-z]\.){2,}|\b(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|no|approx|vs|mr|mrs|ms|dr|st)\.)$/i;

  // text -> [{ start, end, text }] covering every non-blank stretch, in order.
  // `end` is exclusive and excludes trailing whitespace.
  function sentenceSpans(text) {
    const s = String(text == null ? '' : text);
    const spans = [];
    const cites = wrongCitationMatches(s);
    let start = -1;
    function close(end) {
      let e = end;
      while (e > start && /\s/.test(s[e - 1])) e--;
      if (start !== -1 && e > start) spans.push({ start: start, end: e, text: s.slice(start, e) });
      start = -1;
    }
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (start === -1) {
        if (!/\s/.test(ch)) start = i;
        else continue;
      }
      // A blank line ends the sentence before it.
      if (ch === '\n' && /^[ \t\r]*\n/.test(s.slice(i + 1))) { close(i); continue; }
      if (ch === '.' || ch === '!' || ch === '?') {
        // Never inside a wrong citation: "H. M. R. 057" is one token.
        if (cites.some(function (m) { return i >= m.index && i < m.end; })) continue;
        let j = i + 1;
        while (j < s.length && /["'\u201d\u2019)\]]/.test(s[j])) j++;
        if (j < s.length && !/\s/.test(s[j])) continue;
        if (ch === '.' && j < s.length && ABBREV_BEFORE_RE.test(s.slice(Math.max(0, start), i + 1))) {
          const next = /\S/.exec(s.slice(j));
          if (next && !/[A-Z]/.test(next[0])) continue;
        }
        close(j);
        i = j - 1;
      }
    }
    if (start !== -1) close(s.length);
    return spans;
  }

  // A "Prior discipline:" sentence (#1103) lists PAST writeups by their own
  // dates. Only a sentence that STARTS that way is one: "Sam had no prior
  // discipline before 09/09/2026." is a fact about this writeup.
  const PRIOR_START_RE = /^["'\u201c\u2018(]?prior discipline\b/i;

  // sentenceSpans, each marked `prior`, with one more boundary (#1104
  // review): a line break where the next line flips between "Prior
  // discipline" and not ends the span. A wrapped sentence still stays whole,
  // but a Prior discipline line typed with no full stop never carries the next
  // line's facts into the skip (and never gets swallowed by Replace).
  function workingSpans(text) {
    const out = [];
    sentenceSpans(text).forEach(function (sp) {
      let prior = PRIOR_START_RE.test(sp.text);
      let pieceAt = 0;
      function push(from, to, isPrior) {
        let e = to;
        while (e > from && /\s/.test(sp.text[e - 1])) e--;
        if (e > from) out.push({ start: sp.start + from, end: sp.start + e, text: sp.text.slice(from, e), prior: isPrior });
      }
      const lineBreak = /\n[ \t\r]*/g;
      let m;
      while ((m = lineBreak.exec(sp.text)) !== null) {
        const next = m.index + m[0].length;
        if (next >= sp.text.length) break;
        const nextPrior = PRIOR_START_RE.test(sp.text.slice(next));
        if (nextPrior === prior) continue;
        push(pieceAt, m.index, prior);
        pieceAt = next;
        prior = nextPrior;
      }
      push(pieceAt, sp.text.length, prior);
    });
    return out;
  }

  // ── Wrong citation (#1096) ───────────────────────────────────────────────

  // One check per box that cites HMR-057, with a fix that NEVER deletes facts
  // (#1104 review). Each sentence holding the wrong citation is fixed by what
  // else it holds:
  //   - a "Prior discipline:" sentence keeps its date, type and reason; only
  //     the wrong reference goes, with a dangling "under"/"per"/"of"/"for"
  //     before it ("... for Punctuality under HMR-057." -> "... for
  //     Punctuality.");
  //   - a sentence that holds a date (an incident's facts) keeps them; only
  //     the citation clause goes, from the citing words ("goes against",
  //     "is against", "violates", "in violation of", ...) through the end of
  //     its "which states ..." clause. A heading line in it ("Policy:
  //     Attendance, HMR-057") goes whole;
  //   - any other sentence is replaced whole, so the "which states ..."
  //     paraphrase of the package handler process goes with the token.
  // The first sentence or clause fixed becomes the canonical citation, unless
  // POLICY-010 is already cited where it belongs (then the wrong part only
  // goes, so the citation is never doubled). `citedOutsideBox` says it is
  // cited, or will be after its own fix, in Discipline Details.
  const CITE_LEAD_RE = /(?:,\s*|\s+|^)(?:(?:which|that|and|this|it|as)\s+)*(?:(?:goes|go|went|is|was|are|were)\s+(?:against|contrary\s+to)|(?:is|was|are|were)\s+(?:a\s+violation\s+of|in\s+violation\s+of)|in\s+violation\s+of|violat(?:es|ed|ing|e)|breaks|broke|according\s+to|as\s+stated\s+in|under|per)\b/gi;
  const WHICH_CLAUSE_RE = /^[)\]"'”’]*\s*,?\s*(?:which|that)\s+(?:states?|says|said|requires?|reads|explains|outlines)\b/i;
  const TOKEN_LEAD_RE = /(?:[\s,;:]*\b(?:in\s+violation\s+of|violat(?:es|ed|ing)|against|under|per|of|for)\b)?[\s,;:]*[(\["'“‘]?$/i;
  const HEADING_LINE_RE = /^[ \t]*\p{L}[\p{L} ]{0,29}:/u;

  // A FACT (#1104 review round 2): any date, any clock time ("4:12 AM",
  // "04:06") or any other number ("12 minutes late", "3 times"). The 57/057
  // of the wrong citation itself is not one, and neither is POLICY-010.
  const POLICY_010_RE = /policy[\s\-‐-―]*0*10(?!\d)/gi;
  function hasFact(s) {
    const t = withoutCitations(s, ' ')
      .replace(POLICY_010_RE, ' ');
    return /\p{N}/u.test(t);
  }

  function tidy(s) {
    return s
      .replace(/\(\s*\)|\[\s*\]/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([.,;:!?])/g, '$1')
      .replace(/,([.!?])/g, '$1')
      .replace(/,(?:[ \t]*,)+/g, ',')
      .replace(/^[\s,;:]+/, '');
  }

  // The wrong reference only (a Prior discipline sentence). -> { text, removed }
  function stripTokens(s) {
    let out = s;
    const removed = [];
    const ms = wrongCitationMatches(out);
    for (let k = ms.length - 1; k >= 0; k--) {
      const mt = ms[k];
      const lead = TOKEN_LEAD_RE.exec(out.slice(0, mt.index));
      let a = lead ? lead.index : mt.index;
      let b = mt.end;
      if (lead && /[(\["'“‘]$/.test(lead[0]) && /^[)\]"'”’]/.test(out.slice(b))) b++;
      removed.unshift(out.slice(a, b));
      out = out.slice(0, a) + out.slice(b);
    }
    return { text: tidy(out), removed: removed };
  }

  // The citation clause only (a sentence holding a date). -> { text, removed }
  function stripClause(s) {
    let out = s;
    const removed = [];
    for (let guard = 0; guard < 8; guard++) {
      const mt = wrongCitationMatches(out)[0];
      if (!mt) break;
      const lineStart = out.lastIndexOf('\n', mt.index - 1) + 1;
      const nl = out.indexOf('\n', mt.end);
      const lineEnd = nl === -1 ? out.length : nl;
      const line = out.slice(lineStart, lineEnd);
      const multiLine = lineStart > 0 || nl !== -1;
      const bare = withoutCitations(line, '').replace(/[^\p{L}]/gu, '') === '';
      if (multiLine && !hasFact(line) && (HEADING_LINE_RE.test(line) || bare)) {
        // A heading line: it goes with its line break.
        const a = nl === -1 ? Math.max(0, lineStart - 1) : lineStart;
        const b = nl === -1 ? lineEnd : nl + 1;
        removed.push(line.trim());
        out = out.slice(0, a) + out.slice(b);
        continue;
      }
      // Start: the citing words nearest before the token (and any short run
      // of citing words just before those), else the dangling connector.
      const before = out.slice(0, mt.index);
      const leads = [];
      let lm;
      CITE_LEAD_RE.lastIndex = 0;
      while ((lm = CITE_LEAD_RE.exec(before)) !== null) {
        leads.push({ start: lm.index, end: lm.index + lm[0].length });
        if (lm[0].length === 0) CITE_LEAD_RE.lastIndex++;
      }
      function shortGap(g, max) { return g.length <= max && !/[\d.;!?\n]/.test(g); }
      let start = -1;
      for (let i = leads.length - 1; i >= 0; i--) {
        if (start === -1) {
          if (shortGap(before.slice(leads[i].end, mt.index), 40)) start = i;
          else break;
        } else if (shortGap(before.slice(leads[i].end, leads[start].start), 20) &&
          before.slice(leads[i].end, leads[start].start).trim().split(/\s+/).filter(Boolean).length <= 2 &&
          !/,/.test(before.slice(leads[i].end, leads[start].start))) {
          start = i;
        } else break;
      }
      let a;
      if (start !== -1) a = leads[start].start;
      else {
        const tl = TOKEN_LEAD_RE.exec(before);
        a = tl ? tl.index : mt.index;
      }
      // End: the token, or the end of its "which states ..." clause: the
      // first comma, semicolon or " and " after "which states", else the
      // sentence end (#1104 review round 2: what follows is the writer's own
      // words, "..., and did not call the supervisor."). A date after the
      // token is a fact: the clause stops before it.
      let b = mt.end;
      const closer = /^[)\]"'”’]*/.exec(out.slice(b))[0];
      const which = WHICH_CLAUSE_RE.exec(out.slice(b));
      if (which) {
        const tail = /[.!?]["'”’)\]]*\s*$/.exec(out);
        let end = tail ? tail.index : out.length;
        const from = b + which[0].length;
        const stop = /[,;]|\sand\s/i.exec(out.slice(from));
        if (stop && from + stop.index < end) end = from + stop.index;
        const date = datesIn(out.slice(b, end))[0];
        if (date) {
          const head = out.slice(b, b + date.start);
          const cut = Math.max(head.lastIndexOf(','), head.lastIndexOf(' and '));
          end = b + (cut > 0 ? cut : date.start);
        }
        b = end;
      } else {
        b += closer.length;
      }
      removed.push(out.slice(a, b));
      out = out.slice(0, a) + out.slice(b);
      if (a === 0) out = tidy(out).replace(/^\p{Ll}/u, function (c) { return c.toUpperCase(); });
    }
    if (hasWrongCitation(out)) {
      const t = stripTokens(out);
      t.removed.forEach(function (r) { removed.push(r); });
      out = t.text;
    }
    return { text: tidy(out), removed: removed };
  }

  function withStop(s) {
    return /[.!?]["'”’)\]]*$/.test(s) ? s : s + '.';
  }

  function wrongCitationCheck(field, citedOutsideBox) {
    const text = field.text || '';
    const matches = wrongCitationMatches(text);
    if (!matches.length) return null;
    const spans = workingSpans(text);
    const hits = [];
    const tokens = [];
    matches.forEach(function (mt) {
      tokens.push(mt.raw.replace(/\s+/g, ' '));
      spans.forEach(function (sp) {
        // Every sentence the match touches (a match never spans a boundary
        // in practice, but if it does both sentences are fixed).
        if (sp.start < mt.end && sp.end > mt.index && hits.indexOf(sp) === -1) hits.push(sp);
      });
    });
    if (!hits.length) return null;
    hits.sort(function (a, b) { return a.start - b.start; });
    hits.forEach(function (sp) {
      sp.mode = sp.prior ? 'token' : (hasFact(sp.text) ? 'clause' : 'sentence');
    });

    const outside = spans.filter(function (sp) { return hits.indexOf(sp) === -1; });
    const cited = citedOutsideBox || outside.some(function (sp) { return sp.text.indexOf(CITATION) !== -1; });
    const receiver = cited ? null : (hits.filter(function (sp) { return sp.mode !== 'token'; })[0] || null);
    // Only Prior discipline sentences cite it and POLICY-010 is nowhere
    // (#1104 review round 2): the citation goes in front of the first one,
    // where the generated text puts it, so the box still cites it once.
    const citeBefore = (!cited && !receiver) ? hits[0] : null;

    const removedBy = [];
    let out = text;
    for (let k = hits.length - 1; k >= 0; k--) {
      const sp = hits[k];
      if (sp.mode === 'token' || sp.mode === 'clause') {
        const r = sp.mode === 'token' ? stripTokens(sp.text) : stripClause(sp.text);
        let t = r.text;
        if (sp === receiver) t = withStop(t) + ' ' + CITATION;
        if (sp === citeBefore) t = CITATION + ' ' + t;
        removedBy[k] = r.removed;
        out = out.slice(0, sp.start) + t + out.slice(sp.end);
        continue;
      }
      removedBy[k] = [sp.text];
      if (sp === receiver) {
        out = out.slice(0, sp.start) + CITATION + out.slice(sp.end);
        continue;
      }
      // Remove the sentence and one run of the spaces beside it: the ones
      // after it when more text follows on the line, else the ones before.
      let a = sp.start;
      let b = sp.end;
      const after = /^[ \t]*/.exec(out.slice(b))[0].length;
      const nextCh = out.charAt(b + after);
      if (after && nextCh && nextCh !== '\n' && nextCh !== '\r') {
        b += after;
      } else {
        while (a > 0 && (out[a - 1] === ' ' || out[a - 1] === '\t')) a--;
        b += after;
      }
      out = out.slice(0, a) + out.slice(b);
    }

    const sentences = hits.map(function (sp) { return sp.text; });
    const removed = [];
    removedBy.forEach(function (list) { (list || []).forEach(function (r) { removed.push(r); }); });
    const named = tokens.filter(function (t, i) { return tokens.indexOf(t) === i; }).join(', ');
    const quote = function (t) { return '"' + t.replace(/\s+/g, ' ').trim() + '"'; };
    const whole = hits.every(function (sp) { return sp.mode === 'sentence'; });
    return {
      id: 'wrong-citation',
      ok: false,
      fieldId: field.id,
      message: field.label + ' cites ' + named + ', the package handler attendance process. Admins fall under POLICY-010. ' +
        (whole
          ? 'Replace the whole ' + (sentences.length === 1 ? 'sentence' : 'sentences') + ': ' + sentences.map(quote).join(' and ') + '.'
          : 'Replace removes only ' + removed.map(quote).join(' and ') + ', and keeps the dates and facts around ' +
            (removed.length === 1 ? 'it' : 'them') + '.'),
      fix: {
        fieldId: field.id,
        label: 'Replace with the POLICY-010 sentence',
        sentences: sentences,
        removed: removed,
        text: out,
      },
    };
  }

  // ── Date consistency (#1096) ─────────────────────────────────────────────
  //
  // Every date written in a box must be a checked (drafted) incident's date,
  // or the next-day punch date a midnight Late names. EVERY drafted incident
  // date must be written somewhere in the text (#1104 review: not only the
  // Workday period start and end). Dates inside "Prior discipline:" sentences
  // are past writeups' dates and are skipped, sentence by sentence (never
  // "everything after the first one").

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  // A run of digits joined by / . or - ("10/07/2026-10/09/2026", "10.09.2026",
  // "2026-10-07-2026-10-09"). Each run is read left to right as dates joined
  // by one separator, so an unspaced range gives BOTH dates (#1104 review).
  const NUMERIC_RUN_RE = /\d[\d/.\-]*\d/g;
  const ISO_AT_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?=$|[/.\-])/;
  const US_AT_RE = /^(\d{1,2})([/.\-])(\d{1,2})\2(\d{4}|\d{2})(?=$|[/.\-])/;
  const NAMED_IN_TEXT_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?/gi;

  function pad2(n) { return String(n).padStart(2, '0'); }

  // text -> [{ raw, start, iso, md }]. `iso` is 'YYYY-MM-DD' when the date
  // names a year and exists ('' when it does not exist); `md` is 'MM-DD' for
  // a month-name date with no year.
  function datesIn(text) {
    const s = String(text == null ? '' : text);
    const found = [];
    const taken = [];
    function free(a, b) { return !taken.some(function (t) { return a < t[1] && b > t[0]; }); }
    function add(a, raw, y, mo, d, named) {
      const b = a + raw.length;
      if (!free(a, b)) return;
      taken.push([a, b]);
      let iso = '';
      let md = '';
      if (y == null) {
        md = pad2(mo) + '-' + pad2(d);
      } else {
        const cand = y + '-' + pad2(mo) + '-' + pad2(d);
        iso = isIsoDate(cand) ? cand : '';
      }
      found.push({ raw: raw.replace(/\s+/g, ' ').replace(/[,\s]+$/, ''), start: a, iso: iso, md: md, named: !!named });
    }
    let m;
    NUMERIC_RUN_RE.lastIndex = 0;
    while ((m = NUMERIC_RUN_RE.exec(s)) !== null) {
      const run = m[0];
      let p = 0;
      while (p < run.length) {
        const rest = run.slice(p);
        let d = ISO_AT_RE.exec(rest);
        if (d) {
          add(m.index + p, d[0], Number(d[1]), Number(d[2]), Number(d[3]));
        } else if ((d = US_AT_RE.exec(rest))) {
          add(m.index + p, d[0], d[4].length === 2 ? 2000 + Number(d[4]) : Number(d[4]), Number(d[1]), Number(d[3]));
        }
        if (d) { p += d[0].length + 1; continue; }
        // Not a date here ("1/2", "4.5"): try after the next separator.
        const sep = /[/.\-]/.exec(rest);
        if (!sep) break;
        p += sep.index + 1;
      }
    }
    NAMED_IN_TEXT_RE.lastIndex = 0;
    while ((m = NAMED_IN_TEXT_RE.exec(s)) !== null) {
      const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
      const d = Number(m[2]);
      if (d < 1 || d > 31) continue;
      add(m.index, m[0], m[3] ? Number(m[3]) : null, mo, d, true);
    }
    return found.sort(function (a, b) { return a.start - b.start; });
  }

  // The dates a box states about THIS writeup: every date except a past
  // writeup's own "issued MM/DD/YYYY" date inside a "Prior discipline:"
  // sentence (#1104 review round 2). Any other date in that sentence ("...;
  // Sam was also late 10/09/2026.") is checked like any other.
  const ISSUED_BEFORE_RE = /\bissued\s+(?:on\s+)?$/i;
  function narrativeDates(text) {
    const s = String(text == null ? '' : text);
    const prior = workingSpans(s).filter(function (sp) { return sp.prior; });
    return datesIn(s).filter(function (d) {
      const sp = prior.filter(function (p) { return d.start >= p.start && d.start < p.end; })[0];
      return !(sp && ISSUED_BEFORE_RE.test(s.slice(sp.start, d.start)));
    });
  }

  function dateMatches(d, allowedIso) {
    if (d.iso) return allowedIso.indexOf(d.iso) !== -1;
    if (d.md) return allowedIso.some(function (iso) { return iso.slice(5) === d.md; });
    return false;
  }

  function listPhrase(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  function dateChecks(fields, draftedDates, allowedDates) {
    const checks = [];
    const mentioned = [];
    fields.forEach(function (f) {
      const ds = narrativeDates(f.text || '');
      ds.forEach(function (d) { mentioned.push(d); });
      const stray = ds.filter(function (d) { return !dateMatches(d, allowedDates); });
      const raws = stray.map(function (d) { return d.raw; }).filter(function (r, i, a) { return a.indexOf(r) === i; });
      if (raws.length) {
        checks.push({
          id: 'dates',
          ok: false,
          fieldId: f.id,
          message: f.label + ' has ' + listPhrase(raws) + ', which ' + (raws.length === 1 ? 'is not a checked incident' : 'are not checked incidents') +
            (draftedDates.length ? '. Checked: ' + listPhrase(draftedDates.map(formatDate)) + '.' : '. No incident is checked.'),
        });
      }
    });
    if (!draftedDates.length) return checks;

    const first = draftedDates[0];
    const last = draftedDates[draftedDates.length - 1];
    function said(iso) { return mentioned.some(function (d) { return dateMatches(d, [iso]); }); }
    const missing = draftedDates.filter(function (iso) { return !said(iso); });
    if (missing.length) {
      let message;
      if (first === last) {
        message = 'The Workday period date ' + formatDate(first) + ' is not in the text.';
      } else {
        message = missing.map(function (iso) {
          if (iso === first || iso === last) {
            return 'The Workday period ' + (iso === first ? 'starts ' : 'ends ') + formatDate(iso) + ', but that date is not in the text.';
          }
          return 'The checked incident on ' + formatDate(iso) + ' is not in the text.';
        }).join(' ');
      }
      checks.push({ id: 'period', ok: false, message: message });
    }
    if (!checks.length) checks.push({ id: 'dates', ok: true, message: 'Dates match the checked incidents' });
    return checks;
  }

  // ── Settings (#1116) ─────────────────────────────────────────────────────
  //
  // Tyler changes some wording and word lists in the page, without a code
  // change. The page saves the settings on the device (lib/writeups-store.js,
  // `writeups:settings`) and hands them to draft() as input.settings; draft()
  // stays pure and reads no storage. Absent settings are the defaults, so a
  // draft with no settings is exactly what it was before #1116.
  //
  // WHAT CAN CHANGE, AND THE GUARD ON EACH (the 2026-10-31 audit):
  //   - naming: the page's starting "Name them as" choice.
  //   - five sentences (SETTINGS_SENTENCES). A sentence must keep every
  //     placeholder its default has and may use no other; it may never cite
  //     HMR-057 or policy 057 in any form, hold a medical word, or say
  //     "insubordination"; only the Final Notice line may say "final notice",
  //     and it must. The generated draft still runs every check on top.
  //   - extraMedicalWords: ADD-ONLY. The built-in lists are constants here and
  //     always run; a setting can only lengthen what is caught.
  //   - stationPhrases: exact phrases of two or more words that never warn.
  //     This is the one setting that WEAKENS a check, so a phrase needs a word
  //     of its own besides medical, reason and filler words: "doctor", "the
  //     doctor" and "urgent care" are refused, "appointment package" is not.
  //   - extraReasons: appended to REASONS for backfill and history.
  //   - sickPatternMin: raised, never below SICK_PATTERN_FLOOR (2). One sick
  //     early departure is never a pattern; the floor is applied again inside
  //     draft(), so a tampered setting cannot lower it.
  //
  // FIXED, NOT SETTINGS: the POLICY-010 citation, the sick-pattern wording and
  // the protected-sick rules, the house-standard counts and 30-day window, the
  // 12/18-month Notice rules, and Reason/Rating for sick and performance.
  const SETTINGS_FIXED_NOTE = 'Fixed, not in Settings: the POLICY-010 citation, the sick-pattern wording and ' +
    'protected-sick rules, the house-standard counts and 30-day window, the 12 and 18-month Notice rules, and ' +
    'Reason and Rating for sick and performance writeups.';

  const SICK_PATTERN_FLOOR = SICK_PATTERN_MIN;
  const SICK_PATTERN_MAX = 10;
  const PLACEHOLDER_RE = /\{[A-Za-z]+\}/g;
  function placeholdersOf(text) {
    const out = [];
    (String(text).match(PLACEHOLDER_RE) || []).forEach(function (p) { if (out.indexOf(p) === -1) out.push(p); });
    return out;
  }
  const SETTINGS_SENTENCES = [
    { id: 'expectation', label: 'Attendance expectation (first sentence of Next Steps)', defaultText: EXPECTATION },
    { id: 'consequence', label: 'Attendance consequence', defaultText: CONSEQUENCE },
    { id: 'performanceConsequence', label: 'Performance consequence', defaultText: PERFORMANCE_CONSEQUENCE },
    { id: 'finalNotice', label: 'Final Notice line', defaultText: FINAL_NOTICE_LINE },
    { id: 'scheduleLine', label: 'Work schedule line', defaultText: SCHEDULE_LINE },
  ].map(function (s) { return Object.assign(s, { placeholders: placeholdersOf(s.defaultText) }); });
  const SETTINGS_KEYS = ['naming', 'sentences', 'extraMedicalWords', 'stationPhrases', 'extraReasons', 'sickPatternMin'];
  const MAX_SENTENCE = 600;
  const MAX_WORD = 40;
  const MAX_PHRASE = 60;
  const MAX_LIST = 200;

  function sentenceMeta(id) {
    for (let i = 0; i < SETTINGS_SENTENCES.length; i++) if (SETTINGS_SENTENCES[i].id === id) return SETTINGS_SENTENCES[i];
    return null;
  }

  function defaultSettings() {
    return {
      naming: 'first',
      sentences: {},
      extraMedicalWords: [],
      stationPhrases: [],
      extraReasons: [],
      sickPatternMin: SICK_PATTERN_FLOOR,
    };
  }

  function quoteList(words) { return listPhrase(words.map(function (w) { return '"' + w + '"'; })); }

  // The three readings of a template a guard judges: as typed, with each
  // placeholder taken out (so "HMR-{name}057" or "doc{days}tor" cannot hide a
  // match by splitting it), and with each placeholder read as a space.
  function templateReadings(text) {
    const t = String(text);
    return [t, t.replace(PLACEHOLDER_RE, ''), t.replace(PLACEHOLDER_RE, ' ')];
  }

  // A word or phrase as the lists hold it: normalized like the checks read
  // text, lower case, single spaces.
  function cleanTerm(raw) {
    return sickNormalize(raw).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  const THIRTY_DAYS_RE = /(?<![\p{L}\p{N}])30\s+days(?![\p{L}\p{N}])/iu;
  const FINAL_NOTICE_WORDS_RE = /(?<![\p{L}\p{N}])final[\s\-\u2010-\u2015]+notice(?![\p{L}\p{N}])/iu;

  // sentenceProblem(id, text, settings) -> '' or why the sentence is refused.
  function sentenceProblem(id, text, settings) {
    const meta = sentenceMeta(id);
    if (!meta) return 'That is not a sentence the Settings can change.';
    if (typeof text !== 'string' || text.trim() === '') return 'Type the sentence, or press Reset to default.';
    if (text.length > MAX_SENTENCE) return 'Keep the sentence under ' + MAX_SENTENCE + ' characters.';
    const missing = meta.placeholders.filter(function (p) { return text.indexOf(p) === -1; });
    if (missing.length) {
      const them = missing.length === 1 ? 'it' : 'them';
      return 'This sentence must keep ' + listPhrase(missing) + '. The default has ' + them + ', and the draft fills ' + them + ' in.';
    }
    let rest = text;
    meta.placeholders.forEach(function (p) { rest = rest.split(p).join(''); });
    if (/[{}]/.test(rest)) {
      return meta.placeholders.length
        ? 'This sentence can use only ' + listPhrase(meta.placeholders) + '. Take out the other braces.'
        : 'This sentence has no placeholders. Take out the braces.';
    }
    const readings = templateReadings(text);
    if (readings.some(hasWrongCitation)) {
      return 'This sentence cites HMR-057 or policy 057, the package handler process. Admins are non-package ' +
        'handlers: POLICY-010 is the only citation, and the draft adds it.';
    }
    const cfg = settings ? normalizeSettings(settings) : defaultSettings();
    const words = [];
    // #1119 review round 1: station phrases are NOT applied here. A sentence
    // is the station's own wording, so it never needs one, and a phrase that
    // somehow held a medical word must not let a sentence carry it.
    readings.forEach(function (r) {
      sickWords(r, { extra: cfg.extraMedicalWords }).forEach(function (w) {
        if (words.indexOf(w) === -1) words.push(w);
      });
    });
    if (words.length) return 'This sentence has ' + quoteList(words) + '. Medical words never go in a writeup.';
    if (readings.some(hasInsubordination)) {
      return 'This sentence says "insubordination". A writeup states the facts instead.';
    }
    // #1119 review round 1: the attendance consequence states the fixed
    // 30-day window, so it must keep "30 days". Other wording is free.
    if (id === 'consequence' && !readings.every(function (r) { return THIRTY_DAYS_RE.test(sickNormalize(r)); })) {
      return 'The attendance consequence must keep "30 days". The 30-day window is fixed, not a setting.';
    }
    // Spaces and dashes collapsed first (#1119): "FINAL  NOTICE" is it too.
    const saysFinal = readings.some(function (r) { return FINAL_NOTICE_WORDS_RE.test(sickNormalize(r)); });
    if (id === 'finalNotice' && !saysFinal) {
      return 'The Final Notice line must say "final notice", so the check that a Final Notice says so can find it.';
    }
    if (id !== 'finalNotice' && saysFinal) {
      return 'Only the Final Notice line may say "final notice". A Notice that says it would read as a Final Notice.';
    }
    return '';
  }

  // extraMedicalWordProblem(word, list) -> '' or why the word is refused.
  // `list` is the extra words already saved (for repeats).
  function extraMedicalWordProblem(raw, list) {
    if (typeof raw !== 'string') return 'Type a word.';
    const w = cleanTerm(raw);
    if (!w) return 'Type a word.';
    if (w.length > MAX_WORD) return 'Keep a word under ' + MAX_WORD + ' characters.';
    if (!/^[\p{L}\p{N}][\p{L}\p{N}' \-\/.]*\*?$/u.test(w) || (w.match(/[\p{L}\p{N}]/gu) || []).length < 2) {
      return 'A word needs two or more letters. Letters, numbers, spaces, hyphens and a * at the end only.';
    }
    if ((list || []).indexOf(w) !== -1) return '"' + w + '" is already on your list.';
    const found = sickWords(w, {});
    if (!/\*$/.test(w) && found.length === 1 && found[0] === w) return '"' + w + '" is already caught by the built-in list.';
    return '';
  }

  // Words that carry nothing of their own in a phrase.
  const FILLER_WORDS = ['the', 'a', 'an', 'to', 'at', 'for', 'of', 'in', 'on', 'with', 'from', 'my', 'his', 'her',
    'their', 'our', 'your', 'was', 'is', 'are', 'were', 'be', 'been', 'had', 'has', 'have', 'went', 'go', 'goes',
    'got', 'get', 'and', 'or', 'but', 'not', 'no', 'by', 'as', 'it', 'its', 'this', 'that', 'they', 'them', 'he',
    'she', 'we', 'you', 'me', 'him', 'us', 'very', 'so', 'too', 'off', 'out', 'up', 'into', 'about', 'any', 'some',
    'all', 'one', 'two', 'new', 'old', 'day', 'days', 'today', 'yesterday', 'tomorrow', 'did', 'does', 'do',
    'saw', 'see', 'seen', 'visit', 'visits', 'visited', 'call', 'called', 'calls'];

  // Abbreviations in any case, for phrases and Reasons only ("er desk").
  const MEDICAL_ABBR_ANY_CASE_RE = termsRe(MEDICAL_ABBREVIATIONS, 'giu', false);

  // phraseMedicalWords(text, cfg) -> every medical, abbreviation (any case),
  // extra or reason word in a short phrase, read as the checks read text.
  function phraseMedicalWords(raw, cfg, noReason) {
    const found = sickWords(raw, { reason: !noReason, extra: cfg.extraMedicalWords });
    const t = sickNormalize(raw).replace(STATION_TERMS_RE, ' ');
    lineHyphenVariants(t).forEach(function (v) {
      MEDICAL_ABBR_ANY_CASE_RE.lastIndex = 0;
      let m;
      while ((m = MEDICAL_ABBR_ANY_CASE_RE.exec(v)) !== null) {
        const w = m[0].replace(/\s+/g, ' ');
        if (!found.some(function (x) { return x.toLowerCase() === w.toLowerCase(); })) found.push(w);
      }
    });
    return found;
  }

  // stationPhraseProblem(phrase, settings) -> '' or why it is refused. A
  // station phrase switches the medical check off for exactly that phrase, so
  // it must name something of the station's own: with every medical, reason
  // and extra word taken out, and filler words too, a real word must be left.
  // That refuses "doctor" (and every spelling of it the checks read as
  // doctor), "the doctor", "urgent care" and "sick note".
  function stationPhraseProblem(raw, settings) {
    if (typeof raw !== 'string') return 'Type a phrase.';
    const cfg = settings ? normalizeSettings(settings) : defaultSettings();
    const p = cleanTerm(raw);
    if (!p) return 'Type a phrase.';
    if (p.length > MAX_PHRASE) return 'Keep a phrase under ' + MAX_PHRASE + ' characters.';
    if (!/^[\p{L}\p{N}' \-\/.]+$/u.test(p)) return 'Station phrases are exact phrases: letters, numbers, spaces and hyphens only, no *.';
    // Read the phrase as the checks read text, with no station allowance.
    let t = sickNormalize(raw).replace(/\s+/g, ' ');
    const extraRe = extraTermsRe(cfg.extraMedicalWords);
    [MEDICAL_ABBR_RE, MEDICAL_RE, SICK_REASON_RE].concat(extraRe ? [extraRe] : []).forEach(function (re) {
      re.lastIndex = 0;
      t = t.replace(re, ' ');
    });
    const own = t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(function (x) {
      return x.length >= 3 && FILLER_WORDS.indexOf(x) === -1;
    });
    if (!own.length) {
      return '"' + p + '" is a medical word or phrase. It cannot be allowlisted, so the check still catches it. ' +
        'Add the whole station phrase it is part of, like "appointment package".';
    }
    // #1119 review round 1: a phrase may hold NO medical word, abbreviation
    // (in any case: "ER desk", "er desk"), extra word, or sick-draft reason
    // word at all. Otherwise "doctor office" or "sick time" would silence
    // the very text the check exists for. The built-in "appointment package"
    // is read out first, as the checks read it, so a phrase built on it stays
    // allowed.
    const held = phraseMedicalWords(raw, cfg);
    if (held.length) {
      return '"' + p + '" holds ' + quoteList(held) + ', which the medical check must always catch. ' +
        'A station phrase cannot hold a medical or reason word.';
    }
    if (p.split(' ').length < 2) return 'Station phrases are exact phrases of two or more words, like "appointment package".';
    if (STATION_TERMS.indexOf(p) !== -1 || cfg.stationPhrases.indexOf(p) !== -1) return '"' + p + '" is already on the list.';
    return '';
  }

  // reasonsFor(settings) -> the Workday Reason values: built-in, then extras.
  function reasonsFor(settings) {
    return REASONS.concat(normalizeSettings(settings).extraReasons);
  }

  function cleanReason(raw) { return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim(); }

  // extraReasonProblem(reason, list) -> '' or why it is refused. A Reason is
  // written into "Prior discipline: ... for {reason}." sentences, so it gets
  // the sentence guards too.
  function extraReasonProblem(raw, list, settings) {
    if (typeof raw !== 'string') return 'Type a Reason.';
    const r = cleanReason(raw);
    if (r.length < 2) return 'Type a Reason, as Workday spells it.';
    if (r.length > MAX_WORD) return 'Keep a Reason under ' + MAX_WORD + ' characters.';
    if (!/^[\p{L}\p{N}][\p{L}\p{N} &'\-\/]*$/u.test(r)) return 'A Reason is letters, numbers, spaces, hyphens and & only.';
    const lower = r.toLowerCase();
    if (REASONS.concat(list || []).some(function (x) { return x.toLowerCase() === lower; })) return '"' + r + '" is already a Reason.';
    if (hasWrongCitation(r)) return 'A Reason never cites HMR-057 or policy 057.';
    // #1119 review round 1: the extra medical words count too, and an
    // abbreviation in any case ("Er Visits").
    const cfg = settings ? normalizeSettings(settings) : defaultSettings();
    const words = phraseMedicalWords(r, cfg, true);
    if (words.length) return 'A Reason never holds a medical word (' + quoteList(words) + ').';
    // A "Prior discipline ... for Insubordination." sentence is the charge
    // the performance check exists to keep out of a writeup.
    if (hasInsubordination(r)) return 'A Reason never says "insubordination". A writeup states the facts instead.';
    return '';
  }

  // sickPatternMinProblem(n) -> '' or why the number is refused.
  function sickPatternMinProblem(n) {
    if (typeof n !== 'number' || !isFinite(n) || n !== Math.floor(n)) return 'Enter a whole number.';
    if (n < SICK_PATTERN_FLOOR) {
      return 'The sick-pattern minimum is never below ' + SICK_PATTERN_FLOOR + '. One sick early departure is not a pattern.';
    }
    if (n > SICK_PATTERN_MAX) return 'Keep the sick-pattern minimum at ' + SICK_PATTERN_MAX + ' or less.';
    return '';
  }

  function isPlainObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

  // Walks a settings object, calling `bad(message)` for each problem and
  // returning the clean settings built from the parts that pass.
  function walkSettings(s, bad) {
    const out = defaultSettings();
    if (s == null) return out;
    if (!isPlainObject(s)) { bad('Settings are not readable.'); return out; }
    Object.keys(s).forEach(function (k) {
      if (SETTINGS_KEYS.indexOf(k) === -1) bad('Settings hold an unknown entry "' + k + '".');
    });
    if (s.naming !== undefined) {
      if (s.naming === 'first' || s.naming === 'admin') out.naming = s.naming;
      else bad('The naming setting is not First name or "Admin".');
    }
    // Lists first: the sentence guard reads the extra words and phrases.
    function list(key, problem, clean) {
      if (s[key] === undefined) return;
      if (!Array.isArray(s[key]) || s[key].length > MAX_LIST) { bad('The ' + key + ' setting is not a list.'); return; }
      s[key].forEach(function (v) {
        const why = problem(v, out[key]);
        if (why) { bad(why); return; }
        out[key].push(clean(v));
      });
    }
    list('extraMedicalWords', extraMedicalWordProblem, cleanTerm);
    list('stationPhrases', function (v) { return stationPhraseProblem(v, out); }, cleanTerm);
    list('extraReasons', function (v, l) { return extraReasonProblem(v, l, out); }, cleanReason);
    if (s.sickPatternMin !== undefined) {
      const why = sickPatternMinProblem(s.sickPatternMin);
      if (why) bad(why); else out.sickPatternMin = s.sickPatternMin;
    }
    if (s.sentences !== undefined) {
      if (!isPlainObject(s.sentences)) bad('The sentences setting is not readable.');
      else {
        Object.keys(s.sentences).forEach(function (id) {
          const meta = sentenceMeta(id);
          const why = sentenceProblem(id, s.sentences[id], out);
          if (why) { bad((meta ? meta.label + ': ' : '') + why); return; }
          if (s.sentences[id] !== meta.defaultText) out.sentences[id] = s.sentences[id];
        });
      }
    }
    return out;
  }

  // normalizeSettings(s) -> the settings draft() uses: every part that passes
  // its guard, the default for every part that does not. Never throws.
  function normalizeSettings(s) {
    return walkSettings(s, function () {});
  }

  // checkSettings(s) -> '' when every part passes, else the first problem.
  // Saving and importing refuse anything this refuses.
  function checkSettings(s) {
    let first = '';
    walkSettings(s, function (m) { if (!first) first = m; });
    return first;
  }

  // sentenceText(settings, id) -> the sentence draft() uses.
  function sentenceText(settings, id) {
    const cfg = normalizeSettings(settings);
    return Object.prototype.hasOwnProperty.call(cfg.sentences, id) ? cfg.sentences[id] : sentenceMeta(id).defaultText;
  }

  function isBuiltInMedical(v) {
    return MEDICAL_LANGUAGE.indexOf(v) !== -1 || SICK_REASON_LANGUAGE.indexOf(v) !== -1 ||
      MEDICAL_ABBREVIATIONS.some(function (a) { return a.toLowerCase() === v; });
  }

  // changeSettings(settings, change) -> { ok, settings, message }. One change
  // from the Settings panel. A refused change returns the settings unchanged
  // and the reason. change = { action, id?, value? }:
  //   setSentence / resetSentence (id), setNaming, setSickPatternMin,
  //   addMedicalWord / removeMedicalWord, addStationPhrase /
  //   removeStationPhrase, addReason / removeReason (value).
  function changeSettings(settings, change) {
    const cur = normalizeSettings(settings);
    const next = JSON.parse(JSON.stringify(cur));
    const c = change || {};
    let why = '';
    function removeFrom(key, value, builtIn, noun) {
      const v = key === 'extraReasons' ? cleanReason(value) : cleanTerm(value == null ? '' : value);
      if (builtIn(v)) return 'Built-in ' + noun + ' cannot be removed. Only ones added here can.';
      const at = next[key].indexOf(v);
      if (at === -1) return '"' + v + '" is not on your list.';
      next[key].splice(at, 1);
      return '';
    }
    switch (c.action) {
      case 'setSentence':
        why = sentenceProblem(c.id, c.value, cur);
        if (!why) {
          if (c.value === sentenceMeta(c.id).defaultText) delete next.sentences[c.id];
          else next.sentences[c.id] = c.value;
        }
        break;
      case 'resetSentence':
        if (!sentenceMeta(c.id)) why = 'That is not a sentence the Settings can change.';
        else delete next.sentences[c.id];
        break;
      case 'setNaming':
        if (c.value !== 'first' && c.value !== 'admin') why = 'Pick First name or "Admin".';
        else next.naming = c.value;
        break;
      case 'setSickPatternMin':
        why = sickPatternMinProblem(c.value);
        if (!why) next.sickPatternMin = c.value;
        break;
      case 'addMedicalWord':
        why = extraMedicalWordProblem(c.value, cur.extraMedicalWords);
        if (!why) next.extraMedicalWords.push(cleanTerm(c.value));
        break;
      case 'removeMedicalWord':
        why = removeFrom('extraMedicalWords', c.value, isBuiltInMedical, 'medical words');
        break;
      case 'addStationPhrase':
        why = stationPhraseProblem(c.value, cur);
        if (!why) next.stationPhrases.push(cleanTerm(c.value));
        break;
      case 'removeStationPhrase':
        why = removeFrom('stationPhrases', c.value, function (v) { return STATION_TERMS.indexOf(v) !== -1; }, 'station phrases');
        break;
      case 'addReason':
        why = extraReasonProblem(c.value, cur.extraReasons, cur);
        if (!why) next.extraReasons.push(cleanReason(c.value));
        break;
      case 'removeReason':
        why = removeFrom('extraReasons', c.value, function (v) {
          return REASONS.some(function (r) { return r.toLowerCase() === v.toLowerCase(); });
        }, 'Reasons');
        break;
      default:
        why = 'That is not a change the Settings can make.';
    }
    // The whole result passes the same guard a save and an import run.
    if (!why) why = checkSettings(next);
    if (why) return { ok: false, settings: cur, message: why };
    return { ok: true, settings: normalizeSettings(next), message: '' };
  }

  // ── Checks ───────────────────────────────────────────────────────────────
  //
  // Each check is { id, ok, message } (plus fieldId and fix where they name a
  // box). They judge the FINAL text (generated or hand-edited) whatever is
  // ticked, never block anything, and only speak up when something is
  // actually wrong.

  function runChecks(fields, hv, draftedDates, allowedDates, docTypeId, sickRelated, names, performance, cfg) {
    const finalLine = sentenceText(cfg, 'finalNotice');
    const fieldsById = {};
    fields.forEach(function (f) { fieldsById[f.id] = f.text; });
    // The box that carries the citation and the one that lists prior
    // discipline: Discipline Details on a Notice, Incident Detailed
    // Description and Previous Counseling Given on a Documented Discussion.
    const type = DOC_TYPES[docTypeId];
    const citeField = type.citationField;
    const citeLabel = type.fields.filter(function (f) { return f.id === citeField; })[0].label;
    const details = fieldsById[citeField] || '';
    const priorText = fieldsById[type.priorField] || '';
    const cited = details.indexOf(CITATION) !== -1;
    const checks = [];
    // With nothing drafted only edited boxes are judged; an empty Discipline
    // Details is then not "missing" a citation, it is simply not written.
    if (draftedDates.length || details !== '') {
      checks.push({
        id: 'policy-010',
        ok: cited,
        message: cited
          ? 'POLICY-010 cited'
          : 'POLICY-010 is not cited. ' + citeLabel + ' should end with "' + CITATION + '"',
      });
    }
    // The citation belongs in Discipline Details, once across the whole draft
    // (#1104 review): Discipline Details is fixed first, and another box's
    // wrong sentence is then removed, not turned into a second citation, when
    // Discipline Details cites POLICY-010 (or will, after its own fix).
    const fixedText = {};
    const ordered = fields.filter(function (f) { return f.id === citeField; })
      .concat(fields.filter(function (f) { return f.id !== citeField; }));
    const citationChecks = {};
    ordered.forEach(function (f) {
      let elsewhere = false;
      if (f.id !== citeField) {
        elsewhere = fields.some(function (o) {
          if (o.id === f.id) return false;
          const t = Object.prototype.hasOwnProperty.call(fixedText, o.id) ? fixedText[o.id] : (o.text || '');
          return t.indexOf(CITATION) !== -1;
        });
      }
      const c = wrongCitationCheck(f, elsewhere);
      fixedText[f.id] = c ? c.fix.text : (f.text || '');
      if (c) citationChecks[f.id] = c;
    });
    fields.forEach(function (f) { if (citationChecks[f.id]) checks.push(citationChecks[f.id]); });
    dateChecks(fields, draftedDates, allowedDates).forEach(function (c) { checks.push(c); });

    // The final-notice line follows the document type (#1104 review). A hand
    // edit survives a type change, so a Final Notice can lose the line and a
    // Notice can keep it.
    const ns = fieldsById.nextSteps;
    if (docTypeId && typeof ns === 'string' && (draftedDates.length || ns !== '')) {
      const flat = ns.replace(/\s+/g, ' ').toLowerCase();
      // The line from Settings (#1116), or the built-in one a box edited
      // before the setting changed still holds.
      const saysLine = [finalLine, FINAL_NOTICE_LINE].some(function (l) {
        return flat.indexOf(l.replace(/\s+/g, ' ').toLowerCase()) !== -1;
      });
      if (docTypeId === 'final' && !saysLine) {
        checks.push({
          id: 'final-notice',
          ok: false,
          fieldId: 'nextSteps',
          // A line from Settings need not end with a full stop (#1119).
          message: 'This is a Final Notice, but Next Steps does not say "' + finalLine + '"' +
            (/[.!?]$/.test(finalLine.trim()) ? '' : '.') + ' Add it, or Reset Next Steps.',
        });
      } else if (docTypeId !== 'final' && FINAL_NOTICE_WORDS_RE.test(sickNormalize(flat))) {
        checks.push({
          id: 'final-notice',
          ok: false,
          fieldId: 'nextSteps',
          message: 'This is a ' + DOC_TYPES[docTypeId].label + ', but Next Steps calls it a final notice. Take that out, or Reset Next Steps.',
        });
      }
    }

    // Prior discipline is listed when history has any in the last 12 months
    // (design "Checks"). Judged on the final text: each writeup counts as
    // listed when a "Prior discipline" sentence is there and its date is in
    // the text. Only present when there is something to list.
    if (hv.priorIn12.length && (draftedDates.length || details !== '' || priorText !== '')) {
      // The whole sentence lead, not just a date: an incident can fall on the
      // day a prior writeup was issued, and its date is in the text anyway.
      const missing = hv.priorIn12.filter(function (h) {
        return priorText.indexOf('Prior discipline: ' + issuedPhrase(h)) === -1;
      });
      checks.push({
        id: 'prior-discipline',
        ok: missing.length === 0,
        message: missing.length === 0
          ? 'Prior discipline listed'
          : 'Prior discipline in the last 12 months is not listed: ' + missing.map(issuedPhrase).join('; ') + '.',
      });
    }

    // SICK LANGUAGE (#1094, review round 1 D3). Every box is judged on its
    // own, generated or hand-edited, so one clean box never covers for
    // another. The medical list runs on EVERY draft; the reason and note list
    // only on a sick-related one. Green only on a sick-related draft (so
    // Tyler sees it ran there); elsewhere it speaks only when it finds one.
    const dirty = [];
    fields.forEach(function (f) {
      const words = sickWords(f.text, { reason: sickRelated, names: names, extra: cfg.extraMedicalWords, allow: cfg.stationPhrases });
      if (!words.length) return;
      dirty.push({
        id: 'sick-language',
        ok: false,
        fieldId: f.id,
        message: f.label + ' has ' + listPhrase(words.map(function (w) { return '"' + w + '"'; })) + '. ' +
          (sickRelated ? SICK_LANGUAGE_WARNING : MEDICAL_LANGUAGE_WARNING),
      });
    });
    if (dirty.length) dirty.forEach(function (c) { checks.push(c); });
    else if (sickRelated) checks.push({ id: 'sick-language', ok: true, message: 'Facts only: no medical or note language' });

    // INSUBORDINATION (#1095). On a Performance draft every box is judged on
    // its own, generated or hand-edited, and a hit names the box. Quiet
    // otherwise: nothing to say until the word is there.
    if (performance) {
      fields.forEach(function (f) {
        if (!hasInsubordination(f.text)) return;
        checks.push({
          id: 'insubordination',
          ok: false,
          fieldId: f.id,
          message: f.label + ' says "insubordination". ' + INSUBORDINATION_WARNING,
        });
      });
    }

    // The checked incidents are already in a saved writeup.
    if (hv.self.length) {
      checks.push({
        id: 'already-saved',
        ok: false,
        message: 'These incidents are already saved in history: ' + hv.self.map(issuedPhrase).join('; ') + '.',
      });
    } else if (hv.overlap.length) {
      const h = hv.overlap[hv.overlap.length - 1];
      const shared = hv.overlapDates;
      checks.push({
        id: 'already-saved',
        ok: false,
        message: shared.map(formatDate).join(', ') + (shared.length === 1 ? ' is' : ' are') +
          ' already in a saved writeup: ' + issuedPhrase(h) + '.',
      });
    }
    return checks;
  }

  // ── THE SEAM ─────────────────────────────────────────────────────────────

  // draft(input) -> {
  //   empty,          true when nothing checked ends up in the text
  //   suggestion: { docType, reason, text, noHistory, noticeCount }
  //                   from this admin's history (#1092). docType is null when
  //                   a Final Notice is in the last 12 months: the policy's
  //                   next step is termination and nothing is pre-selected.
  //   docType, docTypeLabel,   the chosen type, else the suggestion's; null
  //                   and '' when neither names one (then there are no fields)
  //   picks: { reason, rating, related, periodStart, periodEnd, periodDate },
  //                   the period covers ONLY the incidents in the text;
  //                   related is the most recent prior writeup
  //                   ({ id, date, docType, label, reason, text }) or null
  //   fields: [{ id, label, text, edited }],   Workday order
  //   checks: [{ id, ok, message, fieldId?, fix? }], fix on 'wrong-citation'
  //                   is { fieldId, label, sentences, removed, text }: the
  //                   sentences touched, the exact pieces Replace removes,
  //                   and the box text after it
  //   scheduleNote,   '' or the quiet hint that the admin's scheduled days are
  //                   not set, on a draft that would carry the work schedule
  //                   line (#1112). Not a check, never a warning.
  //   notDrafted: [{ id, date, kind, message }],  checked but left out of the
  //                   text (Protected Sick Time), so the page can say why
  //   pattern: { counts, protectedSick, text },   this admin's last 30 days
  //                   from attendance-rules, checked or not
  //   habitual,       the toggle as drafted (false unless input.habitual === true)
  //   habitualNote,   '' or the line saying the checked incidents meet the
  //                   house standard
  //   history: { empty, entries: [{ id, date, docType, label, reason, source,
  //                   line }] newest first, noticeCount, text }   the panel
  //   saveRefusal,    '' or the sentence saying why Save is refused: the
  //                   ticked incidents are already a saved writeup (any type)
  //   saveRecord,     what "Save to history" stores ({ adminId, date: today,
  //                   docType, reason, incidentDates, incidentIds,
  //                   incidentKinds, sickPattern, source: 'drafted' }), or
  //                   null when there is nothing to save
  // }
  //
  // input = {
  //   admin: { id, name, workDays? },  workDays: weekday numbers, 0 = Sunday
  //                          .. 6 = Saturday, the days the admin is scheduled
  //   incidents: [...],      this admin's incidents (others are ignored)
  //   checkedIds: [...],     which incidents this writeup covers
  //   history: [...],        writeup history ({ id, adminId, date, docType,
  //                          reason, incidentDates, incidentIds?,
  //                          incidentKinds?, sickPattern?, source }); others' ignored
  //   docType: null|'notice'|'final'|'discussion'  null (or unknown) means "use the suggestion"
  //   habitual: false,       "Document as habitual"; only Tyler turns it on
  //   naming: 'first'|'admin',
  //   today: 'YYYY-MM-DD',   the pattern and 12/18-month windows end here;
  //                          never a clock read
  //   edits: { fieldId: text }  a hand-edited box's text, which replaces the
  //                             generated text and is what the checks judge
  // }
  function draft(input) {
    const inp = input || {};
    const admin = inp.admin || { id: '', name: '' };
    const checked = new Set((inp.checkedIds || []).map(String));
    const edits = inp.edits || {};
    const habitual = inp.habitual === true;
    const name = nameFor(admin, inp.naming);
    // Settings (#1116): every part that fails its guard reads as the default,
    // and the sick-pattern floor is applied again here.
    const cfg = normalizeSettings(inp.settings);
    const sickMin = Math.max(SICK_PATTERN_FLOOR, cfg.sickPatternMin);
    const EXPECTATION_TEXT = sentenceText(cfg, 'expectation');
    const CONSEQUENCE_TEXT = sentenceText(cfg, 'consequence');
    const PERFORMANCE_CONSEQUENCE_TEXT = sentenceText(cfg, 'performanceConsequence');

    const mine = (inp.incidents || []).filter(function (inc) {
      return inc && inc.adminId === admin.id && kindOf(inc.kind) && validateIncident(inc) === '';
    });

    const selected = mine
      .filter(function (inc) { return checked.has(String(inc.id)); })
      .slice()
      .sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });

    // Protected Sick Time never reaches the text, the period or the picks,
    // with ONE exception (#1094): sick early departures, ticked on their own
    // under a Documented Discussion Tyler picked, are the sick-pattern
    // Documented Discussion. Ticked under any other type (or the
    // suggestion), or with any other incident, they are left out and the
    // page says why. A protected Call-off is never drafted into anything.
    const sickPicked = inp.docType === 'discussion';
    // Performance entries (#1095) draft only on their own: ticked beside any
    // attendance incident they are left out, and the attendance draft is
    // exactly what it was.
    const perfTicked = selected.filter(isPerformance);
    const attendanceTicked = selected.filter(function (inc) { return !isPerformance(inc); });
    const perfAlone = perfTicked.length > 0 && attendanceTicked.length === 0;
    const perfPlan = perfAlone ? performancePlan(perfTicked) : null;
    const sickTicked = attendanceTicked.filter(isSickEarly);
    const others = attendanceTicked.filter(function (inc) { return !isProtected(inc); });
    // D1 (review round 1): a pattern needs at least two. One sick early
    // departure on its own drafts nothing, and the page says why.
    const sickPattern = sickPicked && sickTicked.length >= sickMin && others.length === 0;
    const performanceDrafted = !!(perfPlan && perfPlan.ok);
    const drafted = performanceDrafted
      ? [perfPlan.instruction].concat(perfPlan.misses)
      : (sickPattern ? sickTicked : others);
    const notDrafted = selected.filter(function (inc) { return drafted.indexOf(inc) === -1; }).map(function (inc) {
      let why = PROTECTED_NOT_DRAFTED;
      if (isPerformance(inc)) {
        why = perfAlone ? perfPlan.whyNot[inc.id] : PERFORMANCE_NOT_MIXED;
      } else if (isSickEarly(inc)) {
        if (!sickPicked) why = SICK_NOT_IN_NOTICE;
        else why = others.length ? SICK_NOT_MIXED : sickNotAPattern(sickMin);
      }
      return {
        id: inc.id,
        date: formatDate(inc.date),
        kind: inc.kind,
        message: formatDate(inc.date) + ' ' + kindOf(inc.kind).label +
          (isPerformance(inc) ? ' ' + (inc.role === 'instruction' ? 'Instruction' : 'Miss') : '') + ' ' + why,
      };
    });
    // Sick-related: any ticked incident is Protected Sick Time. Only then is
    // the sick-language check run (see SICK_LANGUAGE).
    const sickRelated = selected.some(isProtected);

    const empty = drafted.length === 0;
    const draftedDates = [];
    drafted.forEach(function (inc) { if (draftedDates.indexOf(inc.date) === -1) draftedDates.push(inc.date); });

    // History decides the suggestion; Tyler's pick (any known type) wins.
    const hv = historyView(admin, inp.history, drafted, inp.today, sickPattern);
    const picked = typeof inp.docType === 'string' && Object.prototype.hasOwnProperty.call(DOC_TYPES, inp.docType);
    // Ticking the incidents of an already-saved writeup shows ITS type (so
    // copying an overridden Final gives Final text), not the suggestion.
    const savedNow = hv.saved.length ? hv.saved[hv.saved.length - 1] : null;
    const savedType = savedNow && Object.prototype.hasOwnProperty.call(DOC_TYPES, savedNow.docType) ? savedNow.docType : null;
    const docTypeId = picked ? inp.docType : (savedType || hv.suggestion.docType);
    const docType = docTypeId ? DOC_TYPES[docTypeId] : null;

    const generated = {};
    const picks = picksFor(drafted, habitual);

    // The work schedule line (#1112): only on a draft that holds a Call-off,
    // an NCNS or the sick pattern, and only when the admin's days are set.
    // Never on Late or Performance. scheduleNote is the quiet "add it" hint
    // for the same drafts when the days are not set.
    const workDays = cleanWorkDays(admin.workDays);
    const wantsSchedule = !empty && !performanceDrafted &&
      (sickPattern || drafted.some(function (inc) { return absenceKind(inc.kind); }));
    const scheduleSentence = wantsSchedule && workDays.length
      ? withName(sentenceText(cfg, 'scheduleLine'), name).replace(/\{days\}/g, function () { return workDaysText(workDays); })
      : '';
    const scheduleNote = wantsSchedule && !workDays.length
      ? 'Add ' + firstName(admin.name) + "'s scheduled days to include the work schedule line"
      : '';
    // Off-schedule (#1112): a checked Call-off, NCNS or sick early departure
    // on a weekday the admin is not scheduled. Catches a stale schedule or a
    // wrong date. A warning only; nothing blocks Copy.
    const offSchedule = workDays.length ? selected.filter(function (inc) {
      return offScheduleKind(inc.kind) && workDays.indexOf(weekdayOf(inc.date)) === -1;
    }).map(function (inc) {
      return {
        id: 'off-schedule',
        ok: false,
        message: formatDate(inc.date) + ' is a ' + WEEKDAY_LONG[weekdayOf(inc.date)] + ', which is not one of ' +
          firstName(admin.name) + "'s scheduled days",
      };
    }) : [];

    if (!empty) {
      const parts = [];
      // Kinds in the order they first appear (drafted is oldest first).
      const kindIds = [];
      drafted.forEach(function (inc) { if (kindIds.indexOf(inc.kind) === -1) kindIds.push(inc.kind); });
      if (performanceDrafted) {
        // The instruction, each miss, then the one documented-as line.
        performanceFacts(perfPlan, name, admin).forEach(function (s) { parts.push(s); });
        parts.push(PERFORMANCE_DOCUMENTED_AS);
      } else if (kindIds.length === 1) {
        // One kind: its facts as one sentence or list, then its documented-as line.
        const list = drafted;
        parts.push(WORDING[kindIds[0]].facts(list, name));
        if (scheduleSentence) parts.push(scheduleSentence);
        parts.push(WORDING[kindIds[0]].documentedAs(list, habitual));
      } else {
        // Mixed kinds: every incident in date order (oldest first), one
        // sentence each, then one documented-as line per kind.
        drafted.forEach(function (inc) { parts.push(WORDING[inc.kind].facts([inc], name)); });
        if (scheduleSentence) parts.push(scheduleSentence);
        kindIds.forEach(function (id) {
          const list = drafted.filter(function (inc) { return inc.kind === id; });
          parts.push(WORDING[id].documentedAs(list, habitual));
        });
      }
      parts.push(CITATION);
      const prior = priorSentences(hv.priorIn12, reasonsFor(cfg));
      // Notice / Final Notice: prior discipline comes AFTER the citation
      // (design "Wording").
      generated.disciplineDetails = parts.concat(prior).join(' ');
      // Performance replaces the first Next Steps sentence with the
      // instruction as an expectation (#1095).
      const expectation = performanceDrafted
        ? withStop(withName(PERFORMANCE_EXPECTATION, name).replace('{instruction}', function () { return perfInstruction(perfPlan.instruction.text); }))
        : withName(EXPECTATION_TEXT, name);
      generated.nextSteps = expectation + ' ' + (performanceDrafted ? PERFORMANCE_CONSEQUENCE_TEXT : CONSEQUENCE_TEXT);
      // The Final Notice line comes from Settings (#1116).
      const closing = docTypeId === 'final' ? sentenceText(cfg, 'finalNotice') : (docType ? docType.nextStepsClosing : '');
      if (closing) generated.nextSteps += ' ' + closing;
      // Documented Discussion (#1094): the facts and the citation, prior
      // discipline in its own box (empty when there is none), and the
      // expectation and consequence in theirs. A sick pattern has its own
      // expectation and consequence: protected time is never "unexcused".
      generated.incidentDescription = parts.join(' ');
      generated.previousCounseling = prior.join(' ');
      generated.requiredAction = performanceDrafted ? expectation : withName(sickPattern ? SICK_EXPECTATION : EXPECTATION_TEXT, name);
      generated.consequences = performanceDrafted ? PERFORMANCE_CONSEQUENCE_TEXT : (sickPattern ? SICK_CONSEQUENCE : CONSEQUENCE_TEXT);
    }

    const fields = (docType ? docType.fields : []).map(function (f) {
      const isEdited = typeof edits[f.id] === 'string';
      return {
        id: f.id,
        label: f.label,
        text: isEdited ? edits[f.id] : (generated[f.id] || ''),
        edited: isEdited,
      };
    });

    // The dates the text may state: each drafted incident's shift date, and
    // the calendar date a Late punched past midnight names.
    const allowedDates = draftedDates.slice();
    drafted.forEach(function (inc) {
      if ((inc.kind === 'late' && punchIsNextDay(inc.scheduledStart, inc.clockIn)) ||
        (inc.kind === 'sickearly' && inc.clockOutNextDay)) {
        const d = nextDay(inc.date);
        if (allowedDates.indexOf(d) === -1) allowedDates.push(d);
      }
    });
    // The checks judge what Tyler will paste: a hand-edited box is judged
    // even when nothing is ticked (#1101 review).
    const anyEdited = fields.some(function (f) { return f.edited; });

    const first = empty ? '' : formatDate(drafted[0].date);
    const last = empty ? '' : formatDate(drafted[drafted.length - 1].date);

    return {
      empty: empty,
      suggestion: hv.suggestion,
      docType: docTypeId,
      docTypeLabel: docType ? docType.label : '',
      picks: {
        reason: picks.reason,
        rating: docType && docType.hasRating ? picks.rating : '',
        related: hv.related,
        periodStart: first,
        periodEnd: last,
        periodDate: first === last ? first : first + ' - ' + last,
      },
      fields: fields,
      checks: (!docType || (empty && !anyEdited) ? [] : runChecks(fields, hv, draftedDates, allowedDates, docTypeId, sickRelated, nameTokens(admin), perfAlone, cfg))
        .concat(offSchedule),
      scheduleNote: scheduleNote,
      notDrafted: notDrafted,
      sickPattern: sickPattern && !empty,
      pattern: pattern(mine, inp.today),
      habitual: habitual,
      habitualNote: habitualNote(selected),
      history: hv.panel,
      saveRefusal: !empty && savedNow
        ? 'These incidents are already saved as ' + issuedPhrase(savedNow) + '. To change the type, delete that writeup from history, then save again.'
        : '',
      saveRecord: empty || !docType || !isIsoDate(inp.today) || savedNow ? null : {
        adminId: admin.id,
        date: inp.today,
        docType: docTypeId,
        reason: picks.reason,
        incidentDates: draftedDates,
        // Review round 1: the ids and kinds, so history matches a writeup
        // to its incidents and never by date alone; and the sick-pattern tag
        // (D2), so protected sick use never raises another writeup.
        incidentIds: drafted.map(function (inc) { return String(inc.id); }),
        incidentKinds: drafted.map(function (inc) { return inc.kind; }),
        sickPattern: sickPattern,
        source: 'drafted',
      },
    };
  }

  return {
    CITATION: CITATION,
    WRONG_CITATION_RE: WRONG_CITATION_RE,
    hasWrongCitation: hasWrongCitation,
    NEXT_STEPS_DEFAULT: NEXT_STEPS_DEFAULT,
    FINAL_NOTICE_LINE: FINAL_NOTICE_LINE,
    SICK_LANGUAGE: SICK_LANGUAGE,
    MEDICAL_LANGUAGE: MEDICAL_LANGUAGE,
    MEDICAL_ABBREVIATIONS: MEDICAL_ABBREVIATIONS,
    SICK_REASON_LANGUAGE: SICK_REASON_LANGUAGE,
    STATION_TERMS: STATION_TERMS,
    SICK_PATTERN_MIN: SICK_PATTERN_MIN,
    PERFORMANCE_DOCUMENTED_AS: PERFORMANCE_DOCUMENTED_AS,
    hasInsubordination: hasInsubordination,
    workDaysText: workDaysText,
    NO_HISTORY_MESSAGE: NO_HISTORY_MESSAGE,
    DOC_TYPES: DOC_TYPES,
    HISTORY_TYPES: HISTORY_TYPES,
    REASONS: REASONS,
    validateHistoryEntry: validateHistoryEntry,
    // Settings (#1116)
    SETTINGS_SENTENCES: SETTINGS_SENTENCES,
    SETTINGS_FIXED_NOTE: SETTINGS_FIXED_NOTE,
    SICK_PATTERN_FLOOR: SICK_PATTERN_FLOOR,
    SICK_PATTERN_MAX: SICK_PATTERN_MAX,
    defaultSettings: defaultSettings,
    normalizeSettings: normalizeSettings,
    checkSettings: checkSettings,
    changeSettings: changeSettings,
    sentenceProblem: sentenceProblem,
    stationPhraseProblem: stationPhraseProblem,
    sentenceText: sentenceText,
    reasonsFor: reasonsFor,
    extraReasonProblem: extraReasonProblem,
    INCIDENT_KINDS: INCIDENT_KINDS,
    draft: draft,
    validateIncident: validateIncident,
    describeIncident: describeIncident,
    minutesLate: minutesLate,
    formatDate: formatDate,
    isIsoDate: isIsoDate,
    formatTime: formatTime,
    firstName: firstName,
  };
});
