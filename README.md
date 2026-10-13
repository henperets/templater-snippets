# Templater

**Build once, paste anywhere.** Save the messages you type over and over, mark the parts that change with `[Fields]`, and fill them in when you paste. Works as a Chrome extension and as a VS Code extension, and can keep a shared template library in sync from a public Git repo.

[![CI](https://github.com/henperets/templater-snippets/actions/workflows/ci.yml/badge.svg)](https://github.com/henperets/templater-snippets/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- Add a screenshot or short GIF here: docs/screenshot.png -->

## Why

Anyone who answers the same questions all day (support, sales, ops, engineering) ends up retyping near-identical messages, or hunting through old chats for "that reply I wrote last month". Templater keeps those replies one click away, and the `[Field]` placeholders make sure the details (customer name, date, order number) are filled in correctly every time.

## Features

- **Dynamic fields:** write `Hi [Customer Name], your order [Order ID] ships on [Date].` and Templater turns each `[Field]` into an input, with a live preview.
- **Four categories, each with its own color:** Replies (answers for clients), Prompts (for AI assistants), Skills (reusable instructions) and Guides (step-by-step how-tos).
- **Search and favorites:** search by name or content, and pin the ones you use most.
- **Two front-ends, one data model:**
  - **Chrome extension:** a floating panel on any page. Copy the result, or insert it into the field you were typing in.
  - **VS Code extension:** a panel that can insert the result straight into the editor.
- **Shared library via Git:** keep your templates in a public repo as one `templates.json`. Everyone who installs the extension gets updates automatically, with no manual export/import. See [How sync works](#how-sync-works).
- **Right-to-left friendly:** handles Hebrew and other RTL text.
- **No accounts, no tracking, no build step.** Plain JavaScript with zero runtime dependencies.

## Install

### Chrome (or any Chromium browser)

1. Clone or download this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the project folder.
4. Click the Templater icon on any web page to open the panel.

### VS Code

1. Clone this repo and open it in VS Code.
2. Press `F5` (uses the *Run Extension* launch config) to start an Extension Development Host.
3. Run **Templater: Open Template Manager** from the Command Palette, or press `Ctrl+Shift+Alt+T`.

## How sync works

The shared library is a single file, [`templates.json`](templates.json), in a public GitHub repo. On startup, and when you press **Sync**, the extension fetches the raw file and merges it into your local list.

```text
  you edit in the extension
          │  Export  → templates.json
          ▼
  commit & push to the repo ──► raw.githubusercontent.com ──► every user's extension (auto-sync)
```

Merge rules, all covered by [unit tests](test/sync.test.js):

| Situation | Result |
|---|---|
| New item in the repo | Added to the local list, marked **Shared** |
| Shared item changed in the repo | Updated locally; your favorite flag is kept |
| You edit a shared item | It becomes your own copy and is never overwritten |
| You delete a shared item | It stays deleted on later syncs |
| Item removed from the repo | Removed locally, unless you edited it |
| You own an item with the same id or name | Yours always wins |

To use your own library, fork this repo (or create a new one with a `templates.json`) and set `REMOTE_URL` in [`sync.js`](sync.js). The `templates.json` in this repo is a small sample library.

## Project structure

```text
manifest.json     Chrome extension manifest (MV3)
background.js     Service worker: toggles the panel on icon click
content.js        Injects the floating panel (an iframe) into the page
popup.html/.js    The Chrome UI (HTML, CSS and logic)
extension.js      VS Code extension: host logic and the webview UI
sync.js           Shared-library merge logic, used by both extensions (pure functions)
templates.json    Sample shared library
test/             Unit tests (node:test)
docs/             Architecture notes
```

More detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

Requires Node.js 18+ (no install step, there are no dependencies).

```bash
npm test        # unit tests for the sync/merge logic
npm run check   # syntax-check every source file
```

## Roadmap

- [ ] Configurable library URL (settings page / VS Code setting)
- [ ] Publish to the Chrome Web Store and VS Code Marketplace
- [ ] Share the UI code between the two front-ends instead of keeping two copies
- [ ] Import/export as Markdown files, one per template
- [ ] Keyboard-only flow for filling fields

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Hen Perets
