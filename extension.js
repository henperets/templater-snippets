// @ts-check
'use strict';

const vscode = require('vscode');
const https = require('https');
const Sync = require('./sync');

/** @type {vscode.WebviewPanel | undefined} */
let panel;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('favoriteTemplates.open', () => openPanel(context))
  );
}

/** @param {vscode.ExtensionContext} context */
function openPanel(context) {
  if (panel) {
    panel.reveal();
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'favoriteTemplates',
    'Templater',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.webview.html = getHtml(getNonce());

  const sub = panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'ready':
        sendTemplates(context);
        syncShared(context, false); // refresh the shared library in the background
        break;

      case 'sync':
        await syncShared(context, true);
        break;

      case 'save': {
        const list = getList(context);
        if (msg.isNew) {
          list.unshift({
            id: 'tpl_' + Date.now(),
            name: msg.name,
            body: msg.body,
            type: msg.tplType || 'client',
            createdAt: Date.now(),
          });
        } else {
          const i = list.findIndex((t) => t.id === msg.id);
          // Editing a synced item makes it the user's own copy (shared: false), so syncs stop overwriting it
          if (i >= 0) list[i] = { ...list[i], name: msg.name, body: msg.body, type: msg.tplType || 'client', shared: false };
        }
        await context.globalState.update('ft_templates', list);
        sendTemplates(context);
        break;
      }

      case 'delete': {
        const all = getList(context);
        const gone = all.find((t) => t.id === msg.id);
        if (gone && gone.shared) {
          // remember it so the next sync doesn't bring it back
          await context.globalState.update('ft_dismissed', [...context.globalState.get('ft_dismissed', []), gone.id]);
        }
        const filtered = all.filter((t) => t.id !== msg.id);
        await context.globalState.update('ft_templates', filtered);
        sendTemplates(context);
        break;
      }

      case 'toggleFav': {
        const list = getList(context);
        const i = list.findIndex((t) => t.id === msg.id);
        if (i >= 0) {
          list[i] = { ...list[i], favorited: !list[i].favorited };
          await context.globalState.update('ft_templates', list);
          sendTemplates(context);
        }
        break;
      }

      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        panel && panel.webview.postMessage({ type: 'toast', text: 'Copied to clipboard!', kind: 'success' });
        break;

      case 'export': {
        const uri = await vscode.window.showSaveDialog({
          filters: { 'JSON': ['json'] },
          defaultUri: vscode.Uri.file('templates.json'),
          saveLabel: 'Export',
        });
        if (uri) {
          // Library format (no favorites / shared flags), ready to commit to the shared repo
          const out = Sync.toLibraryJson(getList(context));
          await vscode.workspace.fs.writeFile(uri, Buffer.from(out, 'utf8'));
          panel && panel.webview.postMessage({ type: 'toast', text: 'Templates exported!', kind: 'success' });
        }
        break;
      }

      case 'bulkImport': {
        const list = getList(context);
        const existingNames = new Set(list.map((t) => t.name.toLowerCase()));
        const existingIds = new Set(list.map((t) => t.id));
        let added = 0, skipped = 0;
        (msg.data || []).forEach((tpl) => {
          if (!tpl || typeof tpl.name !== 'string' || typeof tpl.body !== 'string') { skipped++; return; }
          const name = tpl.name.trim(), body = tpl.body.trim();
          if (!name || !body) { skipped++; return; }
          if (existingNames.has(name.toLowerCase())) { skipped++; return; }
          existingNames.add(name.toLowerCase());
          // Keep the original id when possible: ids are what the shared library syncs on
          const id = (typeof tpl.id === 'string' && tpl.id && !existingIds.has(tpl.id))
            ? tpl.id : 'tpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
          existingIds.add(id);
          list.push({ id, name, body, type: Sync.normType(tpl.type), createdAt: Date.now() });
          added++;
        });
        if (added > 0) {
          await context.globalState.update('ft_templates', list);
          sendTemplates(context);
        }
        const importText = added === 0
          ? (skipped > 0 ? 'All templates already exist' : 'No valid templates in file')
          : 'Imported ' + added + (added === 1 ? ' template' : ' templates') + (skipped ? ', ' + skipped + ' skipped' : '');
        panel && panel.webview.postMessage({ type: 'toast', text: importText, kind: added > 0 ? 'success' : 'info' });
        break;
      }

      case 'insert': {
        const ed = vscode.window.activeTextEditor;
        if (ed) {
          await ed.edit((b) => b.replace(ed.selection, msg.text));
          panel && panel.webview.postMessage({ type: 'toast', text: 'Template inserted!', kind: 'success' });
        } else {
          await vscode.env.clipboard.writeText(msg.text);
          panel && panel.webview.postMessage({ type: 'toast', text: 'No active editor — copied to clipboard', kind: 'info' });
        }
        break;
      }
    }
  }, undefined, context.subscriptions);

  panel.onDidDispose(() => {
    sub.dispose();
    panel = undefined;
  }, undefined, context.subscriptions);
}

/** @param {vscode.ExtensionContext} context */
function getList(context) {
  return context.globalState.get('ft_templates', []);
}

/** @param {string} url @returns {Promise<any>} */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Cache-Control': 'no-cache' }, timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

let syncing = false;

/**
 * Pull the shared library (templates.json in the public repo) and merge it into the local list.
 * @param {vscode.ExtensionContext} context
 * @param {boolean} manual  true when triggered by the Sync button (reports the outcome)
 */
