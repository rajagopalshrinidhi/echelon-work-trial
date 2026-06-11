const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const multer = require('multer');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 80;

const DB_PATH = path.join(__dirname, 'data.db');
const SITES_DIR = path.join(__dirname, 'sites');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const LOGS_DIR = path.join(__dirname, 'logs');

fs.mkdirSync(SITES_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

const logStream = fs.createWriteStream(path.join(LOGS_DIR, 'app.log'), { flags: 'a' });

function log(level, msg, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra });
  logStream.write(line + '\n');
  console.log(line);
}

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sites (
    name TEXT PRIMARY KEY,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    visit_count INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS state (
    site TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const uploadMemory = multer({ storage: multer.memoryStorage() });
const uploadDisk = multer({ dest: path.join(__dirname, 'tmp') });

app.use(express.json());

// Request logging
app.use((req, res, next) => {
  res.on('finish', () => log('info', 'request', { method: req.method, url: req.url, status: res.statusCode }));
  next();
});

// Serve admin UI
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded files
app.use('/uploads', express.static(UPLOADS_DIR));

// Strip CSP meta tags from HTML content
function stripCSPMetaTags(html) {
  return html.replace(/<meta[^>]+http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi, '');
}

// POST /_api/sites/:name — publish/replace a site
app.post('/_api/sites/:name', uploadMemory.array('files'), async (req, res) => {
  const { name } = req.params;
  const files = req.files;

  if (!files || files.length === 0) {
    log('warn', 'publish failed — no files', { site: name });
    return res.status(400).json({ ok: false, error: 'No files uploaded' });
  }

  const siteDir = path.join(SITES_DIR, name);

  // Wipe existing site directory
  if (fs.existsSync(siteDir)) {
    fs.rmSync(siteDir, { recursive: true, force: true });
  }
  fs.mkdirSync(siteDir, { recursive: true });

  // Handle zip upload: single .zip file extracts into siteDir
  if (files.length === 1 && files[0].originalname.endsWith('.zip')) {
    const zip = new AdmZip(files[0].buffer);
    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const entryName = entry.entryName;
      const destPath = path.join(siteDir, entryName);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      let content = entry.getData();
      if (entryName.endsWith('.html')) {
        content = Buffer.from(stripCSPMetaTags(content.toString('utf8')), 'utf8');
      }
      fs.writeFileSync(destPath, content);
    }
  } else {
    // Flat file list
    for (const file of files) {
      let content = file.buffer;
      if (file.originalname.endsWith('.html')) {
        content = Buffer.from(stripCSPMetaTags(content.toString('utf8')), 'utf8');
      }
      const destPath = path.join(siteDir, file.originalname);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, content);
    }
  }

  // Upsert into sites table
  db.prepare(`
    INSERT INTO sites (name, created_at, updated_at, visit_count)
    VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)
    ON CONFLICT(name) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `).run(name);

  // If no index.html was uploaded but exactly one HTML file was, create index.html from it
  const written = fs.readdirSync(siteDir);
  const hasIndex = written.includes('index.html');
  const htmlFiles = written.filter(f => f.endsWith('.html'));
  if (!hasIndex && htmlFiles.length === 1) {
    fs.copyFileSync(path.join(siteDir, htmlFiles[0]), path.join(siteDir, 'index.html'));
  }

  log('info', 'site published', { site: name, files: files.map(f => f.originalname) });
  res.json({ ok: true, url: `/${name}/` });
});

// GET /_api/sites — list all sites
app.get('/_api/sites', (req, res) => {
  const rows = db.prepare('SELECT name, created_at, updated_at, visit_count FROM sites ORDER BY created_at DESC').all();
  res.json(rows);
});

// DELETE /_api/sites/:name — remove a site and all its data
app.delete('/_api/sites/:name', (req, res) => {
  const { name } = req.params;
  const siteDir = path.join(SITES_DIR, name);
  if (fs.existsSync(siteDir)) fs.rmSync(siteDir, { recursive: true, force: true });
  db.prepare('DELETE FROM sites WHERE name = ?').run(name);
  db.prepare('DELETE FROM state WHERE site = ?').run(name);
  log('info', 'site deleted', { site: name });
  res.json({ ok: true });
});

// POST /_api/data/:site — save a data entry
app.post('/_api/data/:site', (req, res) => {
  const { site } = req.params;
  const data = JSON.stringify(req.body);
  db.prepare('INSERT INTO entries (site, data) VALUES (?, ?)').run(site, data);
  res.json({ ok: true });
});

// GET /_api/data/:site — read all entries for a site
app.get('/_api/data/:site', (req, res) => {
  const { site } = req.params;
  const rows = db.prepare('SELECT data, created_at FROM entries WHERE site = ? ORDER BY id ASC').all(site);
  const entries = rows.map(row => ({ ...JSON.parse(row.data), created_at: row.created_at }));
  res.json(entries);
});

// GET /_api/state/:site — get saved form state
app.get('/_api/state/:site', (req, res) => {
  const { site } = req.params;
  const row = db.prepare('SELECT data FROM state WHERE site = ?').get(site);
  res.json(row ? JSON.parse(row.data) : {});
});

// PUT /_api/state/:site — upsert form state
app.put('/_api/state/:site', (req, res) => {
  const { site } = req.params;
  db.prepare(`
    INSERT INTO state (site, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(site) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP
  `).run(site, JSON.stringify(req.body));
  res.json({ ok: true });
});

// POST /_api/files/:site?folder=<id> — upload a file, optional subfolder for grouping
app.post('/_api/files/:site', uploadDisk.single('file'), (req, res) => {
  const { site } = req.params;
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

  // folder must be alphanumeric/dash/underscore only — prevents path traversal
  const raw = req.query.folder || '';
  const folder = /^[a-zA-Z0-9_-]+$/.test(raw) ? raw : null;

  const siteUploadsDir = folder
    ? path.join(UPLOADS_DIR, site, folder)
    : path.join(UPLOADS_DIR, site);
  fs.mkdirSync(siteUploadsDir, { recursive: true });

  const filename = `${Date.now()}-${req.file.originalname}`;
  const destPath = path.join(siteUploadsDir, filename);
  fs.renameSync(req.file.path, destPath);

  const url = folder
    ? `/uploads/${site}/${folder}/${filename}`
    : `/uploads/${site}/${filename}`;
  res.json({ url });
});

// GET /:name/... — serve published site, track visits on root
app.use('/:name', (req, res, next) => {
  const { name } = req.params;

  // Don't intercept API routes or static admin assets
  if (name.startsWith('_') || name === 'uploads') return next();

  const urlPath = req.path;
  if (urlPath === '/' || urlPath === '' || urlPath.endsWith('index.html')) {
    db.prepare('UPDATE sites SET visit_count = visit_count + 1 WHERE name = ?').run(name);
  }

  const siteDir = path.join(SITES_DIR, name);
  express.static(siteDir)(req, res, next);
});

app.listen(PORT, () => {
  log('info', `server started on port ${PORT}`);
});
