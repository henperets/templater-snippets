# Security Policy

## Supported versions

Only the latest version on `main` is supported.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's private reporting instead: go to the **Security** tab of this repository and choose **Report a vulnerability**.

Include what you found, how to reproduce it, and the impact you see. You can expect an acknowledgement within a week.

## Security notes

- The extension only makes one kind of network request: a `GET` for the library file at `REMOTE_URL` (`raw.githubusercontent.com`). It sends no user data.
- Synced templates are plain text. They are escaped before they are rendered, and never executed as code.
- Templates are stored locally (`chrome.storage.local` or VS Code `globalState`). Do not put secrets in templates, especially if you publish the library repo.