async function syncShared(context, manual) {
  const toast = (text, kind) => panel && panel.webview.postMessage({ type: 'toast', text, kind });
  if (syncing) return;
  if (!Sync.isConfigured()) { if (manual) toast('Set REMOTE_URL in sync.js first', 'info'); return; }
  syncing = true;
  try {
    const remote = Sync.parseLibrary(await fetchJson(Sync.REMOTE_URL));
    if (!remote) throw new Error('bad format');
    const r = Sync.mergeRemote(getList(context), remote, context.globalState.get('ft_dismissed', []));
    if (r.changed) {
      await context.globalState.update('ft_templates', r.list);
      sendTemplates(context);
    }
    if (manual) {
      toast(r.changed
        ? 'Synced: ' + r.added + ' new, ' + r.updated + ' updated, ' + r.removed + ' removed'
        : 'Already up to date', 'success');
    }
  } catch (err) {
    if (manual) toast('Sync failed. Check your connection.', 'error');
  } finally {
    syncing = false;
  }
}

/** @param {vscode.ExtensionContext} context */
function sendTemplates(context) {
  if (panel) panel.webview.postMessage({ type: 'templates', data: getList(context) });
}

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

/** @param {string} nonce */
function getHtml(nonce) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">

<title>Templater</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

:root {
  --bg: var(--vscode-editor-background, #13131f);
  --bg-card: var(--vscode-sideBar-background, #1c1c2e);
  --bg-input: var(--vscode-input-background, #111120);
  --fg: var(--vscode-editor-foreground, #e2e2f0);
  --fg-muted: var(--vscode-descriptionForeground, #8888aa);
  --border: var(--vscode-widget-border, #2e2e4a);
  --primary: #7c3aed;
  --primary-h: #6d28d9;
  --primary-glow: rgba(124,58,237,0.18);
  --primary-light: rgba(124,58,237,0.13);
  --accent: #a78bfa;
  --danger: #ef4444;
  --danger-h: #dc2626;
  --danger-light: rgba(239,68,68,0.12);
  --success: #10b981;
  --success-light: rgba(16,185,129,0.13);
  --info: #38bdf8;
  --radius: 10px;
  --radius-lg: 14px;
  --radius-sm: 7px;
  --shadow: 0 8px 32px rgba(0,0,0,0.45);
  --shadow-sm: 0 2px 12px rgba(0,0,0,0.3);
  --trans: 0.17s ease;
}

html, body {
  height: 100%;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif);
  font-size: 13px;
  line-height: 1.5;
  overflow-x: hidden;
}

::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 99px; }
::-webkit-scrollbar-thumb:hover { background: var(--fg-muted); }

/* ── LAYOUT ── */
#app { min-height: 100vh; display: flex; flex-direction: column; }

/* ── HEADER ── */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  background: linear-gradient(135deg, #150b2e 0%, #0e0e1f 60%, #0a1525 100%);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 100;
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
}

.logo-icon {
  width: 34px;
  height: 34px;
  background: linear-gradient(135deg, #7c3aed, #a855f7);
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 4px 14px rgba(124,58,237,0.45);
}

.logo-name {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.3px;
  background: linear-gradient(90deg, #a78bfa, #c084fc);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.logo-sub {
  font-size: 10px;
  color: var(--fg-muted);
  margin-top: 1px;
}

/* ── BUTTONS ── */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--trans);
  white-space: nowrap;
  letter-spacing: 0.2px;
  font-family: inherit;
}
.btn:active { transform: scale(0.97); }

.btn-primary {
  background: linear-gradient(135deg, #7c3aed, #a855f7);
  color: #fff;
  box-shadow: 0 2px 12px rgba(124,58,237,0.4);
}
.btn-primary:hover {
  background: linear-gradient(135deg, #6d28d9, #9333ea);
  box-shadow: 0 4px 18px rgba(124,58,237,0.55);
  transform: translateY(-1px);
}

.btn-secondary {
  background: var(--bg-card);
  color: var(--fg-muted);
  border: 1px solid var(--border);
}
.btn-secondary:hover { background: var(--border); color: var(--fg); }

.btn-outline {
  background: transparent;
  color: var(--accent);
  border: 1px solid rgba(124,58,237,0.45);
}
.btn-outline:hover { background: var(--primary-light); }

.btn-danger {
  background: var(--danger);
  color: #fff;
  box-shadow: 0 2px 10px rgba(239,68,68,0.35);
}
.btn-danger:hover { background: var(--danger-h); box-shadow: 0 4px 14px rgba(239,68,68,0.5); transform: translateY(-1px); }

.btn-icon {
  background: transparent;
  border: none;
  padding: 5px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--fg-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--trans);
  font-family: inherit;
}
.btn-icon:hover { background: var(--border); color: var(--fg); }
.btn-icon.danger:hover { background: var(--danger-light); color: var(--danger); }

/* ── SEARCH ── */
.search-bar {
  padding: 14px 20px 6px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.search-wrap {
  flex: 1;
  position: relative;
}

.search-icon {
  position: absolute;
  left: 11px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--fg-muted);
  pointer-events: none;
  display: flex;
}

.search-input {
  width: 100%;
  padding: 9px 34px 9px 36px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--fg);
  font-size: 13px;
  outline: none;
  transition: all var(--trans);
  font-family: inherit;
}
.search-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-glow); }
.search-input::placeholder { color: var(--fg-muted); }

.search-clear {
  position: absolute;
  right: 7px;
  top: 50%;
  transform: translateY(-50%);
  background: transparent;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 3px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  opacity: 0;
  pointer-events: none;
  transition: all var(--trans);
}
.search-clear.show { opacity: 1; pointer-events: auto; }
.search-clear:hover { color: var(--fg); }

.count-badge {
  font-size: 11px;
  color: var(--fg-muted);
  background: var(--bg-card);
  border: 1px solid var(--border);
  padding: 4px 10px;
  border-radius: 99px;
  white-space: nowrap;
  flex-shrink: 0;
}

/* ── FILTER TABS ── */
.filter-bar {
  padding: 0 20px 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.filter-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 13px;
  background: transparent;
  color: var(--fg-muted);
  border: 1px solid var(--border);
  border-radius: 99px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--trans);
  font-family: inherit;
  white-space: nowrap;
}
.filter-tab:hover { background: var(--border); color: var(--fg); }
.filter-tab.active {
  background: var(--primary-light);
  color: var(--accent);
  border-color: rgba(124,58,237,0.35);
}
/* Category colours: one RGB triplet per type, reused by tabs, badges and the type selector */
[data-type="client"] { --c: 52,211,153; }   /* emerald */
[data-type="prompt"] { --c: 251,146,60; }   /* orange  */
[data-type="skill"]  { --c: 244,114,182; }  /* pink    */
[data-type="guide"]  { --c: 56,189,248; }   /* sky     */

.filter-tab[data-type] {
  color: rgb(var(--c));
  background: rgba(var(--c),0.06);
  border-color: rgba(var(--c),0.28);
}
.filter-tab[data-type]::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: rgb(var(--c)); opacity: 0.75;
}
.filter-tab[data-type]:hover {
  background: rgba(var(--c),0.14);
  border-color: rgba(var(--c),0.5);
  color: rgb(var(--c));
}
.filter-tab[data-type].active {
  background: rgba(var(--c),0.2);
  border-color: rgba(var(--c),0.7);
  box-shadow: 0 0 0 1px rgba(var(--c),0.25), 0 2px 12px rgba(var(--c),0.25);
}
.filter-tab[data-type].active::before { opacity: 1; box-shadow: 0 0 6px rgb(var(--c)); }
.tab-count {
  font-size: 10.5px;
  font-weight: 700;
  background: rgba(124,58,237,0.2);
  color: var(--accent);
  border-radius: 99px;
  padding: 0 6px;
  min-width: 16px;
  text-align: center;
  line-height: 18px;
}
.btn-icon.copy:hover  { background: var(--primary-light); color: var(--accent); }
/* Star button */
.btn-icon.star.active { color: #fbbf24; }
.btn-icon.star:hover  { background: rgba(251,191,36,0.12); color: #fbbf24; }

/* ── TYPE BADGE (card) ── */
.type-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 9px;
  border-radius: 99px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.2px;
}
.type-badge[data-type] {
  background: rgba(var(--c),0.10);
  color: rgb(var(--c));
  border: 1px solid rgba(var(--c),0.28);
}

/* ── TYPE SELECTOR (edit modal) ── */
.type-selector {
  display: flex;
  gap: 7px;
}
.type-opt {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 12px;
  background: var(--bg-input);
  color: var(--fg-muted);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--trans);
  font-family: inherit;
}
.type-opt:hover { border-color: rgba(var(--c),0.5); color: rgb(var(--c)); }
.type-opt.active {
  background: rgba(var(--c),0.15);
  color: rgb(var(--c));
  border-color: rgba(var(--c),0.6);
}

