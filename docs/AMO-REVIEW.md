# Notes for AMO reviewers

Déjà Vu records a user's interactions with a web page, and replays them later from the sidebar.
It's meant for web developers who keep filling in the same forms to reach the state they're
working on.

## Building from source

The uploaded extension is generated: TypeScript is compiled, and the sidebar is bundled with
React by Vite. To build it from the source package:

- Node.js 22 or newer (built with 22.15.0), with the npm that comes with it
- Any operating system. Nothing in the build depends on the platform.

```bash
npm ci
```

```bash
npm run package
```

This builds the extension into `dist/`, which is what the uploaded `.zip` contains, and zips it into
`artifacts/`. Compare `dist/` with the contents of the uploaded `.zip`.

| Uploaded file | Built from |
| --- | --- |
| `manifest.json`, `icons/` | Copied unchanged from `public/` |
| `background/index.js` | `src/background/index.ts`, not minified |
| `content/index.js` | `src/content-scripts/index.ts`, not minified |
| `sidebar/index.html`, `sidebar/assets/` | `src/sidebar-ui/`, bundled and minified with React and React DOM |

## Linter warnings

`web-ext lint` reports two `UNSAFE_VAR_ASSIGNMENT` warnings in `sidebar/assets/index-*.js`. Both are
inside React DOM, not in this extension's code. The extension's own source never assigns
`innerHTML`.

## Permissions

| Permission | Why |
| --- | --- |
| `cookies` | Setup steps set or delete cookies before a replay, so it starts from a known state. Only on sites the user has granted. |
| `scripting` | Injects the extension's own content script, `content/index.js`, into the tab being recorded or replayed. Only during a session. |
| `webNavigation` | Follows page loads and in-page navigation during a session, to re-inject into new documents and frames. |
| `tabs` | Reads the active tab's URL, to know which site to request access for. |
| `storage` | Keeps a recording session's identity if Firefox suspends the background page. |
| `*://*/*`, `file:///*` (optional) | Requested for one site at a time, when the user starts recording or replaying there. Users can revoke them in the extension's settings. Developers record against any site, including local files, so the set can't be narrowed in advance. |

## Data and remote code

- No data leaves the browser. There's no server, account, analytics or telemetry, and the
  extension makes no network requests of its own.
- No remote code. The only injected script is the packaged `content/index.js`. Nothing uses
  `eval` or `new Function`.
- Recordings are stored in IndexedDB in the user's profile. Password, card and one-time-code fields
  are never captured.

## Testing it

1. Open any page with a form, then open the sidebar with the toolbar button or **Alt+Shift+D**.
2. Press **Record**, grant access to the site, fill in a few fields, then press **Stop**.
3. Reload the page and press **Play**.

`tests/e2e/fixtures/form.html` is a ready-made test page.
