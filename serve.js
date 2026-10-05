/* ==========================================================================
   serve.js — zero-dependency static server for local testing.
     node serve.js [port]
   Serves the project root, so:
     http://127.0.0.1:8899/dist/game.html     the built single file
     http://127.0.0.1:8899/dist/dev.html      modules loaded separately
     http://127.0.0.1:8899/                  a small index of useful links
   ========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || 8899);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

const INDEX = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Crewmate — local preview</title>
<style>
 body{font:16px/1.6 system-ui,"Segoe UI",sans-serif;background:#0b0f1a;color:#e8eefc;padding:40px;max-width:720px;margin:auto}
 a{color:#4fd1c5;display:block;padding:12px 16px;border:1px solid #2a3a5c;border-radius:10px;margin:10px 0;text-decoration:none}
 a:hover{background:#141d33}
 code{background:#141d33;padding:2px 6px;border-radius:5px}
 .note{color:#93a4c4;font-size:14px}
</style></head><body>
<h1>Crewmate — local preview</h1>
<a href="/dist/game.html"><b>dist/game.html</b> — the single-file game (use this one)</a>
<a href="/dist/dev.html"><b>dist/dev.html</b> — same game, separate module files (debugging)</a>
<p class="note">Open <b>game.html</b> on this computer, tap <b>Host a game</b>, then open the same URL
on your phone, tap <b>Join a game</b> and enter the 4-digit room code.</p>
<p class="note">Both devices must be on the same Wi-Fi for this local test. Once deployed to
GitHub Pages, they can be anywhere.</p>
</body></html>`;

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(INDEX);
    return;
  }
  const filePath = path.join(ROOT, urlPath);
  // stay inside the project directory
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + urlPath);
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Crewmate preview server running:');
  console.log('  game  http://127.0.0.1:' + PORT + '/dist/game.html');
  console.log('  dev   http://127.0.0.1:' + PORT + '/dist/dev.html');
  console.log('  index http://127.0.0.1:' + PORT + '/');
  console.log('\nPress Ctrl+C to stop.');
});
