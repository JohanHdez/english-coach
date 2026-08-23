#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, basename, sep } from 'node:path';

const raw = readFileSync(0, 'utf8');
let file;
try {
  file = JSON.parse(raw)?.tool_input?.file_path;
} catch {
  process.exit(0);
}
if (!file) process.exit(0);

const parts = file.split(sep);
if (parts.includes('vendor') || parts.includes('node_modules')) process.exit(0);

const complain = (message) => {
  console.error(message);
  process.exit(2);
};

let source;
try {
  source = readFileSync(file, 'utf8');
} catch {
  process.exit(0);
}

if (extname(file) === '.js' || extname(file) === '.mjs') {
  try {
    // `node --check file.js` silently passes broken ESM; only stdin honours --input-type.
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
      input: source,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    const detail = String(e.stderr || e.message)
      .replace(/\[stdin\]/g, basename(file))
      .split('\n')
      .filter((line) => !/^\s+at /.test(line) && !/^Node\.js v/.test(line))
      .join('\n')
      .trim();
    complain(`${basename(file)} does not parse — Chrome will refuse to load it:\n${detail}`);
  }
}

if (extname(file) === '.json') {
  try {
    JSON.parse(source);
  } catch (e) {
    complain(`${basename(file)} is not valid JSON: ${e.message}`);
  }
}

if (basename(file) === 'manifest.json') {
  const manifest = JSON.parse(source);
  const csp = manifest.content_security_policy?.extension_pages || '';
  if (!csp.includes("script-src 'self'")) {
    complain("manifest.json: extension_pages CSP must keep script-src pinned to 'self'.");
  }
  console.error('manifest.json changed — run preflight and reload the extension in chrome://extensions.');
  process.exit(2);
}
