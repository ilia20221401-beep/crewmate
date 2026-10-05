/* ==========================================================================
   zip.js — builds release/Crewmate.zip with Node's own zlib.
   ---------------------------------------------------------------------------
   No external archiver is used (or needed), because a sandboxed machine often
   has neither Compress-Archive nor tar available. This writes the ZIP container
   by hand: local file headers, a central directory and the end record.

     node zip.js
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'release', 'Crewmate');
const OUT = path.join(ROOT, 'release', 'Crewmate.zip');

if (!fs.existsSync(SRC)) {
  console.error('release/Crewmate not found — run `node pack.js` first.');
  process.exit(1);
}

/* ---------------- collect files ----------------------------------------- */

const entries = [];
(function walk(dir, rel) {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const relPath = rel ? rel + '/' + name : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, relPath);
    else entries.push({ abs, name: relPath, size: st.size, mtime: st.mtime });
  }
})(SRC, '');

/* ---------------- crc32 -------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---------------- dos date/time ----------------------------------------- */

function dosTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xFFFF;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  return { time, date };
}

/* ---------------- build -------------------------------------------------- */

const locals = [];
const central = [];
let offset = 0;

for (const e of entries) {
  const raw = fs.readFileSync(e.abs);
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  // only use deflate when it actually helps
  const useDeflate = deflated.length < raw.length;
  const data = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;

  const nameBuf = Buffer.from(e.name, 'utf8');
  const crc = crc32(raw);
  const { time, date } = dosTime(e.mtime);

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);      // local file header signature
  local.writeUInt16LE(20, 4);              // version needed
  local.writeUInt16LE(0x0800, 6);          // flags: UTF-8 names
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);    // compressed size
  local.writeUInt32LE(raw.length, 22);     // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);              // extra field length
  nameBuf.copy(local, 30);

  locals.push(local, data);

  const cen = Buffer.alloc(46 + nameBuf.length);
  cen.writeUInt32LE(0x02014b50, 0);        // central directory signature
  cen.writeUInt16LE(20, 4);                // version made by
  cen.writeUInt16LE(20, 6);                // version needed
  cen.writeUInt16LE(0x0800, 8);            // flags
  cen.writeUInt16LE(method, 10);
  cen.writeUInt16LE(time, 12);
  cen.writeUInt16LE(date, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(raw.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt16LE(0, 30);                // extra
  cen.writeUInt16LE(0, 32);                // comment
  cen.writeUInt16LE(0, 34);                // disk number
  cen.writeUInt16LE(0, 36);                // internal attrs
  cen.writeUInt32LE(0, 38);                // external attrs
  cen.writeUInt32LE(offset, 42);           // offset of local header
  nameBuf.copy(cen, 46);
  central.push(cen);

  offset += local.length + data.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);          // end of central directory
end.writeUInt16LE(0, 4);                   // this disk
end.writeUInt16LE(0, 6);                   // disk with central dir
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);                  // comment length

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([...locals, centralBuf, end]));

const rawTotal = entries.reduce((n, e) => n + e.size, 0);
const zipSize = fs.statSync(OUT).size;
console.log('✅ release/Crewmate.zip');
console.log(`   ${(zipSize / 1024).toFixed(1)} KB compressed · ${entries.length} files · ` +
  `${(rawTotal / 1024).toFixed(1)} KB raw · ${(100 * zipSize / rawTotal).toFixed(0)}%`);
console.log('');
console.log('Extract it and drag the contents into GitHub, or upload straight from');
console.log('the release/Crewmate folder — the files are identical.');
