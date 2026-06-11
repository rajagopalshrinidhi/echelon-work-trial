#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

const args    = process.argv.slice(2);
const command = args[0];

if (command !== 'publish' || !args[1]) {
  console.log('Usage: echelon publish <file|folder> [--name <site>] [--host <url>] [--watch]');
  console.log('       ECHELON_HOST env var sets the default host.');
  process.exit(1);
}

const target = path.resolve(args[1]);

if (!fs.existsSync(target)) {
  console.error('Not found:', target);
  process.exit(1);
}

// Parse --flag value pairs
function flag(name) {
  const i = args.indexOf('--' + name);
  return i !== -1 ? args[i + 1] : null;
}
const hasFlag = name => args.includes('--' + name);

// Read optional echelon.json config from the target dir
const configDir  = fs.statSync(target).isDirectory() ? target : path.dirname(target);
const configFile = path.join(configDir, 'echelon.json');
let config = {};
if (fs.existsSync(configFile)) {
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (_) {}
}

const host  = flag('host') || config.host || process.env.ECHELON_HOST || 'http://localhost:3000';
const watch = hasFlag('watch');

// Derive site name: flag > config > basename (slugified)
let name = flag('name') || config.name;
if (!name) {
  const isDir = fs.statSync(target).isDirectory();
  const base  = isDir ? path.basename(target) : path.basename(target, path.extname(target));
  name = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Recursively collect files from a file or directory
function collectFiles(target) {
  if (!fs.statSync(target).isDirectory()) {
    return [{ full: target, rel: path.basename(target) }];
  }
  const results = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        results.push({ full, rel: path.relative(target, full).replace(/\\/g, '/') });
      }
    }
  })(target);
  return results;
}

async function publish() {
  const isFolder = fs.statSync(target).isDirectory();
  const files    = collectFiles(target);

  if (!files.length) {
    console.error('No files found at', target);
    return;
  }

  const fd = new FormData();
  for (const { full, rel } of files) {
    const buf  = fs.readFileSync(full);
    const blob = new Blob([buf]);
    fd.append('files', blob, path.basename(full));
    // Server strips the first path segment (mirrors webkitRelativePath behaviour)
    if (isFolder) fd.append('paths', name + '/' + rel);
  }

  try {
    const res  = await fetch(`${host}/_api/sites/${encodeURIComponent(name)}`, { method: 'POST', body: fd });
    const json = await res.json();
    if (json.ok) {
      console.log('Published →', host + json.url);
    } else {
      console.error('Publish failed:', json.error || JSON.stringify(json));
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

publish();

if (watch) {
  console.log('Watching', target, 'for changes…');
  let debounce;
  fs.watch(target, { recursive: true }, () => {
    clearTimeout(debounce);
    debounce = setTimeout(publish, 500);
  });
}
