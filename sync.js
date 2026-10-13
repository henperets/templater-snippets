'use strict';

// Shared-library sync logic, used by both the browser popup (global TemplaterSync)
// and the VS Code extension host (require('./sync')). Pure functions, no I/O.
//
// Model: the repo's templates.json is the "shared library". Synced items are stored in
// the normal local list with shared:true. A local item with the same id (or the same name)
// always wins, so the owner's own editable copies are never overwritten.
// Editing a synced item clears shared:true (it becomes the user's own copy);
// deleting one remembers its id in a "dismissed" list so it doesn't come back.

(function (root) {
  var TYPE_IDS = ['client', 'prompt', 'skill', 'guide'];

  // Raw URL of the shared library: the templates.json of a public GitHub repo (fork and change to use your own).
  var REMOTE_URL = 'https://raw.githubusercontent.com/henperets/templater-snippets/main/templates.json';

  function normType(t) { return TYPE_IDS.indexOf(t) >= 0 ? t : 'client'; }

  // Accepts either [ ...items ] or { version, templates: [ ...items ] }.
  // Returns a clean array, or null if the shape is wrong.
  function parseLibrary(json) {
    var arr = Array.isArray(json) ? json : (json && Array.isArray(json.templates) ? json.templates : null);
    if (!arr) return null;
    var out = [];
    arr.forEach(function (t) {
      if (!t || typeof t.id !== 'string' || typeof t.name !== 'string' || typeof t.body !== 'string') return;
      if (!t.name.trim() || !t.body.trim()) return;
      out.push({ id: t.id, name: t.name.trim(), body: t.body.trim(), type: normType(t.type), createdAt: t.createdAt || 0 });
    });
    return out;
  }

  // Library file contents for the owner to commit: no personal state (favorites / shared flag).
  function toLibraryJson(list) {
    return JSON.stringify({
      version: 1,
      templates: list.map(function (t) {
        return { id: t.id, name: t.name, body: t.body, type: normType(t.type), createdAt: t.createdAt || 0 };
      })
    }, null, 2) + '\n';
  }

  function mergeRemote(local, remote, dismissed) {
    var dismissedSet = {};
    (dismissed || []).forEach(function (id) { dismissedSet[id] = true; });
    var byId = {}, ownNames = {};
    local.forEach(function (t) {
      byId[t.id] = t;
      if (!t.shared) ownNames[t.name.toLowerCase()] = true;
    });

    var remoteIds = {}, updates = {}, additions = [];
    var added = 0, updated = 0, removed = 0;

    remote.forEach(function (r) {
      remoteIds[r.id] = true;
      if (dismissedSet[r.id]) return;
      var l = byId[r.id];
      if (!l) {
        if (ownNames[r.name.toLowerCase()]) return;
        additions.push(Object.assign({}, r, { shared: true, favorited: false }));
        added++;
      } else if (l.shared && (l.name !== r.name || l.body !== r.body || l.type !== r.type)) {
        updates[r.id] = { name: r.name, body: r.body, type: r.type };
        updated++;
      }
    });

    var list = [];
    local.forEach(function (t) {
      if (t.shared && !remoteIds[t.id]) { removed++; return; }
      list.push(updates[t.id] ? Object.assign({}, t, updates[t.id]) : t);
    });
    list = list.concat(additions);

    return { list: list, added: added, updated: updated, removed: removed,
             changed: (added + updated + removed) > 0 };
  }

  var api = { REMOTE_URL: REMOTE_URL, normType: normType, parseLibrary: parseLibrary,
              toLibraryJson: toLibraryJson, mergeRemote: mergeRemote,
              isConfigured: function () { return REMOTE_URL.indexOf('OWNER/REPO') < 0; } };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TemplaterSync = api;
})(typeof self !== 'undefined' ? self : this);