/* ── TEMPLATE LIST ── */
.tpl-list {
  flex: 1;
  padding: 10px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}

/* ── CARD ── */
.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 15px 16px 13px;
  transition: all var(--trans);
  position: relative;
  overflow: hidden;
  animation: cardIn 0.2s ease both;
  flex-shrink: 0;
}
.card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg, #7c3aed, #a855f7, #ec4899);
  opacity: 0;
  transition: opacity var(--trans);
}
.card:hover { border-color: rgba(124,58,237,0.35); box-shadow: var(--shadow-sm); transform: translateY(-1px); }
.card:hover::before { opacity: 1; }

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 7px;
}

.card-name {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--fg);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.35;
}

.card-btns {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

.card-preview {
  font-size: 12px;
  color: var(--fg-muted);
  line-height: 1.65;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  margin-bottom: 11px;
  white-space: pre-wrap;
  word-break: break-word;
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}

.synced-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 9px;
  border-radius: 99px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--fg-muted);
  border: 1px dashed var(--border);
}

.fields-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  background: var(--primary-light);
  color: var(--accent);
  border: 1px solid rgba(124,58,237,0.22);
  border-radius: 99px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2px;
}

.use-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 13px;
  background: linear-gradient(135deg, #7c3aed, #a855f7);
  color: #fff;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 11.5px;
  font-weight: 700;
  cursor: pointer;
  transition: all var(--trans);
  box-shadow: 0 2px 10px rgba(124,58,237,0.4);
  font-family: inherit;
  letter-spacing: 0.2px;
  flex-shrink: 0;
}
.use-btn:hover {
  background: linear-gradient(135deg, #6d28d9, #9333ea);
  box-shadow: 0 4px 14px rgba(124,58,237,0.55);
  transform: translateY(-1px);
}
.use-btn:active { transform: scale(0.97); }

/* ── EMPTY STATES ── */
.empty, .no-res, .no-favs {
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 64px 24px;
  text-align: center;
  flex: 1;
}

.empty-icon {
  width: 68px;
  height: 68px;
  background: var(--primary-light);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(124,58,237,0.2);
}

.empty h3, .no-res h3 { font-size: 16px; font-weight: 700; }
.empty p, .no-res p { font-size: 12.5px; color: var(--fg-muted); max-width: 270px; }

/* ── MODAL ── */
.overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.65);
  backdrop-filter: blur(5px);
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}
.overlay.open {
  display: flex;
  animation: overlayIn 0.18s ease forwards;
}
@keyframes overlayIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.modal {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  width: 100%;
  max-width: 560px;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.overlay.open .modal {
  animation: modalIn 0.18s ease forwards;
}
@keyframes modalIn {
  from { opacity: 0; transform: scale(0.93) translateY(12px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
.modal-lg { max-width: 700px; }
.modal-sm { max-width: 400px; }

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 17px 20px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  background: linear-gradient(135deg, rgba(124,58,237,0.07) 0%, transparent 100%);
}
.modal-head h2 { font-size: 15px; font-weight: 700; }

.modal-x {
  background: transparent;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  font-size: 16px;
  line-height: 1;
  transition: all var(--trans);
  font-family: inherit;
}
.modal-x:hover { background: var(--border); color: var(--fg); }

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.modal-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

/* ── FORM ── */
.form-group { display: flex; flex-direction: column; gap: 6px; }

.form-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--fg);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.form-hint {
  font-size: 10.5px;
  color: var(--accent);
  background: var(--primary-light);
  border: 1px solid rgba(124,58,237,0.2);
  padding: 2px 9px;
  border-radius: 99px;
  font-weight: 600;
  white-space: nowrap;
}

.form-input, .form-textarea {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
  font-size: 13px;
  padding: 9px 12px;
  outline: none;
  width: 100%;
  transition: all var(--trans);
  font-family: inherit;
}
.form-input:focus, .form-textarea:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-glow);
}
.form-input::placeholder, .form-textarea::placeholder { color: var(--fg-muted); }

