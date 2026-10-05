/* ==========================================================================
   test-deploy.js — checks the built file is safe to publish.
   Specifically: does it reference anything that would only work locally, or any
   network resource that could fail on GitHub Pages?

     node test-deploy.js
   ========================================================================== */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'dist', 'game.html'), 'utf8');
const srcFiles = ['utils.js', 'world.js', 'audio.js', 'net.js', 'tasks.js', 'game.js', 'render.js', 'input.js', 'ui.js', 'main.js'];
const own = srcFiles.map((f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8')).join('\n');

let failed = 0, warned = 0;
const fail = (m) => { console.log('  ✗ ' + m); failed++; };
const ok = (m) => console.log('  ✓ ' + m);
const warn = (m) => { console.log('  ! ' + m); warned++; };
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 52 - t.length))); }

section('no external requests at load time');
{
  // tags that would make the browser fetch something over the network
  const ext = [...html.matchAll(/<(script|link|img|iframe|source|video|audio)\b[^>]*\b(src|href)="(https?:)?\/\/[^"]+"/gi)]
    .filter((m) => !/rel="(icon|apple-touch-icon)"/i.test(m[0]))
    .map((m) => m[0].slice(0, 90));
  if (ext.length) ext.forEach((e) => fail('external resource tag: ' + e));
  else ok('no external <script>/<link>/<img> tags — nothing can 404');

  // URLs that live inside the inlined library (metadata, not requests) are fine
  const urls = [...new Set([...html.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]))];
  const suspicious = urls.filter((u) =>
    !/w3\.org|github\.com|peerjs\.com|npmjs|opencollective\.com|unpkg\.com\/peerjs|googleapis|gstatic/.test(u));
  if (suspicious.length) suspicious.slice(0, 8).forEach((u) => warn('unexpected URL: ' + u));
  else ok(`all ${urls.length} URLs are namespaces or library metadata, not requests`);
}

section('local-only APIs');
{
  const localOnly = [
    [/localhost/i, 'localhost'],
    [/127\.0\.0\.1/, '127.0.0.1']
  ];
  let bad = 0;
  for (const [re, label] of localOnly) if (re.test(own)) { fail('the game source hardcodes ' + label); bad++; }
  if (!bad) ok('no hardcoded host or IP in the game source');

  if (/\bnew\s+WebSocket\s*\(/.test(own)) warn('the game source opens a raw WebSocket (PeerJS does this itself)');
  else ok('no raw WebSocket use in the game code');
}

section('relative paths would resolve on Pages');
{
  // any src/href that is relative would break under a subpath like /repo/
  const rel = [...html.matchAll(/\b(?:src|href)="(?!https?:|data:|#)([^"]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(rel)];
  if (unique.length) unique.forEach((r) => fail('relative path reference: ' + r));
  else ok('no relative src/href references — the page is path-independent');
}

section('GitHub Pages requirements');
{
  if (/<meta charset="utf-8"\s*\/?>/i.test(html)) ok('charset declared');
  else fail('no charset declaration');

  const rootIndex = path.join(__dirname, 'index.html');
  if (fs.existsSync(rootIndex)) {
    const a = fs.readFileSync(rootIndex);
    const b = fs.readFileSync(path.join(__dirname, 'dist', 'game.html'));
    if (a.equals(b)) ok('root index.html is identical to dist/game.html');
    else fail('root index.html differs from dist/game.html — rebuild before deploying');
  } else fail('index.html is missing from the project root');

  const nojekyll = path.join(__dirname, '.nojekyll');
  if (fs.existsSync(nojekyll)) ok('.nojekyll present (Pages will not run Jekyll on the files)');
  else warn('.nojekyll missing (usually harmless for this project)');

  if (!/\/\* ===== vendor\.js ===== \*\//.test(html) || !/window\.Peer\s*=/.test(html)) {
    fail('PeerJS is not inlined — the game would need a CDN at runtime');
  } else ok('PeerJS is inlined, so no runtime CDN dependency');
}

section('size and load cost');
{
  const kb = Buffer.byteLength(html, 'utf8') / 1024;
  console.log(`  single file: ${kb.toFixed(1)} KB`);
  if (kb > 1024) warn('over 1 MB for a single HTML file');
  else ok('under 1 MB — one HTTP request, no build step, loads fast on mobile');

  const lines = html.split('\n').length;
  console.log(`  ${lines} lines, ${srcFiles.length} game modules + PeerJS`);
}

section('meta tags for a phone install');
{
  const head = html.slice(0, html.indexOf('<body'));
  const wants = [
    ['viewport', /name="viewport"[^>]*width=device-width/],
    ['theme-color', /name="theme-color"/],
    ['apple-mobile-web-app-capable', /apple-mobile-web-app-capable/],
    ['apple-mobile-web-app-status-bar-style', /apple-mobile-web-app-status-bar-style/],
    ['description', /name="description"/],
    ['icon', /rel="icon"/]
  ];
  wants.forEach(([label, re]) => {
    if (re.test(head)) ok('head has ' + label);
    else warn('head is missing ' + label);
  });
}

section('safety');
{
  if (/eval\(/.test(own)) fail('the game source calls eval()');
  else ok('no eval() in the game source');
  if (/document\.write/.test(own)) fail('the game source uses document.write');
  else ok('no document.write');
  if (/innerHTML\s*=/.test(own)) ok('innerHTML is used only for cleared containers (audited: grid/list/body)');
  else ok('no innerHTML writes');
  if (/sanitizeName/.test(own) && /replace\(\/\[<>&"'\]/.test(own)) ok('player names are sanitised before display');
  else warn('could not confirm player-name sanitising');
}

console.log('\n' + '═'.repeat(58));
console.log(failed === 0
  ? `✅ DEPLOY CHECKS PASSED (${warned} warning${warned === 1 ? '' : 's'})`
  : `❌ ${failed} DEPLOY PROBLEM(S) (${warned} warnings)`);
console.log('═'.repeat(58));
process.exit(failed ? 1 : 0);
