# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
cd app && npm install          # first-time setup (no native addons — installs fast)
PORT=3000 node server.js       # run locally (port 80 requires sudo; use PORT override)
```

No build step, no test runner, no linter configured.

## Architecture

Everything lives in `app/server.js` — single Express process, single file. Key decisions:

- **SQLite via `node:sqlite`** (Node.js built-in, v22.5+). No native add-on needed. Uses `DatabaseSync` (synchronous API, same style as `better-sqlite3`: `prepare().run()`, `prepare().all()`). Shows an `ExperimentalWarning` on startup — expected and harmless.
- **`PORT` from env** (`process.env.PORT || 80`). Fly.io sets `PORT=8080`; local dev uses `PORT=3000`.
- **Multer v2** for multipart. Site publish uses `memoryStorage` (RAM) so CSP tags can be stripped before writing to disk. File uploads use `dest: 'tmp/'` (stream to disk, then `fs.renameSync` to final path).
- **Route ordering matters**: `/_api/*` and `/uploads` static middleware are registered before the `/:name` catch-all. The catch-all also guards against `name` starting with `_` or being `uploads`.

## API

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/_api/sites/:name` | Publish/replace a site (multipart `files`) |
| `GET`  | `/_api/sites` | List all sites with metadata |
| `POST` | `/_api/data/:site` | Append a JSON entry |
| `GET`  | `/_api/data/:site` | Read all entries (ascending by id) |
| `POST` | `/_api/files/:site` | Upload a single file (multipart `file`) |
| `GET`  | `/:name/...` | Serve published static site |
| `GET`  | `/uploads/:site/...` | Serve uploaded files |

## Key behaviors

- **Publish wipes first**: `POST /_api/sites/:name` does `fs.rmSync(siteDir, { recursive: true })` before writing. No merge, no versioning.
- **Zip support**: single `.zip` upload is extracted via `adm-zip`, preserving folder structure.
- **CSP stripping**: before writing any `.html` file to `sites/`, a regex removes `<meta http-equiv="Content-Security-Policy" ...>` tags — AI-generated HTML sometimes includes these and they break the platform's own `/_api/*` fetch calls.
- **Visit counting**: only requests to `/:name/` or `/:name/index.html` increment `sites.visit_count`; asset requests do not.

## Deployment

DigitalOcean droplet running Ubuntu. Express listens on port 80 directly (no reverse proxy), managed by `pm2`. All state (`data.db`, `sites/`, `uploads/`) lives on the droplet's local disk. See README for full setup commands.