.form-textarea {
  resize: vertical;
  min-height: 168px;
  line-height: 1.65;
}

.char-info {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  font-size: 11px;
  color: var(--fg-muted);
  margin-top: 2px;
}

.err-msg {
  font-size: 11px;
  color: var(--danger);
  min-height: 15px;
  display: block;
}

/* ── DETECTED FIELDS PREVIEW ── */
.detected-fields {
  background: var(--bg-input);
  border: 1px solid rgba(124,58,237,0.25);
  border-radius: var(--radius-sm);
  padding: 11px 13px;
  display: none;
}
.detected-fields-label {
  font-size: 10.5px;
  font-weight: 700;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.6px;
  margin-bottom: 8px;
}
.detected-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dtag {
  padding: 3px 10px;
  background: var(--primary-light);
  color: var(--accent);
  border: 1px solid rgba(124,58,237,0.25);
  border-radius: 99px;
  font-size: 11px;
  font-weight: 600;
}

/* ── USE MODAL ── */
.use-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

@media (min-width: 480px) {
  .use-body.has-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
}

.section-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.6px;
  margin-bottom: 10px;
}

.dyn-fields { display: flex; flex-direction: column; gap: 10px; }

.field-group { display: flex; flex-direction: column; gap: 4px; }

.field-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--fg-muted);
}
.field-label span { color: var(--accent); font-style: italic; }

/* ── PREVIEW BOX ── */
.preview-box {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-word;
  min-height: 110px;
  max-height: 340px;
  overflow-y: auto;
}

.ph {
  background: var(--primary-light);
  color: var(--accent);
  border-radius: 4px;
  padding: 1px 4px;
  font-weight: 700;
  border: 1px solid rgba(124,58,237,0.25);
}

.ph-filled {
  color: var(--success);
  font-weight: 700;
  background: var(--success-light);
  border-radius: 4px;
  padding: 1px 4px;
}

/* ── TOAST ── */
.toast {
  position: fixed;
  bottom: 22px;
  left: 50%;
  transform: translateX(-50%) translateY(16px);
  background: #1e1e32;
  color: var(--fg);
  padding: 9px 20px;
  border-radius: var(--radius);
  font-size: 12.5px;
  font-weight: 600;
  box-shadow: var(--shadow);
  border: 1px solid var(--border);
  opacity: 0;
  transition: all 0.22s ease;
  pointer-events: none;
  z-index: 9999;
  white-space: nowrap;
}
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.toast.success { border-color: var(--success); color: var(--success); }
.toast.info    { border-color: var(--info);    color: var(--info); }
.toast.error   { border-color: var(--danger);  color: var(--danger); }

/* ── ANIMATIONS ── */
@keyframes cardIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

mark {
  background: rgba(124,58,237,0.28);
  color: var(--fg);
  border-radius: 2px;
  padding: 0 1px;
}

.kbd {
  font-size: 10px;
  color: var(--fg-muted);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
  font-family: monospace;
}

