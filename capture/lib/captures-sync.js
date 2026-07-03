'use strict';

// Cross-device sync for Quick-Capture (issue #351, slice 3 of PRD #348).
//
// Two parts, mirroring lib/entries-sync.js's shape:
//   1. PURE merge/tombstone helpers — unit-tested, no DOM, no network.
//   2. A GitHub contents-API adapter that delegates the GET-merge-PUT-with-409
//      transport to lib/github-json-sync.js (the canonical transport, unit-
//      tested), supplying only the captures-specific merge. Coordinates are
//      settings-driven, same as time-off and IBNO (ADR 0005 hosting
//      amendment).
//
// Unlike entries-sync.js there is no device-local field to strip before PUT
// (Captures carries no equivalent of TimeOff's `disposition`) — every field
// on a capture is already repo-safe, so the adapter's `project` step is the
// identity function. If a future slice adds a device-local field, add a
// projection here rather than writing it into the shared JSON.
//
// Dual-loadable with no build step:
// - Browser: window.CapturesSync
// - Node: require('./lib/captures-sync')  (pure helpers only)

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CapturesSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // ─── PURE: merge + tombstones ─────────────────────────────────────────────

  // Newer wins; missing updatedAt sorts oldest. Deterministic on ties.
  function isNewer(a, b) {
    const ax = a && a.updatedAt ? a.updatedAt : '';
    const bx = b && b.updatedAt ? b.updatedAt : '';
    return ax >= bx; // a wins ties — caller passes incoming as `a` to prefer it
  }

  // Union two capture lists by id; for a shared id the record with the
  // higher updatedAt wins (tombstones included, so deletions propagate —
  // "tombstone wins over resurrect" per the AC). Pure; input arrays are not
  // mutated. Returns a fresh array. Idempotent: merging a list with itself
  // (or re-merging the same remote snapshot repeatedly) returns the same set.
  function merge(listA, listB) {
    const byId = {};
    function absorb(list, preferOnTie) {
      (Array.isArray(list) ? list : []).forEach(function (capture) {
        if (!capture || capture.id == null) return;
        const existing = byId[capture.id];
        if (!existing) { byId[capture.id] = capture; return; }
        const incomingWins = preferOnTie
          ? isNewer(capture, existing)
          : !isNewer(existing, capture);
        if (incomingWins) byId[capture.id] = capture;
      });
    }
    absorb(listA, false);
    absorb(listB, true); // listB (remote/incoming) preferred on exact ties
    return Object.keys(byId).map(function (id) { return byId[id]; });
  }

  // ─── IMPURE: GitHub contents API adapter (browser only) ───────────────────
  // Reads/writes one JSON file on a dedicated branch. The token is supplied
  // by the caller (from localStorage); never stored here.

  // Repo coordinates are SETTINGS-DRIVEN, never hard-coded (ADR 0005 hosting
  // amendment): the public GitHub-Pages build must reveal nothing about
  // where the private data lives, so owner/repo/branch come from the user's
  // settings at runtime; only the in-repo file path has a default. This path
  // matches the seeded captures-data orphan branch (captures/captures.json).
  const DEFAULT_PATH = 'captures/captures.json';

  // Resolve + validate user-supplied coordinates into a complete coords
  // object. Throws code 'coords' if any of owner/repo/branch is missing, so
  // a misconfigured device fails loudly instead of writing to the wrong place.
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

  // Lazy-load the shared transport. In the browser it is normally already on
  // root (loaded via <script src>); in Node it is required; otherwise it is
  // injected once. Mirrors lib/entries-sync.js / lib/ibno-sync.js.
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

  function transportCoords(coords) {
    const repo = repoCoords(coords);
    return { owner: repo.owner, repo: repo.repo, branch: repo.branch, path: repo.path };
  }

  // Coerce a remote payload to the captures-array shape this module speaks.
  function capturesPayload(data) {
    return Array.isArray(data) ? data : [];
  }

  // GET current file → { captures, sha }. sha is null when the file does not
  // exist yet (first write creates it). A non-array payload reads as [].
  async function fetchRemote(token, coords) {
    const transport = await getTransport();
    const remote = await transport.fetchRemote(token, transportCoords(coords));
    return { captures: capturesPayload(remote.data), sha: remote.sha };
  }

  // PUT merged content with an expected sha. Returns the new sha. Throws
  // with code 'conflict' on a 409 (stale sha) so the caller can re-fetch and
  // retry. No device-local field needs stripping (see module note above), so
  // there is no `project` parameter — every capture field is repo-safe.
  async function putRemote(token, captures, sha, coords) {
    const transport = await getTransport();
    return transport.putRemote(token, capturesPayload(captures), sha, transportCoords(coords), {
      messagePrefix: 'captures sync',
    });
  }

  // GET-merge-PUT with bounded 409 retry. `local` is the device's current
  // captures; returns the merged result + new sha so the caller can update
  // its cache and remembered sha.
  async function pushMerge(token, local, knownSha, maxRetries, coords) {
    repoCoords(coords); // validate once before the retry loop
    const transport = await getTransport();
    const result = await transport.pushMerge(token, capturesPayload(local), {
      merge: function (remote, current) { return merge(capturesPayload(remote), current); },
      maxRetries: maxRetries,
      knownSha: knownSha,
      messagePrefix: 'captures sync',
      coords: repoCoords(coords),
    });
    return { captures: capturesPayload(result.data), sha: result.sha };
  }

  return {
    // pure
    merge: merge,
    // config + adapter
    repoCoords: repoCoords,
    apiUrl: apiUrl,
    fetchRemote: fetchRemote,
    putRemote: putRemote,
    pushMerge: pushMerge,
  };
});
