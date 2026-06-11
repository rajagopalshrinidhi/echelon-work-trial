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
  CREATE TABLE IF NOT EXISTS user_state (
    site TEXT NOT NULL,
    user_id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (site, user_id)
  );
  CREATE TABLE IF NOT EXISTS visitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    user_name TEXT DEFAULT '',
    path TEXT DEFAULT '/',
    visited_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_visitors_site ON visitors(site);
`);

// Migrations: add columns to existing tables (silently skip if already present)
try { db.exec(`ALTER TABLE sites ADD COLUMN mode TEXT DEFAULT 'shared'`); } catch(_) {}
try { db.exec(`ALTER TABLE entries ADD COLUMN user_id TEXT DEFAULT ''`); } catch(_) {}

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

// Inject Echelon SDK into HTML before </body>
// Exposes window.Echelon.{save, load, saveState, loadState, uploadFile, userId, userName, setName}
// Also auto-captures submits on forms with data-echelon-form attribute, and tracks page visits
function injectEchelonSDK(html) {
  const script = `<script>
(function () {
  var SITE = location.pathname.split('/')[1];

  // Loose identity: UUID persisted in localStorage, shared across all sites on this platform
  var userId = (function () {
    var id = localStorage.getItem('echelon_user_id');
    if (!id) {
      id = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2);
      localStorage.setItem('echelon_user_id', id);
    }
    return id;
  })();
  var userName = localStorage.getItem('echelon_user_name') || '';

  window.Echelon = {
    site: SITE,
    userId: userId,
    userName: userName,
    setName: function (name) {
      localStorage.setItem('echelon_user_name', name);
      window.Echelon.userName = name;
    },
    save: function (data) {
      return fetch('/_api/data/' + SITE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).then(function (r) { return r.json(); });
    },
    load: function () {
      return fetch('/_api/data/' + SITE).then(function (r) { return r.json(); });
    },
    saveState: function (data) {
      return fetch('/_api/state/' + SITE + '?user=' + encodeURIComponent(userId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).then(function (r) { return r.json(); });
    },
    loadState: function () {
      return fetch('/_api/state/' + SITE + '?user=' + encodeURIComponent(userId))
        .then(function (r) { return r.json(); });
    },
    uploadFile: function (file, folder) {
      var fd = new FormData();
      fd.append('file', file);
      var url = folder
        ? '/_api/files/' + SITE + '?folder=' + encodeURIComponent(folder)
        : '/_api/files/' + SITE;
      return fetch(url, { method: 'POST', body: fd }).then(function (r) { return r.json(); });
    }
  };

  // Auto-capture submits only on forms with data-echelon-form attribute
  document.addEventListener('DOMContentLoaded', function () {
    // Track this page visit (fire-and-forget)
    fetch('/_api/visit/' + SITE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, user_name: userName, path: location.pathname })
    });

    document.querySelectorAll('form[data-echelon-form]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var data = {};
        new FormData(form).forEach(function (val, key) {
          if (Object.prototype.hasOwnProperty.call(data, key)) {
            if (Array.isArray(data[key])) { data[key].push(val); }
            else { data[key] = [data[key], val]; }
          } else {
            data[key] = val;
          }
        });
        Echelon.save(data);
      });
    });
  });
})();
<\/script>`;

  return html.includes('</body>')
    ? html.replace('</body>', script + '\n</body>')
    : html + '\n' + script;
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
        content = Buffer.from(injectEchelonSDK(stripCSPMetaTags(content.toString('utf8'))), 'utf8');
      }
      fs.writeFileSync(destPath, content);
    }
  } else {
    // Flat files or folder upload (paths[] array carries relative paths from webkitdirectory)
    const rawPaths = req.body && req.body.paths;
    const paths = rawPaths ? (Array.isArray(rawPaths) ? rawPaths : [rawPaths]) : null;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      let relPath;
      if (paths && paths[i]) {
        // webkitRelativePath looks like "folder-name/css/style.css" — strip top-level folder name
        const parts = paths[i].split('/');
        const inner = parts.slice(1).filter(p => p && p !== '..' && p !== '.');
        relPath = inner.length ? inner.join('/') : path.basename(file.originalname);
      } else {
        relPath = file.originalname;
      }
      let content = file.buffer;
      if (relPath.endsWith('.html')) {
        content = Buffer.from(injectEchelonSDK(stripCSPMetaTags(content.toString('utf8'))), 'utf8');
      }
      const destPath = path.join(siteDir, relPath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, content);
    }
  }

  // Upsert into sites table
  const mode = req.body && req.body.mode === 'individual' ? 'individual' : 'shared';
  db.prepare(`
    INSERT INTO sites (name, created_at, updated_at, visit_count, mode)
    VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, ?)
    ON CONFLICT(name) DO UPDATE SET updated_at = CURRENT_TIMESTAMP, mode = excluded.mode
  `).run(name, mode);

  // Auto-generate index.html if none was uploaded
  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif', '.bmp']);
  const written = fs.readdirSync(siteDir);
  const hasIndex = written.includes('index.html');
  const htmlFiles = written.filter(f => f.endsWith('.html'));
  const imageFiles = written.filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
  const pdfFiles = written.filter(f => path.extname(f).toLowerCase() === '.pdf');

  if (!hasIndex && htmlFiles.length === 1) {
    // Single HTML file — make it the index
    fs.copyFileSync(path.join(siteDir, htmlFiles[0]), path.join(siteDir, 'index.html'));
  } else if (!hasIndex && htmlFiles.length === 0) {
    // No HTML at all — generate a viewer for images and/or PDFs
    if (pdfFiles.length === 1 && imageFiles.length === 0) {
      // Full-page PDF embed
      fs.writeFileSync(path.join(siteDir, 'index.html'),
        `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${pdfFiles[0]}</title>` +
        `<style>*{margin:0;padding:0}html,body{height:100%}` +
        `embed{display:block;width:100%;height:100%}</style></head>` +
        `<body><embed src="${pdfFiles[0]}" type="application/pdf"></body></html>`
      );
    } else if (imageFiles.length > 0) {
      // Image gallery (+ PDF links if mixed)
      const imgs = imageFiles.map(f =>
        `<img src="${f}" alt="${f}">`
      ).join('\n');
      const pdfs = pdfFiles.map(f =>
        `<p class="pdf-link"><a href="${f}">📄 ${f}</a></p>`
      ).join('\n');
      fs.writeFileSync(path.join(siteDir, 'index.html'),
        `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Files</title>` +
        `<style>body{margin:0;padding:24px;background:#111;color:#eee;font-family:system-ui,sans-serif}` +
        `img{display:block;max-width:100%;margin-bottom:20px;border-radius:4px}` +
        `.pdf-link{margin-top:16px}a{color:#7eb8f7}</style></head>` +
        `<body>${imgs}${pdfs}</body></html>`
      );
    }
  }

  log('info', 'site published', { site: name, files: files.map(f => f.originalname) });
  res.json({ ok: true, url: `/${name}/` });
});