.header-actions { display: flex; align-items: center; gap: 7px; }
.btn-ghost {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 11px; background: transparent;
  color: var(--fg-muted); border: 1px solid var(--border);
  border-radius: var(--radius-sm); font-size: 11.5px; font-weight: 600;
  cursor: pointer; transition: all var(--trans); font-family: inherit; white-space: nowrap;
}
.btn-ghost:hover { background: var(--border); color: var(--fg); }
</style>
</head>
<body>
<div id="app">

  <!-- HEADER -->
  <header class="header">
    <div class="logo">
      <div class="logo-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
          <circle cx="7" cy="7" r="1.2" fill="#fff" stroke="none"/>
        </svg>
      </div>
      <div>
        <div class="logo-name">Templater</div>
        <div class="logo-sub">Template Manager</div>
      </div>
    </div>
    <div class="header-actions">
      <button class="btn-ghost" id="syncBtn" title="Sync the shared template library">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
        Sync
      </button>
      <button class="btn-ghost" id="exportBtn" title="Export a backup of your templates">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Export
      </button>
      <button class="btn-ghost" id="importBtn" title="Import templates from JSON file">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        Import
      </button>
      <button class="btn btn-primary" id="newBtn">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New Template
      </button>
    </div>
  </header>
  <input type="file" id="importFile" accept=".json,application/json" style="display:none">

  <!-- SEARCH -->
  <div class="search-bar">
    <div class="search-wrap">
      <span class="search-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </span>
      <input class="search-input" id="searchInput" type="text" placeholder="Search templates by name or content...">
      <button class="search-clear" id="searchClear" title="Clear">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <span class="count-badge" id="countBadge">0 templates</span>
  </div>

  <!-- FILTER TABS -->
  <div class="filter-bar">
    <button class="filter-tab active" id="filterAll">All</button>
    <!-- category tabs are generated from TYPES in the webview script -->
    <button class="filter-tab" id="filterFavs">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      Favorites
      <span class="tab-count" id="favCount">0</span>
    </button>
  </div>

  <!-- EMPTY STATE -->
  <div class="empty" id="emptyState">
    <div class="empty-icon">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.8" stroke-linecap="round">
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
        <circle cx="7" cy="7" r="1" fill="#a78bfa" stroke="none"/>
        <line x1="12" y1="8" x2="12" y2="15"/><line x1="8.5" y1="11.5" x2="15.5" y2="11.5"/>
      </svg>
    </div>
    <h3>No templates yet</h3>
    <p>Create your first reusable template with dynamic <strong style="color:var(--accent)">[Fields]</strong> that get filled in when you use them.</p>
    <button class="btn btn-primary" id="emptyBtn">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Create Template
    </button>
  </div>

  <!-- NO RESULTS STATE -->
  <div class="no-res" id="noResults">
    <div class="empty-icon">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.8" stroke-linecap="round">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        <line x1="8" y1="11" x2="14" y2="11"/>
      </svg>
    </div>
    <h3>No results found</h3>
    <p>Try a different search term</p>
  </div>

  <!-- NO ITEMS IN CATEGORY STATE (filled per category by the webview script) -->
  <div class="no-favs" id="noType">
    <div class="empty-icon" id="noTypeIcon"></div>
    <h3 id="noTypeTitle"></h3>
    <p id="noTypeText"></p>
  </div>

  <!-- NO FAVORITES STATE -->
  <div class="no-favs" id="noFavs">
    <div class="empty-icon">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
    </div>
    <h3>No favorites yet</h3>
    <p>Click the <strong style="color:var(--accent)">★</strong> on any template to pin it here</p>
  </div>

  <!-- TEMPLATE LIST -->
  <div class="tpl-list" id="tplList"></div>

</div>

<!-- ═══ EDIT MODAL ═══ -->
<div class="overlay" id="editOverlay">
  <div class="modal">
    <div class="modal-head">
      <h2 id="editTitle">New Template</h2>
      <button class="modal-x" id="editClose">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label" for="tplName">Template Name</label>
        <input class="form-input" id="tplName" type="text" placeholder="e.g. Bug Report, Client Follow-up, Onboarding...">
        <span class="err-msg" id="nameErr"></span>
      </div>
      <div class="form-group">
        <label class="form-label">Category</label>
        <div class="type-selector" id="typeSelector"></div>
      </div>
      <div class="form-group">
        <label class="form-label" for="tplBody">
          Template Body
          <span class="form-hint">[Field Name] = dynamic field</span>
        </label>
        <textarea class="form-textarea" id="tplBody" placeholder="Hello [Client],&#10;&#10;I would like to discuss [Subject] with you.&#10;&#10;Regarding [Topic], I believe that [Reasoning].&#10;&#10;Best regards"></textarea>
        <div class="char-info"><span id="charCount">0</span>&nbsp;characters</div>
        <span class="err-msg" id="bodyErr"></span>
      </div>
      <div class="detected-fields" id="detectedFields">
        <div class="detected-fields-label">Detected Dynamic Fields</div>
        <div class="detected-tags" id="detectedTags"></div>
      </div>
    </div>
    <div class="modal-foot">
      <span class="kbd">Ctrl+Enter to save</span>
      <div style="flex:1"></div>
      <button class="btn btn-secondary" id="editCancel">Cancel</button>
      <button class="btn btn-primary" id="editSave">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        Save Template
      </button>
    </div>
  </div>
</div>

<!-- ═══ USE MODAL ═══ -->
<div class="overlay" id="useOverlay">
  <div class="modal modal-lg">
    <div class="modal-head">
      <h2 id="useTitle">Use Template</h2>
      <button class="modal-x" id="useClose">✕</button>
    </div>
    <div class="modal-body use-body" id="useBody">
      <div id="fieldsCol" style="display:none">
        <div class="section-label">Fill in Fields</div>
        <div class="dyn-fields" id="dynFields"></div>
      </div>
      <div id="previewCol">
        <div class="section-label">Preview</div>
        <div class="preview-box" id="previewBox"></div>
      </div>
    </div>
    <div class="modal-foot">
      <span class="kbd">Ctrl+Enter to insert</span>
      <div style="flex:1"></div>
      <button class="btn btn-secondary" id="useCancel">Cancel</button>
      <button class="btn btn-outline" id="copyBtn">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        Copy
      </button>
      <button class="btn btn-primary" id="insertBtn">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
        Insert into Editor
      </button>
    </div>
  </div>
</div>

<!-- ═══ DELETE MODAL ═══ -->
<div class="overlay" id="delOverlay">
  <div class="modal modal-sm">
    <div class="modal-head">
      <h2>Delete Template</h2>
      <button class="modal-x" id="delClose">✕</button>
    </div>
    <div class="modal-body" style="gap:10px">
      <p style="font-size:13px">Are you sure you want to delete <strong id="delName" style="color:var(--accent)"></strong>?</p>
      <p style="font-size:12px;color:var(--fg-muted)">This action cannot be undone.</p>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="delCancel">Cancel</button>
      <button class="btn btn-danger" id="delConfirm">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
        Delete
      </button>
    </div>
  </div>
