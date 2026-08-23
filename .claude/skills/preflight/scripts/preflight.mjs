#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve, extname } from 'node:path';

const ROOT = resolve(process.argv[2] || process.cwd());
const SKIP_DIRS = new Set(['vendor', 'icons', 'node_modules', '.git', '.claude']);
const PERMISSIONS_WITHOUT_API = new Set([
  'activeTab', 'unlimitedStorage', 'clipboardWrite', 'clipboardRead',
  'background', 'webRequest', 'declarativeNetRequest',
]);

const problems = [];
const warnings = [];
const fail = (check, detail) => problems.push({ check, detail });
const warn = (check, detail) => warnings.push({ check, detail });

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(ROOT, full));
  }
  return out;
}

const files = walk(ROOT);
const scripts = files.filter((f) => extname(f) === '.js');
const pages = files.filter((f) => extname(f) === '.html');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const strip = (ref) => ref.split(/[?#]/)[0];
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// 1. every script parses
// `node --check file.js` silently passes broken ESM: only stdin honours --input-type.
for (const file of scripts) {
  try {
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
      input: read(file),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    fail('syntax', `${file}\n${String(e.stderr || e.message).trim().split('\n').slice(0, 4).join('\n')}`);
  }
}

// 2. manifest is valid and its entry points exist
let manifest = null;
try {
  manifest = JSON.parse(read('manifest.json'));
} catch (e) {
  fail('manifest', `manifest.json is not valid JSON: ${e.message}`);
}

const roots = new Set();
let rootsIntact = true;
if (manifest) {
  const claim = (ref, where) => {
    if (!ref) return;
    const path = strip(ref);
    if (/^(https?:)?\/\//.test(path)) return;
    roots.add(path);
    if (!existsSync(join(ROOT, path))) {
      fail('manifest', `${where} points at a missing file: ${path}`);
      rootsIntact = false;
    }
  };

  claim(manifest.background?.service_worker, 'background.service_worker');
  claim(manifest.side_panel?.default_path, 'side_panel.default_path');
  claim(manifest.options_page, 'options_page');
  claim(manifest.action?.default_popup, 'action.default_popup');
  for (const entry of manifest.content_scripts || []) {
    for (const js of entry.js || []) claim(js, 'content_scripts.js');
    for (const css of entry.css || []) claim(css, 'content_scripts.css');
  }
  for (const icon of Object.values(manifest.icons || {})) claim(icon, 'icons');
  for (const icon of Object.values(manifest.action?.default_icon || {})) claim(icon, 'action.default_icon');

  if (manifest.manifest_version !== 3) fail('manifest', 'manifest_version must be 3');
  const csp = manifest.content_security_policy?.extension_pages || '';
  if (!csp.includes("script-src 'self'")) {
    fail('manifest', "extension_pages CSP must pin script-src to 'self'");
  }
  if (/unsafe-eval(?!')/.test(csp.replace("'wasm-unsafe-eval'", ''))) {
    fail('manifest', "extension_pages CSP must not allow 'unsafe-eval'");
  }
}

// 3. pages load only local assets
for (const page of pages) {
  const html = read(page);
  const dir = dirname(page);
  for (const [, ref] of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
    if (/^(https?:)?\/\//.test(ref)) {
      fail('csp', `${page} loads a remote script (MV3 blocks it): ${ref}`);
      continue;
    }
    const target = join(dir, strip(ref));
    if (!existsSync(join(ROOT, target))) fail('assets', `${page} references a missing script: ${ref}`);
  }
  for (const [, ref] of html.matchAll(/<link[^>]+href=["']([^"']+)["']/g)) {
    if (/^(https?:)?\/\//.test(ref)) {
      fail('csp', `${page} loads a remote stylesheet or font (MV3 blocks it): ${ref}`);
      continue;
    }
    const target = join(dir, strip(ref));
    if (!existsSync(join(ROOT, target))) fail('assets', `${page} references a missing stylesheet: ${ref}`);
  }
  if (/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html)) {
    fail('csp', `${page} contains an inline <script>; MV3 refuses to run it`);
  }
  if (/\son[a-z]+=["']/.test(html)) {
    fail('csp', `${page} uses an inline event handler attribute; MV3 refuses to run it`);
  }
}

// 4. relative imports and string-referenced assets resolve
function referencesOf(file) {
  const source = read(file);
  const dir = dirname(file);
  const found = new Set();

  if (extname(file) === '.js') {
    for (const [, ref] of source.matchAll(/(?:^|[^\w.])(?:import|export)[\s\S]{0,120}?from\s*['"]([^'"]+)['"]/g)) {
      if (!ref.startsWith('.')) continue;
      const target = join(dir, ref);
      if (!existsSync(join(ROOT, target))) fail('imports', `${file} imports a missing module: ${ref}`);
      else found.add(target);
    }
    for (const [, ref] of source.matchAll(/['"]([\w./-]+\.(?:js|html|css))(?:[?#][^'"]*)?['"]/g)) {
      const target = ref.startsWith('.') ? join(dir, ref) : ref;
      if (existsSync(join(ROOT, target))) found.add(target);
    }
  } else {
    for (const [, ref] of source.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css|html))(?:[?#][^"']*)?["']/g)) {
      const target = join(dir, strip(ref));
      if (existsSync(join(ROOT, target))) found.add(target);
    }
  }
  return [...found];
}

// 5. every shipped file is reachable from a manifest entry point
const reachable = new Set();
const queue = [...roots].filter((r) => existsSync(join(ROOT, r)));
while (queue.length) {
  const file = queue.shift();
  if (reachable.has(file)) continue;
  reachable.add(file);
  if (!/\.(js|html)$/.test(file)) continue;
  for (const ref of referencesOf(file)) if (!reachable.has(ref)) queue.push(ref);
}

if (rootsIntact) {
  for (const file of [...scripts, ...pages]) {
    if (!reachable.has(file)) {
      warn('dead-code', `${file} is not reachable from manifest.json — delete it or wire it up`);
    }
  }
}

// 6. every message that is sent has a handler somewhere
const liveScripts = scripts.filter((f) => reachable.has(f));
const sent = new Map();
const handled = new Set();
for (const file of liveScripts) {
  const source = read(file);
  for (const [, type] of source.matchAll(/type:\s*'([A-Z][A-Z0-9_]+)'/g)) {
    if (!sent.has(type)) sent.set(type, new Set());
    sent.get(type).add(file);
  }
  for (const [, type] of source.matchAll(/case\s*'([A-Z][A-Z0-9_]+)'/g)) handled.add(type);
  for (const [, type] of source.matchAll(/type\s*===\s*'([A-Z][A-Z0-9_]+)'/g)) handled.add(type);
}
for (const [type, senders] of sent) {
  if (rootsIntact && !handled.has(type)) {
    fail('protocol', `${type} is sent by ${[...senders].join(', ')} but no context handles it`);
  }
}

// 7. declared permissions are actually used
if (manifest) {
  const live = liveScripts.map((f) => stripComments(read(f))).join('\n');
  for (const permission of manifest.permissions || []) {
    if (PERMISSIONS_WITHOUT_API.has(permission)) continue;
    if (rootsIntact && !live.includes(`chrome.${permission}`)) {
      warn('permissions', `"${permission}" is requested in manifest.json but never used — drop it`);
    }
  }
  // Todo lo listado aquí es legible por cualquier sitio que el usuario visite, y
  // permite detectar que la extensión está instalada. Sólo hace falta cuando un
  // content script o la propia página web carga el recurso: las páginas y los
  // workers de la extensión leen sus archivos por mismo origen, sin esto.
  for (const entry of manifest.web_accessible_resources || []) {
    const abierto = (entry.matches || []).some((m) => m === '<all_urls>' || /^\*:\/\/\*\//.test(m));
    if (abierto) {
      warn('permissions', `web_accessible_resources exposes ${(entry.resources || []).join(', ')} to every site — drop it unless a content script loads it`);
    }
  }

  const hosts = manifest.host_permissions || [];
  if (hosts.includes('<all_urls>') || (hosts.includes('http://*/*') && hosts.includes('https://*/*'))) {
    warn('permissions', 'host_permissions covers every site; narrow it to the APIs actually called if possible');
  }
}

// 8. unit tests, when they exist
const tests = files.filter((f) => f.endsWith('.test.js'));
if (tests.length) {
  try {
    execFileSync(process.execPath, ['--test', ...tests.map((t) => join(ROOT, t))], { stdio: 'pipe', cwd: ROOT });
  } catch (e) {
    fail('tests', String(e.stdout || e.message).trim().split('\n').slice(-25).join('\n'));
  }
} else {
  warn('tests', 'no *.test.js files found — segmenter.js, capture.js, coach.js and report.js are pure and testable');
}

const label = (kind) => (kind === 'fail' ? 'FAIL' : 'WARN');
for (const kind of ['fail', 'warn']) {
  for (const { check, detail } of kind === 'fail' ? problems : warnings) {
    console.log(`${label(kind)}  ${check.padEnd(12)}${detail}`);
  }
}
console.log(
  `\n${scripts.length} scripts, ${pages.length} pages, ${tests.length} test files · ` +
  `${problems.length} failing, ${warnings.length} warnings`
);
process.exit(problems.length ? 1 : 0);
