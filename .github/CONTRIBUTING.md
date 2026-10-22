# Contributing

Thanks for your interest in Templater. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug or suggesting a feature

Open an issue using one of the templates. For bugs, please include the browser or VS Code version, what you did, what you expected, and what happened.

## Development setup

There are no dependencies and no build step. You only need Node.js 18+.

```bash
git clone <your fork>
cd <repo>
npm test
npm run check
```

- **Chrome:** load the folder at `chrome://extensions` (Developer mode, then *Load unpacked*). After editing, click the reload icon on the extension card.
- **VS Code:** open the folder and press `F5`.

## Where to change things

- All source code is in `src/`. The Chrome UI is `src/popup.html` and `src/popup.js`. The VS Code UI is embedded in `src/extension.js`. The two are currently separate copies, so UI changes usually need to be made in **both**.
- Merge and sync rules live in `src/sync.js` as pure functions. Every change there needs a test in `test/sync.test.js`.
- The category list is the `TYPES` array in `popup.js` and `extension.js`. Colors are the `[data-type]` rules in the CSS.
- The VS Code webview script is a JavaScript template string, so every backslash must be doubled (write `\\[` to get `\[`). `test/webview.test.js` parses the delivered script and fails if one is missed.
- The starter library is `templates.json` at the root. Keep it small: new installs sync it on first run.

## Pull requests

1. Branch from `main` with a descriptive name.
2. Keep the change focused. Mention both front-ends if it touches the UI.
3. Run `npm test` and `npm run check`.
4. Update `CHANGELOG.md` under **Unreleased**.
5. Describe what changed and why, and include a screenshot for UI changes.

## Style

Match the surrounding code. The Chrome popup uses `var` and plain functions, and the VS Code code uses modern syntax. See `.editorconfig` for whitespace.