</div>

<!-- TOAST -->
<div class="toast" id="toast"></div>

<script nonce="${nonce}">
// ─── VSCode API ───
const vscode = acquireVsCodeApi();

// ─── STATE ───
let templates    = [];
let editingId    = null;
let deletingId   = null;
let currentTpl   = null;
let fieldValues  = {};
let activeFilter = 'all'; // 'all' | 'favs' | a TYPES id
let editingType  = 'client';

// Single source of truth for categories. Add/rename here and tabs, badges,
// the edit-modal selector and empty states all follow. Colours live in CSS ([data-type]).
const SVG_OPEN = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">';
const TYPES = [
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
const typeOf   = (t) => (t && TYPES.some((x) => x.id === t.type)) ? t.type : 'client';
const typeInfo = (id) => TYPES.find((x) => x.id === id);

// ─── REFS ───
const $ = (id) => document.getElementById(id);
const searchInput  = $('searchInput');
const searchClear  = $('searchClear');
const countBadge   = $('countBadge');
const tplList      = $('tplList');
const emptyState   = $('emptyState');
const noResults    = $('noResults');
const noFavs       = $('noFavs');
const noType       = $('noType');
const favCount     = $('favCount');

// ─── INIT ───
vscode.postMessage({ type: 'ready' });

// ─── EXTENSION MESSAGES ───
window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'templates') {
    templates = msg.data || [];
    renderList(searchInput.value.trim());
  } else if (msg.type === 'toast') {
    showToast(msg.text, msg.kind);
  }
});

// ─── SEARCH ───
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  searchClear.classList.toggle('show', q.length > 0);
  renderList(q);
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.remove('show');
  renderList('');
  searchInput.focus();
});

// ─── FILTER TABS ───
function setFilter(f) {
  if (activeFilter === f) return;
  activeFilter = f;
  document.querySelectorAll('.filter-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.filter === f);
  });
  renderList(searchInput.value.trim());
}

$('filterAll').dataset.filter  = 'all';
$('filterFavs').dataset.filter = 'favs';
TYPES.forEach((t) => {
  const tab = document.createElement('button');
  tab.className = 'filter-tab';
  tab.dataset.type = t.id;
  tab.dataset.filter = t.id;
  tab.textContent = t.label;
  $('filterFavs').before(tab);
});
document.querySelector('.filter-bar').addEventListener('click', (e) => {
  const tab = e.target.closest('.filter-tab');
  if (tab) setFilter(tab.dataset.filter);
});

// ─── TOGGLE FAVORITE ───
function toggleFavorite(id) {
  vscode.postMessage({ type: 'toggleFav', id });
}

// ─── TYPE SELECTOR ───
function syncTypeSelector() {
  document.querySelectorAll('.type-opt').forEach((o) => {
    o.classList.toggle('active', o.dataset.type === editingType);
  });
}

TYPES.forEach((t) => {
  const opt = document.createElement('button');
  opt.type = 'button';
  opt.className = 'type-opt';
  opt.dataset.type = t.id;
  opt.innerHTML = SVG_OPEN + t.icon + '</svg>' + esc(t.one);
  opt.addEventListener('click', () => { editingType = t.id; syncTypeSelector(); });
  $('typeSelector').appendChild(opt);
});

