# Architecture

Templater is two small front-ends over one data model, plus one shared module. All source files are in `src/`.

```text
┌──────────────── Chrome ────────────────┐   ┌────────── VS Code ──────────┐
│ background.js  (icon click → toggle)   │   │ extension.js (host)         │
│ content.js     (injects iframe panel)  │   │   ├─ globalState storage    │
│ popup.html/js  (UI, chrome.storage)    │   │   ├─ https fetch + sync     │
│   └─ fetch() the library               │   │   └─ webview UI (same look) │
└───────────────────┬────────────────────┘   └──────────────┬──────────────┘
                    └──────────────►  sync.js  ◄─────────────┘
                              parseLibrary · mergeRemote · toLibraryJson
```

## Data model

A template is a plain object:

```json
{ "id": "tpl_1776607092062", "name": "…", "body": "Hi [Name], …", "type": "client",
  "createdAt": 1776607092062, "favorited": false, "shared": false }
```

- `type` is one of `client`, `prompt`, `skill`, `guide`. Older data used `template` or no type, and is treated as `client`.
- `favorited` and `shared` are local state. They are never written to the shared library file.
- `[Field]` placeholders are parsed from the body. Named fields repeat the same value everywhere, and empty `[]` brackets become numbered fields.

## Key decisions

**Floating iframe instead of a popup (Chrome).** A browser-action popup closes as soon as focus leaves it, which makes copy-paste workflows awkward. `content.js` injects the UI as an iframe, so it stays open while you work in the page. `popup.js` also remembers which field was focused before the panel opened, so Insert can write into it.

**Git as the shared store, not a database.** The library is a small, slow-changing, mostly-read list of text with a single editor. A file in a public repo gives history, review and rollback for free, and needs no server. The extension reads it over plain HTTPS from `raw.githubusercontent.com`. Writes are manual (Export, commit, push), which is acceptable with one editor. A real backend would only be needed for multi-user editing, permissions or analytics.

**Synced items live in the normal list.** Synced items are stored with `shared: true` instead of in a separate collection. This keeps search, categories, favorites and the Use flow working unchanged. The merge rules in `sync.js` keep them safe:

- Items are matched by stable `id`, so renames in the repo propagate.
- User-owned items (same id or same name) are never overwritten.
- Editing a shared item clears `shared`, and the item becomes the user's own copy.
- Deleting a shared item records its id in a "dismissed" list so it does not come back.

**`sync.js` is pure.** It does no I/O, so the same file runs in the browser (as a global) and in the VS Code host (`require`), and is unit-tested with `node:test`.

**No build tooling.** Plain JavaScript, no bundler or framework. The extensions load as-is, which keeps the project easy to read and run.

## Known trade-offs

- The Chrome and VS Code UIs are separate copies of similar code. A shared UI module would remove the duplication (see the roadmap).
- `REMOTE_URL` is a constant in `src/sync.js` and not yet a user setting. Setting it to `''` turns sync off.
- GitHub caches raw files for a few minutes, so updates are not instant.
