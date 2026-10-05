/* ==========================================================================
   pack.js — assembles release/Crewmate/, the exact folder to upload to GitHub.
     node pack.js
   ========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'release', 'Crewmate');

function rmrf(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (fs.statSync(p).isDirectory()) rmrf(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    if (fs.statSync(s).isDirectory()) {
      if (entry === 'node_modules') continue;
      copyDir(s, d, filter);
    } else {
      if (filter && !filter(entry, s)) continue;
      fs.copyFileSync(s, d);
    }
  }
}

fs.mkdirSync(path.join(ROOT, 'release'), { recursive: true });
rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

// 1. the game itself, as index.html so GitHub Pages serves it at the root
if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('index.html not found — run `node build.js --pages` first.');
  process.exit(1);
}
copy(path.join(ROOT, 'index.html'), path.join(OUT, 'index.html'));
copy(path.join(ROOT, 'dist', 'game.html'), path.join(OUT, 'game.html'));
copy(path.join(ROOT, '.nojekyll'), path.join(OUT, '.nojekyll'));
copy(path.join(ROOT, 'README.md'), path.join(OUT, 'README.md'));
copy(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE'));
copy(path.join(ROOT, 'package.json'), path.join(OUT, 'package.json'));

// 2. the sources, so the project is readable and modifiable
copyDir(path.join(ROOT, 'src'), path.join(OUT, 'src'), (name) => name !== 'vendor.js');
copyDir(path.join(ROOT, 'dist'), path.join(OUT, 'dist'));
copyDir(path.join(ROOT, 'vendor'), path.join(OUT, 'vendor'));

// 3. the tooling
['build.js', 'build-vendor.js', 'serve.js', 'pack.js', 'zip.js', 'probe-net.js', 'validate-map.js',
  'test-game.js', 'test-runtime.js', 'test-html.js', 'test-mobile.js', 'test-deploy.js', 'test-loopback.js', 'test-fuzz.js', 'test-stress.js', 'test-game-shim.js', 'test-bots.js']
  .forEach((f) => copy(path.join(ROOT, f), path.join(OUT, f)));

copy(path.join(ROOT, '.gitignore'), path.join(OUT, '.gitignore'));

// 4. the Pages workflow, so future pushes deploy themselves
fs.mkdirSync(path.join(OUT, '.github', 'workflows'), { recursive: true });
copy(path.join(ROOT, '.github', 'workflows', 'deploy.yml'),
  path.join(OUT, '.github', 'workflows', 'deploy.yml'));

// dist/dev.html references ../src, which we ship, so it keeps working
console.log('✅ release/Crewmate/ is ready to upload.\n');
const listing = [];
(function walk(dir, prefix) {
  for (const entry of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, entry);
    if (fs.statSync(p).isDirectory()) { listing.push(prefix + entry + '/'); walk(p, prefix + '  '); }
    else listing.push(prefix + entry + '  (' + (fs.statSync(p).size / 1024).toFixed(1) + ' KB)');
  }
})(OUT, '  ');
console.log(listing.join('\n'));
const total = (function size(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    n += fs.statSync(p).isDirectory() ? size(p) : fs.statSync(p).size;
  }
  return n;
})(OUT);
console.log('\n  total: ' + (total / 1024).toFixed(1) + ' KB');
console.log('\nUpload this folder, then enable GitHub Pages (Settings -> Pages -> main / root).');