// ─── RENDER LIST ───
function renderList(query) {
  const q    = query.toLowerCase();
  const favs = templates.filter((t) => t.favorited);
  favCount.textContent = favs.length;

  let pool;
  if (activeFilter === 'favs') {
    pool = favs;
  } else if (activeFilter !== 'all') {
    pool = templates.filter((t) => typeOf(t) === activeFilter);
  } else {
    pool = favs.concat(templates.filter((t) => !t.favorited));
  }

  const filtered = q
    ? pool.filter((t) =>
        t.name.toLowerCase().includes(q) || t.body.toLowerCase().includes(q)
      )
    : pool;

  if (q) {
    countBadge.textContent = filtered.length + ' of ' + pool.length + (pool.length === 1 ? ' item' : ' items');
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
    const info = typeInfo(activeFilter);
    noType.dataset.type = info.id;
    const rgb = getComputedStyle(noType).getPropertyValue('--c');
    $('noTypeIcon').innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(' + rgb +
      ')" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + info.icon + '</svg>';
    $('noTypeTitle').textContent = 'No ' + info.label.toLowerCase() + ' yet';
    $('noTypeText').innerHTML = esc(info.hint) + '.<br>Create a new item and set its category to <strong style="color:rgb(' +
      rgb + ')">' + esc(info.one) + '</strong>';
    noType.style.display = 'flex';
    return;
  }

  if (filtered.length === 0) { noResults.style.display = 'flex'; return; }

  tplList.style.display = 'flex';
  filtered.forEach((tpl, idx) => {
    tplList.appendChild(buildCard(tpl, q, idx));
  });
}

// ─── BUILD CARD ───
function buildCard(tpl, q, idx) {
  const fields  = extractFields(tpl.body);
  const card    = document.createElement('div');
  card.className = 'card';
  card.style.animationDelay = (idx * 28) + 'ms';

  // Head
  const head = document.createElement('div');
  head.className = 'card-head';

  const name = document.createElement('div');
  name.className = 'card-name';
  name.title = tpl.name;
  name.innerHTML = q ? highlight(esc(tpl.name), q) : esc(tpl.name);

  const btns = document.createElement('div');
  btns.className = 'card-btns';

  const starBtn = document.createElement('button');
  starBtn.className = 'btn-icon star' + (tpl.favorited ? ' active' : '');
  starBtn.title = tpl.favorited ? 'Remove from favorites' : 'Add to favorites';
  starBtn.innerHTML = tpl.favorited
    ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
    : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  starBtn.addEventListener('click', () => toggleFavorite(tpl.id));

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-icon copy';
  copyBtn.title = 'Copy template text';
  copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
  copyBtn.addEventListener('click', () => vscode.postMessage({ type: 'copy', text: tpl.body }));

  const editBtn = document.createElement('button');
  editBtn.className = 'btn-icon';
  editBtn.title = 'Edit template';
  editBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  editBtn.addEventListener('click', () => openEdit(tpl.id));

  const delBtn = document.createElement('button');
  delBtn.className = 'btn-icon danger';
  delBtn.title = 'Delete template';
  delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>';
  delBtn.addEventListener('click', () => openDelete(tpl.id));

  btns.append(copyBtn, starBtn, editBtn, delBtn);
  head.append(name, btns);

  // Preview
  const preview = document.createElement('div');
  preview.className = 'card-preview';
  preview.innerHTML = q ? highlight(esc(tpl.body), q) : esc(tpl.body);

  // Footer
  const foot = document.createElement('div');
  foot.className = 'card-foot';

  const meta = document.createElement('div');
  meta.className = 'card-meta';

  const typeBadge = document.createElement('span');
  typeBadge.className = 'type-badge';
  typeBadge.dataset.type = typeOf(tpl);
  typeBadge.textContent = typeInfo(typeOf(tpl)).one;
  meta.appendChild(typeBadge);

  if (tpl.shared) {
    const syncedBadge = document.createElement('span');
    syncedBadge.className = 'synced-badge';
    syncedBadge.title = 'Synced from the shared library. Editing it makes it your own copy.';
    syncedBadge.textContent = 'Shared';
    meta.appendChild(syncedBadge);
  }

  if (fields.length > 0) {
    const badge = document.createElement('span');
    badge.className = 'fields-badge';
    badge.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><circle cx="7" cy="7" r="1" fill="currentColor" stroke="none"/></svg>' +
      fields.length + (fields.length === 1 ? ' field' : ' fields');
    meta.appendChild(badge);
  }

  const useBtn = document.createElement('button');
  useBtn.className = 'use-btn';
  useBtn.innerHTML =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>' +
    'Use Template';
  useBtn.addEventListener('click', () => openUse(tpl.id));

  foot.append(meta, useBtn);
  card.append(head, preview, foot);
  return card;
}

// ─── FIELD EXTRACTION ───
// Returns ordered array of unique fields: { key, label }
// Named fields are deduplicated by trimmed name.
// Empty/whitespace-only brackets each become a separate numbered field.
function extractFields(body) {
  const re = /\[([^\]]*)\]/g;
  const fields = [];
  const seenNamed = new Set();
  let unnamedCount = 0;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1].trim();
    if (name === '') {
      unnamedCount++;
      fields.push({ key: '__u' + unnamedCount, label: 'Field ' + unnamedCount });
    } else if (!seenNamed.has(name)) {
      seenNamed.add(name);
      fields.push({ key: name, label: name });
    }
  }
  return fields;
}

// Build the final text with placeholders replaced by user values.
// Named fields: all occurrences replaced. Unnamed fields: replaced in order.
function applyFields(body, values) {
  const re = /\[([^\]]*)\]/g;
  let result = '';
  let last = 0;
  let unnamedIdx = 0;
  let m;
  while ((m = re.exec(body)) !== null) {
    result += body.slice(last, m.index);
    const name = m[1].trim();
    let key;
    if (name === '') { unnamedIdx++; key = '__u' + unnamedIdx; }
    else key = name;
    const val = values[key];
    result += (val !== undefined && val !== '') ? val : m[0];
    last = m.index + m[0].length;
  }
  result += body.slice(last);
  return result;
}

