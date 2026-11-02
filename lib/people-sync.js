'use strict';

// People list repo working copy (#1124, ADR 0024).
//
// THE REPO FILE IS THE SOURCE OF TRUTH; THIS BROWSER HOLDS A WORKING COPY.
// The People page loads the station list from one JSON file in a private repo
// (the People backup format lib/people.js already writes and checks) and saves
// edits back to it. Everything about WHERE that file is (owner, repo, branch,
// path) and the token live in this browser only, under the people_gh_* keys.
// Nothing here names an owner, repo, branch, token or person: the public
// dashboard bundle ships this file, and its deploy guard aborts on any of them.
//
// Built on the shared pieces as they are (ADR 0014): lib/sync-controller.js
// owns the token/coords/sha lifecycle, lib/github-json-sync.js the transport.
// This file adds only what the People list needs on top:
//
//   PULL (page load, or Reload). The remote is classified first, and nothing
//   below ever touches the local list unless the remote is a valid People file:
//     fetch fails, 401/403, 5xx, not JSON,   -> 'error' / 'invalid'; local list
//     wrong format/version, bad person,          untouched; sha NOT remembered,
//     duplicate                                  so a later save is refused
//     404                                    -> 'missing'; local untouched; a
//                                               save creates the file
//     valid, local list unreadable           -> 'recover'; nothing written. The
//                                               page offers the recover flow
//                                               with the repo's list as the
//                                               backup (raw text saved first)
//     valid, unsaved local edits             -> 'choose'; nothing written. The
//                                               person picks: use the repo's
//                                               list, or save theirs over it
//                                               The choice is stored as unsaved (dirty), so it
//                                               survives the next pull and reload
//     valid, nothing unsaved (or identical)  -> 'replace'; the local list
//                                               becomes the repo's
//
//   SAVE. One PUT with the last-known sha (null only when the file is missing,
//   which creates it). A 409, or GitHub's 422 for a sha that does not match,
//   refuses: nothing is retried, re-fetched or overwritten, and the local list
//   and its unsaved mark stay. Success stores the new sha and clears the mark.
//
//   UNSAVED. Every successful edit through `store` (add, update, remove, seed,
//   import, recover from a FILE) sets people_gh_dirty. A non-empty list this
//   device never saved or loaded (no known sha) counts as unsaved too, so a
//   list kept here before the repo was set up is never replaced silently.
//
// The token is passed to the transport and nowhere else: it is never in a
// result, an error, an export or console output.
//
// Dual-loadable with no build step:
// - Browser: window.PeopleSync (load lib/people.js, lib/github-json-sync.js and
//   lib/sync-controller.js first)
// - Node:    require('./lib/people-sync')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PeopleSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  function dep(name, file) {
    if (root && root[name]) return root[name];
    if (typeof require === 'function') return require(file);
    throw new Error('PeopleSync: ' + name + ' is not loaded');
  }
  const People = dep('People', './people');
  const SyncController = dep('SyncController', './sync-controller');
  const GithubJsonSync = dep('GithubJsonSync', './github-json-sync');

  const KEYS = {
    token: 'people_gh_token',
    coords: 'people_gh_coords',
    sha: 'people_gh_sha',
    path: 'people_gh_path',
    dirty: 'people_gh_dirty',
    loadedAt: 'people_gh_loaded_at',
  };
  const DEFAULT_PATH = 'notes/people.json';
  const PUT_OPTS = { messagePrefix: 'People list saved from the People page' };

  // JSON over a raw Web Storage, in the shape SyncController expects.
  function jsonStorage(raw) {
    return {
      get: function (k, fb) {
        try { const v = raw.getItem(k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; }
      },
      set: function (k, v) { try { raw.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
      remove: function (k) { try { raw.removeItem(k); } catch (e) {} },
    };
  }

  // checkSettings(input) -> { ok, settings } | { ok: false, error }. Blank
  // owner/repo/branch are allowed (sync stays off); a value given must be a
  // plain GitHub name, and the path a relative .json file path.
  function checkSettings(input) {
    const s = input || {};
    const owner = String(s.owner == null ? '' : s.owner).trim();
    const repo = String(s.repo == null ? '' : s.repo).trim();
    const branch = String(s.branch == null ? '' : s.branch).trim();
    let path = String(s.path == null ? '' : s.path).trim().replace(/^\/+/, '');
    if (!path) path = DEFAULT_PATH;
    if (owner && !/^[A-Za-z0-9-]{1,39}$/.test(owner)) return { ok: false, error: 'bad-owner' };
    if (repo && !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) return { ok: false, error: 'bad-repo' };
    if (branch && !/^[A-Za-z0-9_./-]{1,100}$/.test(branch)) return { ok: false, error: 'bad-branch' };
    if (!/^[A-Za-z0-9_./-]+\.json$/.test(path) || path.split('/').some(function (seg) { return seg === '' || seg === '.' || seg === '..'; })) {
      return { ok: false, error: 'bad-path' };
    }
    return { ok: true, settings: { owner: owner, repo: repo, branch: branch, path: path } };
  }

  // Same people, ids included, in any order.
  function samePeople(a, b) {
    function canon(list) {
      return People.exportFile(list.slice().sort(function (x, y) { return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; }));
    }
    return canon(a) === canon(b);
  }

  // classifyRemote({ data, sha }) -> what the repo holds, decided before
  // anything local is looked at. A 404 is the only sha-less answer.
  function classifyRemote(remote) {
    if (!remote || remote.sha == null) return { kind: 'missing' };
    let text = null;
    try { text = JSON.stringify(remote.data); } catch (e) { text = null; }
    const chk = People.inspectFile(text);
    if (!chk.ok) return { kind: 'invalid', error: chk.error };
    return { kind: 'ok', people: chk.people, text: text };
  }

  // decidePull(local, remote) -> action. Pure. local: { state, people, unsaved }.
  function decidePull(local, remote) {
    if (remote.kind === 'missing') return 'missing';
    if (remote.kind !== 'ok') return 'invalid';
    if (local.state === 'unreadable') return 'recover';
    if (local.unsaved && !samePeople(local.people, remote.people)) return 'choose';
    return 'replace';
  }

  function isConflict(e) {
    return !!e && (e.code === 'conflict' || (e.code === 'http' && /\b422\b/.test(String(e.message))));
  }
  // An error the page can show: a code and, for HTTP, the status. Never the
  // transport's own object (or anything it might carry).
  function plainError(e) {
    if (!e) return { code: 'network' };
    if (isConflict(e)) return { code: 'conflict' };
    if (e.code === 'auth' || e.code === 'coords' || e.code === 'invalid' || e.code === 'unreadable' || e.code === 'storage') {
      return { code: e.code, detail: e.detail || null };
    }
    if (e.code === 'http') {
      const m = /\b(\d{3})\b/.exec(String(e.message));
      return { code: 'http', status: m ? Number(m[1]) : null };
    }
    return { code: 'network' };
  }
  function fail(code, detail) { const e = new Error(code); e.code = code; if (detail) e.detail = detail; return e; }

  // create({ storage, store?, now? }) -> the People page's sync. storage is the
  // raw localStorage (the same one the People store reads).
  function create(opts) {
    const o = opts || {};
    const raw = o.storage;
    const js = jsonStorage(raw);
    const base = o.store || People.createStore(raw);
    const now = typeof o.now === 'function' ? o.now : function () { return new Date(); };

    let ctl = null;
    let lastPull = null;     // what the running pull found
    let lastPush = null;     // what the running save found
    let pending = null;      // the valid remote from the last pull, for choose/recover

    function getPath() {
      const p = js.get(KEYS.path, '');
      return typeof p === 'string' && p ? p : DEFAULT_PATH;
    }
    function withPath(coords) { return Object.assign({}, coords, { path: getPath() }); }

    function snapshot() {
      const st = base.status();
      const people = st === 'unreadable' ? [] : base.list();
      return { state: st, people: people, unsaved: unsavedFor(st, people) };
    }
    function unsavedFor(st, people) {
      if (js.get(KEYS.dirty, false) === true) return true;
      return st === 'ok' && people.length > 0 && !(ctl && ctl.knownSha());
    }

    function build() {
      ctl = SyncController.create({
        storage: js,
        keys: { token: KEYS.token, coords: KEYS.coords, sha: KEYS.sha },
        debounceMs: 0,
        adapter: {
          fetch: async function (token, coords) {
            let remote;
            try {
              remote = await GithubJsonSync.fetchRemote(token, withPath(coords));
            } catch (e) {
              lastPull = { action: 'error', error: plainError(e) };
              throw e;
            }
            const cls = classifyRemote(remote);
            if (cls.kind === 'invalid') {
              lastPull = { action: 'invalid', error: { code: 'invalid', detail: cls.error } };
              throw fail('invalid', cls.error);
            }
            return { data: cls, sha: cls.kind === 'missing' ? null : remote.sha };
          },
          // The pull's decision; nothing is written here.
          mergeLocal: function (remote, local) {
            return { action: decidePull(local, remote), remote: remote };
          },
          push: async function (token, local, sha, coords) {
            const text = base.exportText();
            if (text == null) { lastPush = { ok: false, error: { code: 'unreadable' } }; throw fail('unreadable'); }
            const payload = JSON.parse(text);
            let newSha;
            try {
              newSha = await GithubJsonSync.putRemote(token, payload, sha, withPath(coords), PUT_OPTS);
            } catch (e) {
              lastPush = { ok: false, error: plainError(e) };
              if (isConflict(e)) { throw fail('conflict'); }
              throw e;
            }
            return { data: payload, sha: newSha };
          },
        },
        getLocal: snapshot,
        setLocal: function (data, phase) {
          if (phase === 'push') {
            // Clear the mark only when no edit landed while the save was out.
            const cur = base.exportText();
            if (cur != null && samePeople(JSON.parse(cur).people, data.people)) js.remove(KEYS.dirty);
            lastPush = { ok: true, count: data.people.length };
            return;
          }
          const d = data;
          pending = d.remote.kind === 'ok' ? d.remote : null;
          if (d.action === 'replace') {
            const r = base.importText(d.remote.text);
            if (!r.ok) {
              lastPull = { action: 'error', error: { code: r.error === 'unreadable' ? 'unreadable' : 'storage' } };
              // Thrown so the controller does not remember a sha the local
              // list does not hold.
              throw fail('storage');
            }
            js.remove(KEYS.dirty);
            js.set(KEYS.loadedAt, now().toISOString());
            lastPull = { action: 'replace', count: r.count };
            return;
          }
          // A choice is pending: the local list is unsaved even if this device
          // never marked it. Persist that, or the NEXT pull (which now knows
          // the sha) would see a clean list and replace it without asking. The
          // sha is kept, so "Save mine" still sends it.
          if (d.action === 'choose') js.set(KEYS.dirty, true);
          lastPull = { action: d.action, count: d.remote.kind === 'ok' ? d.remote.people.length : 0 };
        },
      });
    }
    build();

    function settings() {
      const c = ctl.getCoords() || {};
      return { owner: c.owner || '', repo: c.repo || '', branch: c.branch || '', path: getPath(), hasToken: !!ctl.getToken() };
    }

    // saveSettings({ token, owner, repo, branch, path }). A blank token keeps
    // the one already saved (the page never shows it back). Moving to another
    // repo, branch or path forgets the sha, so nothing learnt about one file
    // is ever sent to another.
    function saveSettings(input) {
      const chk = checkSettings(input);
      if (!chk.ok) return chk;
      const s = chk.settings;
      const before = settings();
      const token = String((input && input.token) == null ? '' : input.token).trim() || ctl.getToken();
      ctl.saveSettings({ token: token, owner: s.owner, repo: s.repo, branch: s.branch });
      js.set(KEYS.path, s.path);
      if (before.owner !== s.owner || before.repo !== s.repo || before.branch !== s.branch || before.path !== s.path) {
        forgetFile();
      }
      return { ok: true, configured: ctl.syncReady() };
    }
    function clearSettings() {
      ctl.clearSettings();
      js.remove(KEYS.path);
      forgetFile();
    }
    function forgetFile() {
      js.remove(KEYS.sha);
      js.remove(KEYS.loadedAt);
      pending = null;
      build();
    }

    async function pull() {
      if (!ctl.syncReady()) return { action: 'off' };
      lastPull = null;
      await ctl.pullOnLoad();
      return lastPull || { action: 'error', error: { code: 'network' } };
    }

    async function save() {
      if (!ctl.syncReady()) return { ok: false, error: { code: 'off' } };
      if (ctl.isSyncing()) return { ok: false, error: { code: 'busy' } };
      lastPush = null;
      await ctl.syncNow();
      const r = lastPush || { ok: false, error: { code: 'network' } };
      if (r.ok) pending = null;
      return r;
    }

    // useRemote(): after 'choose', the person picked the repo's list.
    function useRemote() {
      if (!pending) return { ok: false, error: 'no-remote' };
      const r = base.importText(pending.text);
      if (!r.ok) return r;
      js.remove(KEYS.dirty);
      js.set(KEYS.loadedAt, now().toISOString());
      pending = null;
      return r;
    }

    // recoverFromRemote(saveRaw): ONLY for an unreadable local list, after a
    // pull found a valid repo list. saveRaw(rawText) must return true once the
    // unreadable text is safely saved (the page downloads it); anything else
    // writes nothing.
    function recoverFromRemote(saveRaw) {
      if (base.status() !== 'unreadable') return { ok: false, error: 'not-unreadable' };
      if (!pending) return { ok: false, error: 'no-remote' };
      const rawText = base.rawText();
      if (rawText != null) {
        let saved = false;
        try { saved = saveRaw(rawText) === true; } catch (e) { saved = false; }
        if (!saved) return { ok: false, error: 'raw-not-saved' };
      }
      const r = base.recoverText(pending.text);
      if (!r.ok) return r;
      js.remove(KEYS.dirty);
      js.set(KEYS.loadedAt, now().toISOString());
      pending = null;
      return r;
    }

    function markEdited() { js.set(KEYS.dirty, true); }

    // The People store, with every successful edit marking the list unsaved.
    const store = Object.assign({}, base);
    ['add', 'update', 'remove', 'seed', 'importText', 'recoverText'].forEach(function (name) {
      store[name] = function () {
        const r = base[name].apply(base, arguments);
        if (r && r.ok) markEdited();
        return r;
      };
    });

    return {
      KEYS: KEYS,
      store: store,
      configured: function () { return ctl.syncReady(); },
      settings: settings,
      saveSettings: saveSettings,
      clearSettings: clearSettings,
      pull: pull,
      save: save,
      useRemote: useRemote,
      recoverFromRemote: recoverFromRemote,
      unsaved: function () { const s = snapshot(); return s.unsaved; },
      loadedAt: function () { const v = js.get(KEYS.loadedAt, null); return typeof v === 'string' ? v : null; },
      pendingCount: function () { return pending ? pending.people.length : null; },
      knownSha: function () { return ctl.knownSha(); },
      isSaving: function () { return ctl.isSyncing(); },
    };
  }

  return {
    KEYS: KEYS, DEFAULT_PATH: DEFAULT_PATH,
    checkSettings: checkSettings, classifyRemote: classifyRemote, decidePull: decidePull,
    samePeople: samePeople, create: create,
  };
});
