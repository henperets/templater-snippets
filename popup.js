'use strict';

// ─── STORAGE ────────────────────────────────────────────────────────────────

function getTemplates() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['ft_templates'], (r) => resolve(r.ft_templates || []));
  });
}

function setTemplates(list) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ ft_templates: list }, resolve);
  });
}

// Ids of synced items the user deleted, so a sync doesn't bring them back.
function getDismissed() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['ft_dismissed'], (r) => resolve(r.ft_dismissed || []));
  });
}

function setDismissed(ids) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ ft_dismissed: ids }, resolve);
  });
}

// ─── FIELD LOGIC ────────────────────────────────────────────────────────────

// Returns ordered array of unique fields: { key, label }
// Named fields deduplicated. Empty/whitespace brackets numbered separately.
function extractFields(body) {
  var re = /\[([^\]]*)\]/g;
  var fields = [];
  var seenNamed = {};
  var unnamedCount = 0;
  var m;
  while ((m = re.exec(body)) !== null) {
    var name = m[1].trim();
    if (name === '') {
      unnamedCount++;
      fields.push({ key: '__u' + unnamedCount, label: 'Field ' + unnamedCount });
    } else if (!seenNamed[name]) {
      seenNamed[name] = true;
      fields.push({ key: name, label: name });
    }
  }
  return fields;
}

// Replace placeholders with filled values. Named fields: all occurrences.
// Unnamed fields: in order of appearance.
function applyFields(body, values) {
  var re = /\[([^\]]*)\]/g;
  var result = '';
  var last = 0;
  var unnamedIdx = 0;
  var m;
  while ((m = re.exec(body)) !== null) {
    result += body.slice(last, m.index);
    var name = m[1].trim();
    var key = (name === '') ? '__u' + (++unnamedIdx) : name;
    var val = values[key];
    result += (val !== undefined && val !== '') ? val : m[0];
    last = m.index + m[0].length;
  }
  result += body.slice(last);
  return result;
}

// Build HTML preview: filled = green, unfilled = styled placeholder badge.
function buildPreview(body, values) {
  var re = /\[([^\]]*)\]/g;
  var html = '';
  var last = 0;
  var unnamedIdx = 0;
  var m;
  while ((m = re.exec(body)) !== null) {
    html += esc(body.slice(last, m.index));
    var name = m[1].trim();
    var key = (name === '') ? '__u' + (++unnamedIdx) : name;
    var val = values[key];
    if (val !== undefined && val !== '') {
      html += '<span class="ph-filled">' + esc(val) + '</span>';
    } else {
      html += '<span class="ph">' + esc(m[0]) + '</span>';
    }
    last = m.index + m[0].length;
  }
  html += esc(body.slice(last));
  return html;
}

// ─── UTILITIES ──────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlight(html, q) {
  if (!q) return html;
  var safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(new RegExp('(' + safe + ')', 'gi'), '<mark>$1</mark>');
}

// ─── CLIPBOARD ──────────────────────────────────────────────────────────────

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // Fallback: temporary textarea + execCommand
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    return ok;
  }
}

// ─── INSERT INTO PAGE ────────────────────────────────────────────────────────
// Tries to insert text into the last focused input/textarea/contenteditable
// on the active tab. Falls back to clipboard copy if the page doesn't support it.

async function insertIntoPage(text) {
  try {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0] || !tabs[0].id) return false;
    var tabId = tabs[0].id;

    var results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function(textToInsert) {
        var el = window._ftLastFocused || document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return false;
        try {
          if (el.isContentEditable) {
            el.focus();
            var sel = window.getSelection();
            if (sel && sel.rangeCount) {
              sel.deleteFromDocument();
              var range = sel.getRangeAt(0);
              var node = document.createTextNode(textToInsert);
              range.insertNode(node);
              range.setStartAfter(node);
              range.setEndAfter(node);
              sel.removeAllRanges();
              sel.addRange(range);
            } else {
              document.execCommand('insertText', false, textToInsert);
            }
            return true;
          } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.focus();
            var start = el.selectionStart != null ? el.selectionStart : el.value.length;
            var end   = el.selectionEnd   != null ? el.selectionEnd   : el.value.length;
            el.value = el.value.slice(0, start) + textToInsert + el.value.slice(end);
            el.selectionStart = el.selectionEnd = start + textToInsert.length;
            el.dispatchEvent(new Event('input',  { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        } catch (_) {}
        return false;
      },
      args: [text]
    });

    return results && results[0] && results[0].result === true;
  } catch (_) {
    return false;
  }
}