// Build HTML preview — filled fields shown in green, unfilled as styled placeholders.
function buildPreview(body, values) {
  const re = /\[([^\]]*)\]/g;
  let html = '';
  let last = 0;
  let unnamedIdx = 0;
  let m;
  while ((m = re.exec(body)) !== null) {
    html += esc(body.slice(last, m.index));
    const name = m[1].trim();
    let key;
    if (name === '') { unnamedIdx++; key = '__u' + unnamedIdx; }
    else key = name;
    const val = values[key];
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

// ─── EDIT MODAL ───
function openEdit(id) {
  const tpl = id ? templates.find((t) => t.id === id) : null;
  editingId = id || null;

  $('editTitle').textContent = tpl ? 'Edit Template' : 'New Template';
  $('tplName').value = tpl ? tpl.name : '';
  $('tplBody').value = tpl ? tpl.body : '';
  $('nameErr').textContent = '';
  $('bodyErr').textContent = '';

  // New items default to the tab you're currently viewing
  editingType = tpl ? typeOf(tpl) : (typeInfo(activeFilter) ? activeFilter : 'client');
  syncTypeSelector();

  refreshCharCount();
  refreshDetected();

  $('editOverlay').classList.add('open');
  setTimeout(() => $('tplName').focus(), 80);
}

function closeEdit() {
  $('editOverlay').classList.remove('open');
  editingId = null;
}

function refreshCharCount() {
  $('charCount').textContent = $('tplBody').value.length.toLocaleString();
}

function refreshDetected() {
  const fields = extractFields($('tplBody').value);
  const box    = $('detectedFields');
  const tags   = $('detectedTags');
  if (fields.length === 0) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  tags.innerHTML = '';
  fields.forEach((f) => {
    const el = document.createElement('span');
    el.className = 'dtag';
    el.textContent = f.label;
    tags.appendChild(el);
  });
}

$('tplBody').addEventListener('input', () => {
  refreshCharCount();
  refreshDetected();
  $('bodyErr').textContent = '';
});
$('tplName').addEventListener('input', () => { $('nameErr').textContent = ''; });

$('newBtn').addEventListener('click',   () => openEdit(null));
$('emptyBtn').addEventListener('click', () => openEdit(null));
$('editClose').addEventListener('click', closeEdit);
$('editCancel').addEventListener('click', closeEdit);

$('editSave').addEventListener('click', saveTemplate);

function saveTemplate() {
  const name = $('tplName').value.trim();
  const body = $('tplBody').value.trim();
  let ok = true;

  if (!name) {
    $('nameErr').textContent = 'Template name is required.';
    ok = false;
  } else {
    const dup = templates.find(
      (t) => t.name.toLowerCase() === name.toLowerCase() && t.id !== editingId
    );
    if (dup) { $('nameErr').textContent = 'A template with this name already exists.'; ok = false; }
  }

  if (!body) { $('bodyErr').textContent = 'Template body cannot be empty.'; ok = false; }

  if (!ok) return;

  vscode.postMessage({ type: 'save', isNew: !editingId, id: editingId, name, body, tplType: editingType });
  closeEdit();
  showToast(editingId ? 'Template updated!' : 'Template created!', 'success');
}

// ─── DELETE MODAL ───
function openDelete(id) {
  deletingId = id;
  const tpl = templates.find((t) => t.id === id);
  $('delName').textContent = tpl ? tpl.name : '';
  $('delOverlay').classList.add('open');
}

function closeDelete() {
  $('delOverlay').classList.remove('open');
  deletingId = null;
}

$('delClose').addEventListener('click',   closeDelete);
$('delCancel').addEventListener('click',  closeDelete);
$('delConfirm').addEventListener('click', () => {
  if (!deletingId) return;
  vscode.postMessage({ type: 'delete', id: deletingId });
  closeDelete();
  showToast('Template deleted', 'info');
});

// ─── USE MODAL ───
function openUse(id) {
  const tpl = templates.find((t) => t.id === id);
  if (!tpl) return;

  currentTpl  = tpl;
  fieldValues = {};

  $('useTitle').textContent = tpl.name;

  const fields    = extractFields(tpl.body);
  const fieldsCol = $('fieldsCol');
  const dynFields = $('dynFields');
  const useBody   = $('useBody');

  dynFields.innerHTML = '';

  if (fields.length > 0) {
    fieldsCol.style.display = 'block';
    useBody.classList.add('has-fields');
    fields.forEach((field) => {
      fieldValues[field.key] = '';
      const grp   = document.createElement('div');
      grp.className = 'field-group';

      const lbl  = document.createElement('label');
      lbl.className = 'field-label';
      lbl.innerHTML = '<span>' + esc(field.label) + '</span>';

      const inp  = document.createElement('input');
      inp.type        = 'text';
      inp.className   = 'form-input';
      inp.placeholder = 'Value for ' + field.label + '...';
      inp.dataset.key = field.key;

      inp.addEventListener('input', () => {
        fieldValues[field.key] = inp.value;
        updatePreview();
      });

      grp.append(lbl, inp);
      dynFields.appendChild(grp);
    });
  } else {
    fieldsCol.style.display = 'none';
    useBody.classList.remove('has-fields');
  }

  updatePreview();
  $('useOverlay').classList.add('open');

  // Focus first field
  setTimeout(() => {
    const first = dynFields.querySelector('input');
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

$('copyBtn').addEventListener('click', () => {
  vscode.postMessage({ type: 'copy', text: getFinal() });
});

$('insertBtn').addEventListener('click', () => {
  const text = getFinal();
  vscode.postMessage({ type: 'insert', text });
  closeUse();
});

// ─── KEYBOARD SHORTCUTS ───
document.addEventListener('keydown', (e) => {
  // Escape closes any open modal
  if (e.key === 'Escape') {
    if ($('editOverlay').classList.contains('open'))  { closeEdit();   return; }
    if ($('useOverlay').classList.contains('open'))   { closeUse();    return; }
    if ($('delOverlay').classList.contains('open'))   { closeDelete(); return; }
  }
  // Ctrl/Cmd + Enter to confirm
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if ($('editOverlay').classList.contains('open')) { saveTemplate(); return; }
    if ($('useOverlay').classList.contains('open'))  { $('insertBtn').click(); return; }
  }
});

// ─── UTILITIES ───
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlight(html, q) {
  if (!q) return html;
  const safe = q.replace(/[.*+?^\${}()|[\]\\]/g, '\\\\$&');
  return html.replace(new RegExp('(' + safe + ')', 'gi'), '<mark>$1</mark>');
}

let toastTimer;
function showToast(text, kind) {
  const el = $('toast');
  el.textContent = text;
  el.className   = 'toast ' + (kind || 'success') + ' show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

// ─── EXPORT ───
$('syncBtn').addEventListener('click', () => vscode.postMessage({ type: 'sync' }));

$('exportBtn').addEventListener('click', () => {
  if (templates.length === 0) { showToast('No templates to export', 'info'); return; }
  vscode.postMessage({ type: 'export', data: JSON.stringify(templates, null, 2) });
});

// ─── IMPORT ───
$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let text;
  try { text = await file.text(); }
  catch { showToast('Could not read file', 'error'); return; }
  let imported;
  try { imported = JSON.parse(text); }
  catch { showToast('Invalid JSON file', 'error'); return; }
  // Accepts the old plain array or the { version, templates } library format
  const items = Array.isArray(imported) ? imported : (imported && imported.templates);
  if (!Array.isArray(items)) { showToast('File must contain a template array', 'error'); return; }
  vscode.postMessage({ type: 'bulkImport', data: items });
});
</script>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
