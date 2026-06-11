# Echelon Publish

Internal static site hosting platform. Employees upload HTML/CSS/JS (or a zip), get a stable URL, and can use a simple data API for shared persistence.

## Running locally

```bash
cd app
npm install
PORT=3000 node server.js
```

Open `http://localhost:3000`. The SQLite database (`data.db`), published sites (`sites/`), and uploaded files (`uploads/`) are created automatically on first run and are gitignored.

**To test the FSO intake form end-to-end:**
1. On the admin UI, set site name to `fso-intake` and upload `examples/fso_mailbox_intake_form.html`
2. Visit `http://localhost:3000/fso-intake/`
3. Fill out the form and submit — the entry is saved to `/_api/data/fso-intake`
4. Click the site name in the admin UI to open the viewer and confirm the submission appears

## Admin UI

The admin UI (`public/index.html`) has three cards:

- **Publish a site** — enter a site name and upload files (individual files or an entire folder via the Folder tab). Publishing replaces the site completely.
- **Upload a file** — upload a single file to `/_api/files/:site` and get a stable URL back with a Copy button. Useful for images and attachments referenced by published pages.
- **Published sites** — lists all sites with creation date, last updated, and visit count. Click a site name to open the data viewer. Delete removes the site directory and its DB record.

## Publish from the terminal

No admin UI needed — publish directly with `curl` or the included CLI.

### curl (zero setup)

```bash
# Single file
curl -F "files=@report.html" http://<host>/_api/sites/my-report

# Multiple files
curl -F "files=@index.html" -F "files=@style.css" http://<host>/_api/sites/my-site

# Returns: {"ok":true,"url":"/my-site/"}
```

### CLI (`cli/echelon.js`)

```bash
# Single file — site name defaults to filename
node cli/echelon.js publish report.html --host http://localhost:3000

# Explicit name
node cli/echelon.js publish report.html --name quarterly-report --host http://localhost:3000

# Entire folder
node cli/echelon.js publish ./dist --name my-app --host http://localhost:3000

# Watch mode — republishes on every save (~500 ms debounce)
node cli/echelon.js publish report.html --name my-report --watch

# Set host via env so you don't repeat it
export ECHELON_HOST=http://myserver
node cli/echelon.js publish report.html --name my-report
```

**Config file** — add `echelon.json` next to your files to set defaults:
```json
{ "name": "quarterly-report", "host": "http://myserver" }
```
Then just run `node cli/echelon.js publish report.html`.

**Jupyter notebooks:**
```bash
jupyter nbconvert --to html --embed-resources notebook.ipynb && \
  node cli/echelon.js publish notebook.html --name my-analysis
```

Requires Node 18+ (uses native `fetch` and `FormData`). No `npm install` needed.

## Authoring HTML with Claude

The fastest way for users to create forms that work on this platform is to use a Claude Project pre-configured with the platform's authoring rules. Claude generates a correct, self-contained HTML file that can be uploaded directly to the admin UI.

### Setting up the Claude Project