// When the popup opens, record which element was last focused on the page.
async function captureActiveFocus() {
  try {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0] || !tabs[0].id) return;
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: function() { window._ftLastFocused = document.activeElement; }
    });
  } catch (_) {
    // Silently ignore restricted pages (chrome://, browser new tab, etc.)
  }
}

// ─── STATE ──────────────────────────────────────────────────────────────────

var templates   = [];
var editingId   = null;
var deletingId  = null;
var currentTpl  = null;
var fieldValues = {};
var activeFilter = 'all'; // 'all' | 'favs' | a TYPES id
var editingType  = 'client'; // type being set in edit modal

// Single source of truth for categories. Add/rename here and tabs, badges,
// the edit-modal selector and empty states all follow. Colours live in CSS ([data-type]).
var SVG_OPEN = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">';
var TYPES = [
  { id: 'client', label: 'Replies', one: 'Reply',  hint: 'Ready-made answers to send to clients',
    icon: '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>' },
  { id: 'prompt', label: 'Prompts', one: 'Prompt', hint: 'Prompts to paste into an AI assistant',
    icon: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>' },
  { id: 'skill',  label: 'Skills',  one: 'Skill',  hint: 'Reusable skills and instructions',
    icon: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>' },
  { id: 'guide',  label: 'Guides',  one: 'Guide',  hint: 'Step-by-step guides and how-tos',
    icon: '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>' }
];

// Older data used 'template' (and no type at all) for client replies.
function typeOf(t) {
  var id = t && t.type;
  return TYPES.some(function(x) { return x.id === id; }) ? id : 'client';
}
function typeInfo(id) { return TYPES.find(function(x) { return x.id === id; }); }

// ─── DOM HELPERS ────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

var searchInput = $('searchInput');
var searchClear = $('searchClear');
var countBadge  = $('countBadge');
var tplList     = $('tplList');
var emptyState  = $('emptyState');
var noResults   = $('noResults');
var noFavs       = $('noFavs');
var noType       = $('noType');
var favCount     = $('favCount');

// ─── INIT ────────────────────────────────────────────────────────────────────

async function init() {
  captureActiveFocus(); // fire-and-forget: capture what was focused before popup opened
  templates = await getTemplates();
  renderList('');
  syncShared(false); // refresh the shared library in the background
}

// ─── SHARED LIBRARY SYNC ─────────────────────────────────────────────────────

var syncing = false;

async function syncShared(manual) {
  if (syncing) return;
  if (!TemplaterSync.isConfigured()) {
    if (manual) showToast('Set REMOTE_URL in sync.js first', 'info');
    return;
  }
  syncing = true;
  $('syncBtn').classList.add('spinning');
  try {
    var ctrl = new AbortController();
    var timer = setTimeout(function() { ctrl.abort(); }, 8000);
    var res;
    try { res = await fetch(TemplaterSync.REMOTE_URL, { cache: 'no-cache', signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var remote = TemplaterSync.parseLibrary(await res.json());
    if (!remote) throw new Error('bad format');

    // Re-read storage so a sync never clobbers edits made while the request was in flight
    templates = await getTemplates();
    var r = TemplaterSync.mergeRemote(templates, remote, await getDismissed());
    if (r.changed) {
      templates = r.list;
      await setTemplates(templates);
      renderList(searchInput.value.trim());
    }
    if (manual) {
      showToast(r.changed
        ? 'Synced: ' + r.added + ' new, ' + r.updated + ' updated, ' + r.removed + ' removed'
        : 'Already up to date', 'success');
    }
  } catch (err) {
    if (manual) showToast('Sync failed. Check your connection.', 'error');
  } finally {
    syncing = false;
    $('syncBtn').classList.remove('spinning');
  }
}

$('syncBtn').addEventListener('click', function() { syncShared(true); });

init();

// ─── SEARCH ─────────────────────────────────────────────────────────────────

searchInput.addEventListener('input', function() {
  var q = searchInput.value.trim();
  searchClear.classList.toggle('show', q.length > 0);
  renderList(q);
});

searchClear.addEventListener('click', function() {
  searchInput.value = '';
  searchClear.classList.remove('show');
  renderList('');
  searchInput.focus();
});

// ─── FILTER TABS ─────────────────────────────────────────────────────────────

function setFilter(f) {
  if (activeFilter === f) return;
  activeFilter = f;
  document.querySelectorAll('.filter-tab').forEach(function(tab) {
    tab.classList.toggle('active', tab.dataset.filter === f);
  });
  renderList(searchInput.value.trim());
}

$('filterAll').dataset.filter  = 'all';
$('filterFavs').dataset.filter = 'favs';
TYPES.forEach(function(t) {
  var tab = document.createElement('button');
  tab.className = 'filter-tab';
  tab.dataset.type = t.id;
  tab.dataset.filter = t.id;
  tab.textContent = t.label;
  $('filterFavs').before(tab);
});
document.querySelector('.filter-bar').addEventListener('click', function(e) {
  var tab = e.target.closest('.filter-tab');
  if (tab) setFilter(tab.dataset.filter);
});

// ─── TOGGLE FAVORITE ─────────────────────────────────────────────────────────

async function toggleFavorite(id) {
  var i = templates.findIndex(function(t) { return t.id === id; });
  if (i < 0) return;
  templates[i] = Object.assign({}, templates[i], { favorited: !templates[i].favorited });
  await setTemplates(templates);
  renderList(searchInput.value.trim());
  showToast(
    templates[i].favorited ? 'Added to favorites!' : 'Removed from favorites',
    templates[i].favorited ? 'success' : 'info'
  );
}

// ─── RENDER LIST ─────────────────────────────────────────────────────────────

function renderList(query) {
  var q    = query.toLowerCase();
  var favs = templates.filter(function(t) { return t.favorited; });
  favCount.textContent = favs.length;

  var pool;
  if (activeFilter === 'favs') {
    pool = favs;
  } else if (activeFilter !== 'all') {
    pool = templates.filter(function(t) { return typeOf(t) === activeFilter; });
  } else {
    pool = favs.concat(templates.filter(function(t) { return !t.favorited; }));
  }

  var filtered = q
    ? pool.filter(function(t) {
        return t.name.toLowerCase().includes(q) || t.body.toLowerCase().includes(q);
      })
    : pool;

  if (q) {
    countBadge.textContent = filtered.length + ' of ' + pool.length
      + (pool.length === 1 ? ' item' : ' items');
  } else {
    countBadge.textContent = pool.length + (pool.length === 1 ? ' item' : ' items');
  }

  tplList.innerHTML = '';
  emptyState.style.display   = 'none';
  noResults.style.display    = 'none';
  noFavs.style.display       = 'none';
  noType.style.display       = 'none';
  tplList.style.display      = 'none';

  if (templates.length === 0) { emptyState.style.display = 'flex'; return; }

  if (activeFilter === 'favs' && pool.length === 0) { noFavs.style.display = 'flex'; return; }
  if (pool.length === 0 && typeInfo(activeFilter)) {
    var info = typeInfo(activeFilter);
    noType.dataset.type = info.id;
    $('noTypeIcon').innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="rgb(' +
      getComputedStyle(noType).getPropertyValue('--c') + ')" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + info.icon + '</svg>';
    $('noTypeTitle').textContent = 'No ' + info.label.toLowerCase() + ' yet';
    $('noTypeText').innerHTML = esc(info.hint) + '.<br>Create a new item and set its category to <strong style="color:rgb(' +
      getComputedStyle(noType).getPropertyValue('--c') + ')">' + esc(info.one) + '</strong>';
    noType.style.display = 'flex';
    return;
  }

  if (filtered.length === 0) { noResults.style.display = 'flex'; return; }

  tplList.style.display = 'flex';
  filtered.forEach(function(tpl, idx) {
    tplList.appendChild(buildCard(tpl, q, idx));
  });
}

// ─── BUILD CARD ──────────────────────────────────────────────────────────────

function buildCard(tpl, q, idx) {
  var fields = extractFields(tpl.body);

  var card = document.createElement('div');
  card.className = 'card';
  card.style.animationDelay = (idx * 25) + 'ms';

  // Head
  var head = document.createElement('div');
  head.className = 'card-head';

  var nameEl = document.createElement('div');
  nameEl.className = 'card-name';
  nameEl.title = tpl.name;
  nameEl.innerHTML = q ? highlight(esc(tpl.name), q) : esc(tpl.name);

  var btns = document.createElement('div');
  btns.className = 'card-btns';

  var starBtn = document.createElement('button');
  starBtn.className = 'btn-icon star' + (tpl.favorited ? ' active' : '');
  starBtn.title = tpl.favorited ? 'Remove from favorites' : 'Add to favorites';
  starBtn.innerHTML = tpl.favorited
    ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
    : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  starBtn.addEventListener('click', function() { toggleFavorite(tpl.id); });

  var editBtn = document.createElement('button');
  editBtn.className = 'btn-icon';
  editBtn.title = 'Edit';
  editBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  editBtn.addEventListener('click', function() { openEdit(tpl.id); });

  var delBtn = document.createElement('button');
  delBtn.className = 'btn-icon danger';
  delBtn.title = 'Delete';
  delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>';
  delBtn.addEventListener('click', function() { openDelete(tpl.id); });

  btns.append(starBtn, editBtn, delBtn);
  head.append(nameEl, btns);

  // Preview
  var preview = document.createElement('div');
  preview.className = 'card-preview';
  preview.innerHTML = q ? highlight(esc(tpl.body), q) : esc(tpl.body);

  // Footer
  var foot = document.createElement('div');
  foot.className = 'card-foot';

  var meta = document.createElement('div');
  meta.className = 'card-meta';

  var tplType = typeOf(tpl);
  var typeBadge = document.createElement('span');
  typeBadge.className = 'type-badge';
  typeBadge.dataset.type = tplType;
  typeBadge.textContent = typeInfo(tplType).one;
  meta.appendChild(typeBadge);

  if (tpl.shared) {
    var syncedBadge = document.createElement('span');
    syncedBadge.className = 'synced-badge';
    syncedBadge.title = 'Synced from the shared library. Editing it makes it your own copy.';
    syncedBadge.textContent = 'Shared';
    meta.appendChild(syncedBadge);
  }

  if (fields.length > 0) {
    var badge = document.createElement('span');
    badge.className = 'fields-badge';
    badge.innerHTML =
      '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><circle cx="7" cy="7" r="1" fill="currentColor" stroke="none"/></svg>' +
      fields.length + (fields.length === 1 ? ' field' : ' fields');
    meta.appendChild(badge);
  }

  var useBtn = document.createElement('button');
  useBtn.className = 'use-btn';
  useBtn.innerHTML =
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>' +
    'Use Template';
  useBtn.addEventListener('click', function() { openUse(tpl.id); });

  foot.append(meta, useBtn);
  card.append(head, preview, foot);
  return card;
}

// ─── TYPE SELECTOR ───────────────────────────────────────────────────────────

function syncTypeSelector() {
  document.querySelectorAll('.type-opt').forEach(function(o) {
    o.classList.toggle('active', o.dataset.type === editingType);
  });
}

TYPES.forEach(function(t) {
  var opt = document.createElement('button');
  opt.type = 'button';
  opt.className = 'type-opt';
  opt.dataset.type = t.id;
  opt.innerHTML = SVG_OPEN + t.icon + '</svg>' + esc(t.one);
  opt.addEventListener('click', function() { editingType = t.id; syncTypeSelector(); });
  $('typeSelector').appendChild(opt);
});

// ─── EDIT MODAL ──────────────────────────────────────────────────────────────

function openEdit(id) {
  var tpl = id ? templates.find(function(t) { return t.id === id; }) : null;
  editingId = id || null;

  $('editTitle').textContent = tpl ? 'Edit Template' : 'New Template';
  $('tplName').value = tpl ? tpl.name : '';
  $('tplBody').value = tpl ? tpl.body : '';
  $('nameErr').textContent = '';
  $('bodyErr').textContent = '';

  // Restore category selector
  // New items default to the tab you're currently viewing
  editingType = tpl ? typeOf(tpl) : (typeInfo(activeFilter) ? activeFilter : 'client');
  syncTypeSelector();

  refreshCharCount();
  refreshDetected();

  $('editOverlay').classList.add('open');
  setTimeout(function() { $('tplName').focus(); }, 80);
}

function closeEdit() {
  $('editOverlay').classList.remove('open');
  editingId = null;
}

function refreshCharCount() {
  $('charCount').textContent = $('tplBody').value.length.toLocaleString();
}

function refreshDetected() {
  var fields = extractFields($('tplBody').value);
  var box    = $('detectedFields');
  var tags   = $('detectedTags');
  if (fields.length === 0) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  tags.innerHTML = '';
  fields.forEach(function(f) {
    var el = document.createElement('span');
    el.className = 'dtag';
    el.textContent = f.label;
    tags.appendChild(el);
  });
}

$('tplBody').addEventListener('input', function() {
  refreshCharCount();
  refreshDetected();
  $('bodyErr').textContent = '';
});
$('tplName').addEventListener('input', function() { $('nameErr').textContent = ''; });

$('closeWindowBtn').addEventListener('click', function() {
  window.parent.postMessage({ type: 'templater-close' }, '*');
});

$('newBtn').addEventListener('click',   function() { openEdit(null); });
$('emptyBtn').addEventListener('click', function() { openEdit(null); });
$('editClose').addEventListener('click', closeEdit);
$('editCancel').addEventListener('click', closeEdit);

$('editSave').addEventListener('click', saveTemplate);

async function saveTemplate() {
  var name = $('tplName').value.trim();
  var body = $('tplBody').value.trim();
  var ok = true;

  if (!name) {
    $('nameErr').textContent = 'Template name is required.';
    ok = false;
  } else {
    var eid = editingId;
    var dup = templates.find(function(t) {
      return t.name.toLowerCase() === name.toLowerCase() && t.id !== eid;
    });
    if (dup) { $('nameErr').textContent = 'A template with this name already exists.'; ok = false; }
  }

  if (!body) { $('bodyErr').textContent = 'Template body cannot be empty.'; ok = false; }

  if (!ok) return;

  if (!editingId) {
    templates.unshift({ id: 'tpl_' + Date.now(), name: name, body: body, type: editingType, createdAt: Date.now() });
  } else {
    var i = templates.findIndex(function(t) { return t.id === editingId; });
    // Editing a synced item makes it the user's own copy (shared: false), so syncs stop overwriting it
    if (i >= 0) templates[i] = Object.assign({}, templates[i], { name: name, body: body, type: editingType, shared: false });
  }

  await setTemplates(templates);
  renderList(searchInput.value.trim());
  var wasNew = !editingId;
  closeEdit();
  showToast(wasNew ? 'Template created!' : 'Template updated!', 'success');
}

// ─── DELETE MODAL ────────────────────────────────────────────────────────────

function openDelete(id) {
  deletingId = id;
  var tpl = templates.find(function(t) { return t.id === id; });
  $('delName').textContent = tpl ? tpl.name : '';
  $('delOverlay').classList.add('open');
}

function closeDelete() {
  $('delOverlay').classList.remove('open');
  deletingId = null;
}

$('delClose').addEventListener('click',   closeDelete);
$('delCancel').addEventListener('click',  closeDelete);
$('delConfirm').addEventListener('click', async function() {
  if (!deletingId) return;
  var gone = templates.find(function(t) { return t.id === deletingId; });
  if (gone && gone.shared) {
    var dismissed = await getDismissed();
    dismissed.push(gone.id);
    await setDismissed(dismissed);
  }
  templates = templates.filter(function(t) { return t.id !== deletingId; });
  await setTemplates(templates);
  renderList(searchInput.value.trim());
  closeDelete();
  showToast('Template deleted', 'info');
});

// ─── USE MODAL ───────────────────────────────────────────────────────────────

function openUse(id) {
  var tpl = templates.find(function(t) { return t.id === id; });
  if (!tpl) return;

  currentTpl  = tpl;
  fieldValues = {};

  $('useTitle').textContent = tpl.name;

  var fields    = extractFields(tpl.body);
  var fieldsCol = $('fieldsCol');
  var dynFields = $('dynFields');
  var useBody   = $('useBody');

  dynFields.innerHTML = '';

  if (fields.length > 0) {
    fieldsCol.style.display = 'block';
    useBody.classList.add('has-fields');

    fields.forEach(function(field) {
      fieldValues[field.key] = '';

      var grp = document.createElement('div');
      grp.className = 'field-group';

      var lbl = document.createElement('label');
      lbl.className = 'field-label';
      var sp = document.createElement('span');
      sp.textContent = field.label;
      lbl.appendChild(sp);

      var inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'form-input';
      inp.dir = 'auto';
      inp.placeholder = 'Value for ' + field.label + '...';
      inp.dataset.key = field.key;

      // Closure over field.key
      (function(key) {
        inp.addEventListener('input', function() {
          fieldValues[key] = inp.value;
          updatePreview();
        });
      })(field.key);

      grp.append(lbl, inp);
      dynFields.appendChild(grp);
    });
  } else {
    fieldsCol.style.display = 'none';
    useBody.classList.remove('has-fields');
  }

  updatePreview();
  $('useOverlay').classList.add('open');

  setTimeout(function() {
    var first = dynFields.querySelector('input');
    if (first) first.focus();
  }, 80);
}

function closeUse() {
  $('useOverlay').classList.remove('open');
  currentTpl  = null;
  fieldValues = {};
}

function updatePreview() {
  if (!currentTpl) return;
  $('previewBox').innerHTML = buildPreview(currentTpl.body, fieldValues);
}

function getFinal() {
  if (!currentTpl) return '';
  return applyFields(currentTpl.body, fieldValues);
}

$('useClose').addEventListener('click',   closeUse);
$('useCancel').addEventListener('click',  closeUse);

$('copyBtn').addEventListener('click', async function() {
  var text = getFinal();
  var ok = await copyToClipboard(text);
  showToast(ok ? 'Copied to clipboard!' : 'Copy failed — try again', ok ? 'success' : 'error');
});

$('insertBtn').addEventListener('click', async function() {
  var text = getFinal();
  var inserted = await insertIntoPage(text);
  if (inserted) {
    showToast('Inserted into page!', 'success');
    closeUse();
  } else {
    // Graceful fallback: always ensure the user gets the text
    var copied = await copyToClipboard(text);
    showToast(copied ? 'Copied! Paste with Ctrl+V' : 'Could not insert or copy', copied ? 'info' : 'error');
  }
});

// ─── KEYBOARD SHORTCUTS ──────────────────────────────────────────────────────

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    if ($('editOverlay').classList.contains('open')) { closeEdit();   return; }
    if ($('useOverlay').classList.contains('open'))  { closeUse();    return; }
    if ($('delOverlay').classList.contains('open'))  { closeDelete(); return; }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if ($('editOverlay').classList.contains('open')) { saveTemplate(); return; }
    if ($('useOverlay').classList.contains('open'))  { $('insertBtn').click(); return; }
  }
});

// ─── EXPORT ──────────────────────────────────────────────────────────────────

$('exportBtn').addEventListener('click', function() {
  if (templates.length === 0) { showToast('No templates to export', 'info'); return; }
  var data = TemplaterSync.toLibraryJson(templates);
  var blob = new Blob([data], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'templates.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Exported ' + templates.length + (templates.length === 1 ? ' template' : ' templates'), 'success');
});

// ─── IMPORT ──────────────────────────────────────────────────────────────────

$('importBtn').addEventListener('click', function() { $('importFile').click(); });

$('importFile').addEventListener('change', async function(e) {
  var file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  var text;
  try { text = await file.text(); }
  catch (_) { showToast('Could not read file', 'error'); return; }

  var imported;
  try { imported = JSON.parse(text); }
  catch (_) { showToast('Invalid JSON file', 'error'); return; }

  // Accepts the old plain array or the { version, templates } library format
  var items = Array.isArray(imported) ? imported : (imported && imported.templates);
  if (!Array.isArray(items)) { showToast('File must contain a template array', 'error'); return; }

  var existingNames = new Set(templates.map(function(t) { return t.name.toLowerCase(); }));
  var existingIds   = new Set(templates.map(function(t) { return t.id; }));
  var added = 0, skipped = 0;

  items.forEach(function(tpl) {
    if (!tpl || typeof tpl.name !== 'string' || typeof tpl.body !== 'string') { skipped++; return; }
    var name = tpl.name.trim(), body = tpl.body.trim();
    if (!name || !body) { skipped++; return; }
    if (existingNames.has(name.toLowerCase())) { skipped++; return; }
    existingNames.add(name.toLowerCase());
    // Keep the original id when possible: ids are what the shared library syncs on
    var id = (typeof tpl.id === 'string' && tpl.id && !existingIds.has(tpl.id))
      ? tpl.id : 'tpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    existingIds.add(id);
    templates.push({ id: id, name: name, body: body, type: typeOf(tpl), createdAt: Date.now() });
    added++;
  });

  if (added === 0) {
    showToast(skipped > 0 ? 'All templates already exist' : 'No valid templates in file', 'info');
    return;
  }
  await setTemplates(templates);
  renderList(searchInput.value.trim());
  var msg = 'Imported ' + added + (added === 1 ? ' template' : ' templates');
  if (skipped > 0) msg += ', ' + skipped + ' skipped';
  showToast(msg, 'success');
});

// ─── TOAST ───────────────────────────────────────────────────────────────────

var toastTimer;
function showToast(text, kind) {
  var el = $('toast');
  el.textContent = text;
  el.className = 'toast ' + (kind || 'success') + ' show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { el.className = 'toast'; }, 2600);
}
