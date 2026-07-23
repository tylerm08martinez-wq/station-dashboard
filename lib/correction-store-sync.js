'use strict';

// Cross-device sync for the Address Catcher's Correction Log (issue #425,
// PRD #423, ADR-0018) — the third sync adapter over lib/github-json-sync.js,
// shaped like lib/entries-sync.js (array + updatedAt last-write-wins +
// tombstones), persisting to its OWN dedicated private-repo branch/path
// (corrections-data / corrections/correction-log.json — the attendance-data /
// ibno-data / captures-data pattern).
//
// THE PAYLOAD WALL (ADR-0018's PII reconciliation — a HARD requirement):
// ADR-0016 keeps the raw Standing Report rows (recipient names + tracking +
// addresses) and the re-derivable dictionary device-local. The Correction Log
// is a DISTINCT class — Tyler's non-re-derivable operator judgments — and is
// syncable BECAUSE it carries mapping keys + reason category + note + status
// + updatedAt/tombstone ONLY: no recipient names, no tracking numbers. This
// adapter enforces that with a field WHITELIST applied to EVERY record before
// EVERY PUT (payloadRecord below) — the wall does not depend on caller
// discipline, and any stray field a page bug might bolt onto a record is
// dropped at the boundary. Locked by tests/correction-store-sync.test.js.
//
// Two parts (mirrors entries-sync.js):
//   1. PURE helpers — merge (delegating to CorrectionLog.merge, the model's
//      canonical LWW-by-mapping-key), the payload projection, coords.
//   2. A GitHub contents-API adapter delegating GET-merge-PUT-with-409 to
//      lib/github-json-sync.js (the canonical transport), supplying only the
//      correction-specific merge + whitelist projection.
//
// Dual-loadable with no build step:
// - Browser: window.CorrectionStoreSync (load lib/correction-log.js first)
// - Node: require('./lib/correction-store-sync')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CorrectionStoreSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // ─── The pure model (merge semantics live in lib/correction-log.js) ───────
  // Reused, never re-forked: CorrectionLog.merge is the ONE definition of
  // LWW-by-mapping-key + tombstone propagation, shared by the tool and this
  // adapter. In the browser the tool's <script> order loads correction-log.js
  // first; under Node it is required.
  function getModel() {
    if (root && root.CorrectionLog) return root.CorrectionLog;
    if (typeof require === 'function') return require('./correction-log');
    throw new Error('CorrectionLog unavailable — load lib/correction-log.js before lib/correction-store-sync.js');
  }

  // ─── PURE: merge + change detection ───────────────────────────────────────

  // Union two logs by mapping key; higher updatedAt wins (tombstones included,
  // so un-rejects propagate). Ties prefer listA — pass the side you want to
  // prefer first (the tool passes local first, like the captures adapter).
  function merge(listA, listB) {
    return getModel().merge(listA, listB);
  }

  // Does `local` hold anything the `remote` list doesn't already have at the
  // same updatedAt? Used to skip a redundant PUT (and empty commit) on load.
  function hasLocalChanges(local, remote) {
    const remoteByKey = {};
    (Array.isArray(remote) ? remote : []).forEach(function (r) {
      if (r && r.key != null) remoteByKey[r.key] = r.updatedAt || '';
    });
    return (Array.isArray(local) ? local : []).some(function (r) {
      if (!r || r.key == null) return false;
      const seen = remoteByKey[r.key];
      return seen === undefined || (r.updatedAt || '') > seen;
    });
  }

  // ─── PURE: the payload wall ────────────────────────────────────────────────

  // The COMPLETE set of fields a synced record may carry. `original` and
  // `corrected` are the mapping's two ADDRESS sides (they ARE the key, in
  // display form) — addresses are what the log is about; what must never ride
  // along is recipient names and tracking numbers, and a whitelist excludes
  // those by construction rather than trying to enumerate every bad field.
  //
  // Area Verdict Loop (issue #452): `kind` ('area' for a per-area-card
  // verdict), `areaKey` (the Area Dictionary entry's street+ZIP5 identity), and
  // `area` (the mainly-assigned work-area code) are whitelisted too. All three
  // are the SAME data class as original/corrected (address parts + a work-area
  // number — the mapping IS the key); none is a recipient name or a tracking
  // number. `kind` MUST survive the round-trip so a promoted area verdict
  // pulled from another device is still recognized as an area override
  // (CorrectionOverrides.promotedAreaOverrides filters on kind).
  const PAYLOAD_FIELDS = ['key', 'kind', 'areaKey', 'area', 'original', 'corrected', 'category', 'note', 'status', 'updatedAt', 'tombstone'];

  // Project one record to its repo-safe shape: whitelisted fields only.
  function payloadRecord(rec) {
    const r = rec || {};
    return {
      key: r.key != null ? String(r.key) : '',
      kind: r.kind != null ? String(r.kind) : '',
      areaKey: r.areaKey != null ? String(r.areaKey) : '',
      area: r.area != null ? String(r.area) : '',
      original: r.original != null ? String(r.original) : '',
      corrected: r.corrected != null ? String(r.corrected) : '',
      category: r.category != null ? String(r.category) : null,
      note: r.note != null ? String(r.note) : '',
      status: r.status != null ? String(r.status) : 'logged',
      updatedAt: r.updatedAt != null ? String(r.updatedAt) : '',
      tombstone: r.tombstone === true,
    };
  }

  function recordsPayload(data) {
    return Array.isArray(data) ? data : [];
  }

  // Applied to EVERY PUT below — the wall is the adapter's own invariant.
  function projectPayload(arr) {
    return recordsPayload(arr).map(payloadRecord);
  }

  // ─── Repo coordinates (settings-driven, mirrors entries-sync #116) ────────
  // Owner/repo/branch come from the user's settings at runtime; only the
  // in-repo file path has a default. The dedicated branch is corrections-data
  // (entered in Settings), path corrections/correction-log.json — the same
  // one-branch-per-store pattern as attendance-data and captures-data.
  const DEFAULT_PATH = 'corrections/correction-log.json';

  function repoCoords(input) {
    const c = input || {};
    const owner = String(c.owner == null ? '' : c.owner).trim();
    const repo = String(c.repo == null ? '' : c.repo).trim();
    const branch = String(c.branch == null ? '' : c.branch).trim();
    if (!owner || !repo || !branch) {
      const e = new Error('missing repo coordinates'); e.code = 'coords'; throw e;
    }
    const path = String(c.path == null || c.path === '' ? DEFAULT_PATH : c.path).trim();
    return { owner: owner, repo: repo, branch: branch, path: path };
  }

  function apiUrl(coords) {
    return 'https://api.github.com/repos/' + coords.owner + '/' + coords.repo + '/contents/' + coords.path;
  }

  // ─── IMPURE: GitHub contents API adapter ──────────────────────────────────
  // Delegates transport (GET / sha-checked PUT / bounded 409 retry) to
  // lib/github-json-sync.js. Lazy-load mirrors lib/entries-sync.js.
  let transportPromise = null;
  function getTransport() {
    if (root && root.GithubJsonSync) return Promise.resolve(root.GithubJsonSync);
    if (typeof require === 'function') return Promise.resolve(require('./github-json-sync'));
    if (!transportPromise) {
      transportPromise = new Promise(function (resolve, reject) {
        const doc = root && root.document;
        if (!doc || !doc.createElement) { reject(new Error('GithubJsonSync unavailable')); return; }
        const script = doc.createElement('script');
        script.src = 'lib/github-json-sync.js';
        script.onload = function () {
          if (root.GithubJsonSync) resolve(root.GithubJsonSync);
          else reject(new Error('GithubJsonSync unavailable'));
        };
        script.onerror = function () { reject(new Error('GithubJsonSync unavailable')); };
        doc.head.appendChild(script);
      });
    }
    return transportPromise;
  }

  const MESSAGE_PREFIX = 'correction sync';

  // GET current file → { records, sha }. sha is null when the file does not
  // exist yet (first push creates it). A non-array payload reads as [].
  async function fetchRemote(token, coords) {
    const transport = await getTransport();
    const remote = await transport.fetchRemote(token, repoCoords(coords));
    return { records: recordsPayload(remote.data), sha: remote.sha };
  }

  // PUT content with an expected sha. Returns the new sha; throws code
  // 'conflict' on a 409 so the caller can re-fetch and retry. The payload wall
  // projection is ALWAYS applied — there is no unprojected write path.
  async function putRemote(token, records, sha, coords) {
    const transport = await getTransport();
    return transport.putRemote(token, recordsPayload(records), sha, repoCoords(coords), {
      project: projectPayload,
      messagePrefix: MESSAGE_PREFIX,
    });
  }

  // GET-merge-PUT with bounded 409 retry. `local` is the device's current log;
  // returns the merged result + new sha so the caller can update its cache and
  // remembered sha. On any failure the caller's local log is untouched — the
  // tool keeps working locally and surfaces a warning (SyncController).
  async function pushMerge(token, local, knownSha, maxRetries, coords) {
    const repo = repoCoords(coords); // validate once before the retry loop
    const transport = await getTransport();
    const result = await transport.pushMerge(token, recordsPayload(local), {
      merge: function (remote, current) { return merge(current, remote); }, // local wins exact ties
      project: projectPayload,
      maxRetries: maxRetries,
      knownSha: knownSha,
      messagePrefix: MESSAGE_PREFIX,
      coords: repo,
    });
    return { records: recordsPayload(result.data), sha: result.sha };
  }

  return {
    // pure
    merge: merge,
    hasLocalChanges: hasLocalChanges,
    payloadRecord: payloadRecord,
    PAYLOAD_FIELDS: PAYLOAD_FIELDS,
    // config + adapter
    repoCoords: repoCoords,
    apiUrl: apiUrl,
    fetchRemote: fetchRemote,
    putRemote: putRemote,
    pushMerge: pushMerge,
  };
});