1. Go to [claude.ai](https://claude.ai) and click **Projects** in the left sidebar
2. Click **Create project** and name it something like `Echelon Form Builder`
3. Open **Project instructions** and paste the system prompt below
4. Share the project link with anyone who needs to author forms

### System prompt

```
You help users create HTML forms that are published to the Echelon internal platform.

When a page is published to Echelon, the platform automatically injects window.Echelon
into every HTML file. You do not need to import or load it — it is always available.

window.Echelon provides:

  Echelon.save(data)         — saves a JSON object to the platform database (POST)
  Echelon.load()             — returns all saved entries as an array (GET)
  Echelon.saveState(data)    — saves draft state that survives page refresh (PUT)
  Echelon.loadState()        — restores saved draft state (GET)
  Echelon.uploadFile(file, folder?)  — uploads a file, returns { url }
  Echelon.site               — the site name string (read-only)

Use one of two patterns depending on what the form needs:

PATTERN A — Zero JS (simple collection forms)
  Add data-echelon-form to the <form> element. The platform intercepts the submit
  event, serializes all named fields to JSON, and saves to the database automatically.
  Do not set an action attribute — it will be silently suppressed.
  Every input, select, and textarea must have a name attribute or it will be skipped.
  Multi-value fields (checkboxes sharing a name) are collected into an array.
  Example:
    <form data-echelon-form>
      <input name="requester" type="text">
      <button type="submit">Submit</button>
    </form>

PATTERN B — Custom JS (validation, multi-step, conditional logic)
  Write your own submit handler. Call Echelon.save(data) inside it with the data
  you want to persist. For long forms, call Echelon.saveState(data) on every input
  event to auto-save drafts so users do not lose progress on refresh.
  Example:
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await Echelon.save({ name: input.value });
    });
    form.addEventListener('input', () => {
      Echelon.saveState({ name: input.value });
    });

Rules:
- Always produce a single self-contained HTML file with no external dependencies.
- Never reference APIs, backends, or URLs other than Echelon.* methods.
- Never use localStorage or sessionStorage — all sites share the same browser
  origin, so storage keys collide across sites. Use Echelon.saveState() instead.
- For Pattern A, use data-echelon-form on the form element. Omit the action attribute entirely or set action="#".
- For Pattern B, always call Echelon.saveState() on input/change events for
  any form longer than a few fields.
- Do not import the Echelon SDK — it is injected automatically on publish.
```

### How users interact with the project

Users describe what they want in plain language. Claude handles the wiring:

> *"Create an intake form for IT support requests with fields for requester name, team, issue type (dropdown), urgency, and description. Save on submit and auto-save drafts."*

Claude returns a single HTML file ready to upload to the admin UI.

## Data APIs for published HTML

Every published HTML page has `window.Echelon` injected automatically — no import needed. For cases where you are writing JS by hand rather than using Claude:

```js
// Save a form submission
await Echelon.save({ field: 'value' });

// Read all submissions
const entries = await Echelon.load();

// Save draft state (survives refresh)
await Echelon.saveState({ step: 2, answers: [] });

// Restore state on page load
const draft = await Echelon.loadState();

// Upload a file
const { url } = await Echelon.uploadFile(fileInput.files[0]);
```

See `examples/fso_mailbox_intake_form.html` for a full working example.

## Storage layout

| Path | What lives here |
|---|---|
| `app/data.db` | SQLite — all entries, site metadata, and state |
| `app/sites/:name/` | Published HTML/CSS/JS/images (wiped on republish) |
| `app/uploads/:site/` | Files uploaded via `/_api/files/:site` (never wiped) |
| `app/logs/app.log` | JSON-per-line request log |

All storage is on the local disk of the machine running the server. There is no object storage or external database.

## Deploying to a DigitalOcean droplet

**Connect to the droplet:**
```bash
ssh root@<your-droplet-ip>
```

To avoid typing the password every time, add your SSH key after connecting once:
```bash
ssh-copy-id root@<your-droplet-ip>
```

**Once connected, run these in order on the droplet:**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
```
```bash
sudo apt-get install -y nodejs
```
```bash
sudo npm install -g pm2
```

Then deploy the code:

```bash
git clone <repo> /srv/echelon
```
```bash
cd /srv/echelon/app && npm install
```
```bash
pm2 start server.js --name echelon
pm2 save
pm2 startup   # copy-paste and run the command it prints
```

The server listens on port 80 directly — no nginx or reverse proxy needed. `data.db`, `sites/`, and `uploads/` live on the droplet's local disk and persist across restarts.

## Design decisions and deliberate omissions

The platform is intentionally minimal. There is no authentication — it's designed for a trusted internal team where friction is the bigger risk than abuse. Publishing a site with an existing name fully replaces it with no versioning or rollback; simplicity wins over safety nets. All state lives in a single SQLite file and local disk, which is enough for internal load and avoids any external service dependency.

The server uses Node's built-in `node:sqlite` module (no native add-on compilation required), which keeps the install simple across platforms and Node versions.

The only sanitization applied to uploaded HTML is stripping `<meta http-equiv="Content-Security-Policy">` tags, which AI-generated pages sometimes include and which would otherwise block the data API calls from within published sites.

Things deliberately left out: auth/login, rate limiting, file size caps, CORS, WebSocket live updates, rollback/versioning, and multi-tenancy.
