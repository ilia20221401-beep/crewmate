/* Builds the single-file game: dist/game.html
 *
 *   node build.js            -> dist/game.html
 *   node build.js --dev      -> dist/game.html plus dist/dev.html which loads
 *                               the src/*.js files separately (easier debugging)
 *
 * The output is ONE self-contained HTML file: markup, styles, the PeerJS
 * library and every game module are all inlined. No build tooling and no CDN
 * are required to run it.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

// order matters
const SCRIPTS = [
  'vendor.js',   // PeerJS
  'utils.js',
  'world.js',
  'audio.js',
  'net.js',
  'tasks.js',
  'game.js',
  'render.js',
  'input.js',
  'ui.js',
  'main.js'
];

const EXTRA_TESTS = ['test-mobile.js'];
const TESTABLE = SCRIPTS.filter((f) => f !== 'vendor.js');
const CDN_FALLBACK = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';

function read(p) { return fs.readFileSync(p, 'utf8'); }

function build() {
  const head = read(path.join(SRC, 'index.head.html'));
  const css = read(path.join(SRC, 'style.css'));
  const body = read(path.join(SRC, 'index.body.html'));

  const scripts = SCRIPTS.map((f) => {
    const code = read(path.join(SRC, f));
    return `/* ===== ${f} ===== */\n${code}`;
  }).join('\n');

  const html = head + css + '\n' + body + scripts + '\n</script>\n</body>\n</html>\n';

  /* ---------------- static validation ---------------- */

  const problems = [];

  // 1. every element id the JS looks up must exist in the markup
  const ids = new Set();
  for (const m of body.matchAll(/id="([^"]+)"/g)) ids.add(m[1]);

  const referenced = new Set();
  for (const m of scripts.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) referenced.add(m[1]);
  const cacheList = scripts.match(/\[\s*\n\s*'screen-menu'[\s\S]*?\]\.forEach/);
  if (cacheList) for (const m of cacheList[0].matchAll(/'([^']+)'/g)) referenced.add(m[1]);
  for (const id of referenced) {
    if (!ids.has(id)) problems.push(`element id #${id} is referenced by JS but missing from the markup`);
  }

  // 2. no CDN script tags left (PeerJS is inlined)
  if (/<script src=/.test(head + body)) {
    const srcs = [...(head + body).matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    srcs.forEach((s) => problems.push(`external script tag still present: ${s}`));
  }

  // 3. PeerJS must actually be inlined
  if (!/window\.Peer\s*=/.test(read(path.join(SRC, 'vendor.js')))) {
    problems.push('src/vendor.js does not define window.Peer — run `node build-vendor.js`');
  }

  // 4. no accidental localhost or debug leftovers
  if (/localhost|127\.0\.0\.1/.test(head + body + css)) {
    problems.push('the markup or styles reference localhost');
  }

  // 5. every module parses
  for (const f of SCRIPTS) {
    const code = read(path.join(SRC, f));
    try { new Function(code); }
    catch (e) { problems.push(`${f} does not parse: ${e.message}`); }
  }

  if (problems.length) {
    console.error('❌ build failed:');
    [...new Set(problems)].forEach((p) => console.error('   - ' + p));
    process.exit(1);
  }

  /* ---------------- write ---------------- */

  fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, 'game.html');
  fs.writeFileSync(out, html, 'utf8');

  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log(`✅ dist/game.html  (${kb} KB — ${SCRIPTS.length} modules inlined, no CDN needed)`);

  // GitHub Pages serves index.html at the site root. Publishing an identical
  // copy there means the game works both from / and from /dist/game.html, and
  // the whole project can simply be dragged into GitHub.
  if (process.argv.includes('--pages') || process.argv.includes('--all')) {
    fs.writeFileSync(path.join(ROOT, 'index.html'), html, 'utf8');
    console.log('✅ index.html      (copy of the game for GitHub Pages)');
    const nojekyll = path.join(ROOT, '.nojekyll');
    if (!fs.existsSync(nojekyll)) fs.writeFileSync(nojekyll, '', 'utf8');
    console.log('✅ .nojekyll       (tells GitHub Pages to serve files as-is)');
  }

  if (process.argv.includes('--dev')) {
    const dev = head + css + '\n' + body +
      `<script src="${CDN_FALLBACK}"></script>\n` +
      TESTABLE.map((f) => `<script src="../src/${f}"></script>`).join('\n') +
      '\n</body>\n</html>\n';
    fs.writeFileSync(path.join(DIST, 'dev.html'), dev, 'utf8');
    console.log('✅ dist/dev.html   (loads ../src/*.js — needs a local http server)');
  }
}

build();
