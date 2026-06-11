# Echelon Publish

Internal static site hosting platform. Employees upload HTML/CSS/JS (or a zip), get a stable URL, and can use a simple data API for shared persistence.

## Running locally

```bash
cd app
npm install
PORT=3000 node server.js
```

Open `http://localhost:3000`. The SQLite database (`data.db`), published sites (`sites/`), and uploaded files (`uploads/`) are created automatically on first run and are gitignored.

**To test the demo site end-to-end:**
1. On the admin UI, set site name to `feedback-form` and upload `examples/feedback-form/index.html`
2. Visit `http://localhost:3000/feedback-form/`
3. Submit an entry (with or without a photo) — it should appear immediately below the form

## Deploying to a DigitalOcean droplet

**Connect to the droplet:**
```bash
ssh root@<your-droplet-ip>   # enter the password you set when creating the droplet
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

Things deliberately left out: auth/login, rate limiting, file size caps, CORS, WebSocket live updates, rollback/versioning, and multi-tenancy. The only sanitization applied to uploaded HTML is stripping `<meta http-equiv="Content-Security-Policy">` tags, which AI-generated pages sometimes include and which would otherwise block the data API calls from within published sites.
