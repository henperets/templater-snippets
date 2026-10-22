# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Screenshots in the README.
- `REMOTE_URL = ''` in `src/sync.js` turns sync off, for a fully local setup.
- Test that parses the VS Code webview script as delivered.
- Shared template library: templates sync from a public Git repo's `templates.json` on startup and via a **Sync** button (Chrome and VS Code).
- Four color-coded categories: Replies, Prompts, Skills, Guides.
- One-click copy button on each template card.
- Unit tests for the sync/merge logic and a CI workflow.

### Changed
- The starter library now has two examples (one with `[Fields]`, one without) instead of eight.
- Clearer delete confirmation: names the template, explains what happens to shared items, and focuses **Cancel** by default.
- Source files moved to `src/`, icons to `icons/`, and project docs to `.github/` and `docs/`.
- VS Code command id renamed to `templater.open`.
- Export now writes `templates.json` in the shared-library format (no favorites or personal flags).
- Import accepts both the old plain array and the new library format, and keeps template ids.
- Unified the product name to "Templater" (it was partly "Favorite Tags").

### Fixed
- VS Code panel did nothing: the webview script failed to parse because the `[Field]` regex lost its backslashes inside the HTML template string. Search highlighting with special characters is fixed too.
- Importing a file no longer drops each template's category.

## [1.0.0]

### Added
- Reusable templates with `[Field]` placeholders, live preview, search and favorites.
- Chrome extension (floating panel) and VS Code extension.
- JSON export and import.
