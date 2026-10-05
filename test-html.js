/* ==========================================================================
   test-html.js — static checks on the built single-file game.
     • every getElementById / refs list id exists in the HTML
     • every CSS class used by JS exists in the stylesheet (warns only)
     • the PeerJS CDN tag is present exactly once
     • no leftover debug output, no localhost references
     • the bundle parses as JavaScript

     node test-html.js
   ========================================================================== */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'dist', 'game.html'), 'utf8');
const srcFiles = ['vendor.js', 'utils.js', 'world.js', 'audio.js', 'net.js', 'tasks.js', 'game.js', 'render.js', 'input.js', 'ui.js', 'main.js'];
const js = srcFiles.map((f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8')).join('\n');
const css = fs.readFileSync(path.join(__dirname, 'src', 'style.css'), 'utf8');

let failed = 0, warned = 0;
const fail = (m) => { console.log('  ✗ ' + m); failed++; };
const warn = (m) => { console.log('  ! ' + m); warned++; };
const ok = (m) => console.log('  ✓ ' + m);
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 56 - t.length))); }

/* ---- ids ------------------------------------------------------------- */
section('element ids');
const htmlWithoutScripts = html.slice(0, html.indexOf('<script src='));
const ids = new Set();
for (const m of htmlWithoutScripts.matchAll(/id="([^"]+)"/g)) ids.add(m[1]);

const referenced = new Set();
for (const m of js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) referenced.add(m[1]);
const cacheList = js.match(/\[\s*\n\s*'screen-menu'[\s\S]*?\]\.forEach/);
if (cacheList) for (const m of cacheList[0].matchAll(/'([^']+)'/g)) referenced.add(m[1]);

const missing = [...referenced].filter((id) => !ids.has(id));
if (missing.length) missing.forEach((m) => fail(`referenced id not in the HTML: #${m}`));
else ok(`all ${referenced.size} referenced ids exist in the HTML`);

const defined = new Set();
for (const m of js.matchAll(/refs\['([a-z0-9-]+)'\]\s*=/g)) defined.add(m[1]);
const unusedIds = [...ids].filter((id) => !referenced.has(id) && !/^screen-|^ov-/.test(id));
if (unusedIds.length) warn('ids in the HTML that JS never looks up: ' + unusedIds.join(', '));
else ok('no orphan element ids');

/* ---- classes --------------------------------------------------------- */
section('css classes');
const cssClasses = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) cssClasses.add(m[1]);
const usedClasses = new Set();
for (const m of js.matchAll(/class:\s*'([^']+)'/g)) {
  m[1].split(/\s+/).forEach((c) => { if (c) usedClasses.add(c); });
}
for (const m of js.matchAll(/classList\.(?:add|remove|toggle)\(\s*'([^']+)'/g)) usedClasses.add(m[1]);
const missingClasses = [...usedClasses].filter((c) => !cssClasses.has(c) && !/^(touch|ready|ingame)$/.test(c));
if (missingClasses.length) warn('classes used from JS but never styled: ' + missingClasses.join(', '));
else ok('every JS class is defined in the stylesheet');

/* ---- structure ------------------------------------------------------- */
section('bundle structure');
if (/<script src="https?:\/\//.test(html)) {
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  fail('external script tags present: ' + srcs.join(', '));
} else {
  ok('no external script tags — the bundle is self-contained');
}
if (/window\.Peer\s*=/.test(html)) ok('PeerJS is inlined in the bundle');
else fail('PeerJS is not inlined — run `node build-vendor.js` then rebuild');

for (const f of srcFiles) {
  if (!html.includes('/* ===== ' + f + ' ===== */')) fail(`module ${f} is not inlined`);
}
if (!failed) ok(`all ${srcFiles.length} modules are inlined`);

const ownJs = srcFiles.filter((f) => f !== 'vendor.js')
  .map((f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8')).join('\n');

if (/localhost|127\.0\.0\.1/.test(ownJs)) fail('the game source references localhost');
else ok('no localhost references in the game source');

if (/console\.log\(/.test(ownJs)) {
  const logs = [...ownJs.matchAll(/console\.log\(/g)].length;
  warn(`${logs} console.log call(s) left in the game source`);
} else ok('no stray console.log calls');

if (/TODO|FIXME/.test(ownJs)) warn('TODO/FIXME markers left in the source');
else ok('no TODO markers');

if (/data-i18n/.test(html)) ok('translation hooks present (harmless, ready for i18n)');

/* ---- JS syntax ------------------------------------------------------- */
section('syntax');
let syntaxErrors = 0;
for (const f of srcFiles) {
  const code = fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
  try { new Function(code); }
  catch (e) { fail(`${f}: ${e.message}`); syntaxErrors++; }
}
if (!syntaxErrors) ok(`all ${srcFiles.length} modules parse as JavaScript`);

/* the inline bundle must parse too */
const inline = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
try { new Function(inline); ok('the inlined <script> block parses'); }
catch (e) { fail('inlined script does not parse: ' + e.message); }

/* ---- size ------------------------------------------------------------ */
section('size');
const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log(`  bundle: ${kb} KB`);
if (Buffer.byteLength(html, 'utf8') > 700 * 1024) warn('bundle is larger than 700 KB');
else ok('bundle size is reasonable for a single file');

/* ---- required content ------------------------------------------------ */
section('required content');
const mustHave = [
  ['viewport meta', /name="viewport"/],
  ['theme colour', /name="theme-color"/],
  ['apple mobile web app', /apple-mobile-web-app-capable/],
  ['touch-action', /touch-action/],
  ['safe-area insets', /safe-area-inset/],
  ['joystick markup', /id="joystick"/],
  ['fullscreen button', /id="btn-fullscreen"/],
  ['map overlay', /id="ov-map"/],
  ['meeting overlay', /id="ov-meeting"/],
  ['result overlay', /id="ov-result"/],
  ['task overlay', /id="ov-task"/],
  ['rotate hint', /id="rotate-hint"/]
];
mustHave.forEach(([label, re]) => {
  if (re.test(html)) ok('has ' + label);
  else fail('missing ' + label);
});

/* ---- result ---------------------------------------------------------- */
console.log('\n' + '═'.repeat(62));
console.log(failed === 0
  ? `✅ HTML CHECKS PASSED (${warned} warning${warned === 1 ? '' : 's'})`
  : `❌ ${failed} HTML CHECK(S) FAILED (${warned} warnings)`);
console.log('═'.repeat(62));
process.exit(failed ? 1 : 0);