// GET /_api/sites — list all sites with unique visitor counts
app.get('/_api/sites', (req, res) => {
  const rows = db.prepare('SELECT name, created_at, updated_at, visit_count, mode FROM sites ORDER BY created_at DESC').all();
  const counts = db.prepare('SELECT site, COUNT(DISTINCT user_id) as unique_visitors FROM visitors GROUP BY site').all();
  const countMap = Object.fromEntries(counts.map(r => [r.site, r.unique_visitors]));
  res.json(rows.map(r => ({ ...r, unique_visitors: countMap[r.name] || 0 })));
});

// GET /_api/sites/:name — single site metadata
app.get('/_api/sites/:name', (req, res) => {
  const { name } = req.params;
  const row = db.prepare('SELECT name, created_at, updated_at, visit_count, mode FROM sites WHERE name = ?').get(name);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
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

// GET /_api/state/:site — get saved form state (shared or per-user)
app.get('/_api/state/:site', (req, res) => {
  const { site } = req.params;
  const user = req.query.user || '';
  if (user) {
    const row = db.prepare('SELECT data FROM user_state WHERE site = ? AND user_id = ?').get(site, user);
    res.json(row ? JSON.parse(row.data) : {});
  } else {
    const row = db.prepare('SELECT data FROM state WHERE site = ?').get(site);
    res.json(row ? JSON.parse(row.data) : {});
  }
});

// PUT /_api/state/:site — upsert form state (shared or per-user)
app.put('/_api/state/:site', (req, res) => {
  const { site } = req.params;
  const user = req.query.user || '';
  if (user) {
    db.prepare(`
      INSERT INTO user_state (site, user_id, data, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(site, user_id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP
    `).run(site, user, JSON.stringify(req.body));
  } else {
    db.prepare(`
      INSERT INTO state (site, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(site) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP
    `).run(site, JSON.stringify(req.body));
  }
  res.json({ ok: true });
});

// POST /_api/visit/:site — record a page visit
app.post('/_api/visit/:site', (req, res) => {
  const { site } = req.params;
  const { user_id = '', user_name = '', path = '/' } = req.body || {};
  db.prepare('INSERT INTO visitors (site, user_id, user_name, path) VALUES (?, ?, ?, ?)').run(site, user_id, user_name, path);
  res.json({ ok: true });
});

// GET /_api/visitors/:site — list visitors grouped by user
app.get('/_api/visitors/:site', (req, res) => {
  const { site } = req.params;
  const rows = db.prepare('SELECT user_id, user_name, path, visited_at FROM visitors WHERE site = ? ORDER BY visited_at ASC').all(site);
  const byUser = {};
  for (const r of rows) {
    if (!byUser[r.user_id]) byUser[r.user_id] = { user_id: r.user_id, user_name: r.user_name || '', visit_count: 0, last_visit: r.visited_at, pages: [] };
    const u = byUser[r.user_id];
    u.visit_count++;
    u.last_visit = r.visited_at;
    if (r.user_name && !u.user_name) u.user_name = r.user_name;
    else if (r.user_name) u.user_name = r.user_name;
    if (!u.pages.includes(r.path)) u.pages.push(r.path);
  }
  res.json(Object.values(byUser).sort((a, b) => b.last_visit.localeCompare(a.last_visit)));
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
