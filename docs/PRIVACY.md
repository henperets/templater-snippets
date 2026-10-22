# Privacy

Templater does not collect, store or transmit personal data.

- **Your templates** are stored only on your device (browser extension storage or VS Code global state).
- **Network access:** the extension fetches one public file, the shared library (`templates.json`) from `raw.githubusercontent.com`. The request carries no account, identifier or template content. GitHub can see the request as it would for any file download.
- **No analytics, telemetry, ads or third-party scripts.**
- **Permissions (Chrome):** `storage` (save templates), `scripting` and `activeTab` (open the panel on the current page), `clipboardWrite` (the Copy button), and host access to `raw.githubusercontent.com` (library sync).
