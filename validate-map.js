/* Validates the map using the game's own collision code:
   - no room overlaps a wall, no two rooms overlap
   - spawns / stations / vents / emergency button are walkable
   - every room, station and vent is reachable from the cafeteria
   - every room has at least one usable doorway
   Run:  node validate-map.js
*/
const fs = require('fs');
const path = require('path');

global.window = {};
eval(fs.readFileSync(path.join(__dirname, 'src', 'world.js'), 'utf8'));
const G = global.window.G;

let errors = 0, warns = 0;
const fail = (m) => { console.log('  FAIL  ' + m); errors++; };
const warn = (m) => { console.log('  warn  ' + m); warns++; };
const ok = (m) => { console.log('  ok    ' + m); };
const R = G.PLAYER_RADIUS;

console.log(`world ${G.WORLD_W} x ${G.WORLD_H} — ${G.WALLS.length} wall rects, ` +
  `${G.ROOMS.length} rooms, ${G.STATIONS.length} stations, ${G.VENTS.length} vents`);

/* 1 ── room interiors must be solid-free --------------------------------- */
console.log('\n== room interiors ==');
for (const room of G.ROOMS) {
  const q = room.r;
  let bad = 0;
  for (let y = q.y + R; y <= q.y + q.h - R; y += 8)
    for (let x = q.x + R; x <= q.x + q.w - R; x += 8)
      if (G.isSolidAt(x, y)) bad++;
  if (bad) fail(`room "${room.id}" has ${bad} solid sample points inside it`);
  const inner = q.w - 2 * R, innerH = q.h - 2 * R;
  if (inner < 80 || innerH < 80) warn(`room "${room.id}" leaves only ${inner}x${innerH} for a player`);
}

/* 2 ── room vs room overlap --------------------------------------------- */
console.log('== room overlaps ==');
for (let i = 0; i < G.ROOMS.length; i++)
  for (let j = i + 1; j < G.ROOMS.length; j++) {
    const a = G.ROOMS[i].r, b = G.ROOMS[j].r;
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
      fail(`"${G.ROOMS[i].id}" overlaps "${G.ROOMS[j].id}"`);
  }

/* 3 ── walls in bounds --------------------------------------------------- */
console.log('== walls in bounds ==');
for (const w of G.WALLS)
  if (w.x < 0 || w.y < 0 || w.x + w.w > G.WORLD_W || w.y + w.h > G.WORLD_H)
    fail(`wall out of bounds: ${JSON.stringify(w)}`);

/* 4 ── walkable anchor points ------------------------------------------- */
console.log('== anchors ==');
const anchors = [];
G.SPAWNS.forEach((s, i) => anchors.push([`spawn ${i}`, s.x, s.y]));
anchors.push(['meeting point', G.MEETING_POINT.x, G.MEETING_POINT.y]);
anchors.push(['emergency button', G.EMERGENCY_BUTTON.x, G.EMERGENCY_BUTTON.y]);
G.STATIONS.forEach(s => anchors.push([`station ${s.id} (${s.task})`, s.x, s.y]));
G.VENTS.forEach(v => anchors.push([`vent ${v.id}`, v.x, v.y]));
for (const [label, x, y] of anchors)
  if (G.hitsWall(x, y, R)) fail(`${label} at ${x},${y} is inside a wall`);

/* 5 ── station declared room matches actual room ------------------------- */
console.log('== station rooms ==');
for (const s of G.STATIONS) {
  const actual = G.roomAtPoint(s.x, s.y);
  const id = actual ? actual.id : 'CORRIDOR';
  if (id !== s.room) fail(`station ${s.id} claims "${s.room}" but sits in "${id}"`);
}

/* 6 ── connectivity BFS from the cafeteria ------------------------------ */
console.log('== connectivity ==');
const STEP = 8;
const reach = new Uint8Array(Math.ceil(G.WORLD_W / STEP) * Math.ceil(G.WORLD_H / STEP));
const W = Math.ceil(G.WORLD_W / STEP);
const idx = (x, y) => (y / STEP | 0) * W + (x / STEP | 0);
const start = G.MEETING_POINT;
if (G.hitsWall(start.x, start.y, R)) { fail('BFS start is blocked'); }
else {
  const q = [[start.x, start.y]];
  reach[idx(start.x, start.y)] = 1;
  const dirs = [[STEP, 0], [-STEP, 0], [0, STEP], [0, -STEP]];
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= G.WORLD_W || ny >= G.WORLD_H) continue;
      const k = idx(nx, ny);
      if (reach[k]) continue;
      if (G.hitsWall(nx, ny, R)) continue;
      reach[k] = 1; q.push([nx, ny]);
    }
  }
}
let reachableCount = 0;
for (let i = 0; i < reach.length; i++) if (reach[i]) reachableCount++;
console.log(`  reachable samples: ${reachableCount}`);
function reachable(x, y) {
  for (let ox = -R; ox <= R; ox += 4)
    for (let oy = -R; oy <= R; oy += 4) {
      const nx = x + ox, ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= G.WORLD_W || ny >= G.WORLD_H) continue;
      if (reach[idx(nx, ny)]) return true;
    }
  return false;
}
for (const room of G.ROOMS)
  if (!reachable(room.cx, room.cy)) fail(`room "${room.id}" is NOT reachable from the cafeteria`);
for (const s of G.STATIONS)
  if (!reachable(s.x, s.y)) fail(`station ${s.id} is NOT reachable`);
for (const v of G.VENTS)
  if (!reachable(v.x, v.y)) fail(`vent ${v.id} is NOT reachable`);

/* 6 ── collision consistency -------------------------------------------- */
/* The sealing pass guarantees that the floor you can see is exactly the floor
   you can stand on. Assert it, so a future map edit cannot silently bring back
   invisible walls or pockets a player can be trapped inside. */
console.log('== collision consistency ==');
{
  const CELL = 16;
  let openCells = 0, unstandable = 0, firstBad = null;
  for (let cx = 0; cx * CELL + CELL / 2 < G.WORLD_W; cx++) {
    for (let cy = 0; cy * CELL + CELL / 2 < G.WORLD_H; cy++) {
      const px = cx * CELL + CELL / 2, py = cy * CELL + CELL / 2;
      if (G.isSolidAt(px, py)) continue;
      openCells++;
      if (G.hitsWall(px, py, R)) {
        unstandable++;
        if (!firstBad) firstBad = px + ',' + py;
      }
    }
  }
  console.log(`  open cells: ${openCells}, sealed by the pass: ${G.SEALED_CELLS}`);
  if (unstandable) fail(`${unstandable} open cell(s) a player cannot stand on (e.g. ${firstBad})`);
  else ok('every open cell is standable — no invisible walls');

  let standable = 0, solidButStandable = 0;
  for (let x = 0; x < G.WORLD_W; x += 8) {
    for (let y = 0; y < G.WORLD_H; y += 8) {
      if (!G.hitsWall(x, y, R)) { standable++; if (G.isSolidAt(x, y)) solidButStandable++; }
    }
  }
  if (solidButStandable) fail(`${solidButStandable} standable point(s) marked solid`);
  else ok(`every standable point is walkable (${standable} sampled)`);
}

/* 7 ── doorways ---------------------------------------------------------- */
/* Measured on the collision surface, not the markup: a doorway is only usable
   if a player-sized circle can actually pass through the gap. */
console.log('== doorways (must fit a player) ==');
const MIN_GAP = R * 2 + 4;
const doors = [];
for (const room of G.ROOMS) {
  const q = room.r;
  const sides = [
    ['top', q.x, q.y - R - 4, q.w, true],
    ['bottom', q.x, q.y + q.h + R + 4, q.w, true],
    ['left', q.x - R - 4, q.y, q.h, false],
    ['right', q.x + q.w + R + 4, q.y, q.h, false]
  ];
  let usable = 0;
  for (const [name, sx, sy, len, horizontal] of sides) {
    let best = 0, run = 0;
    for (let d = 0; d < len; d += 2) {
      const x = horizontal ? sx + d : sx;
      const y = horizontal ? sy : sy + d;
      const free = !G.hitsWall(x, y, R);
      run = free ? run + 2 : 0;
      if (run > best) best = run;
    }
    if (best >= MIN_GAP) { usable++; doors.push([room.id, name, best]); }
    else if (best > 0) warn(`room "${room.id}" ${name} gap is only ${best}px (needs ${MIN_GAP}px)`);
  }
  if (!usable) fail(`room "${room.id}" has no doorway a player can walk through`);
}
for (const [room, side, w] of doors) console.log(`  ${room.padEnd(11)} ${side.padEnd(7)} ${w}px gap`);

/* 8 ── task distribution sanity ----------------------------------------- */
console.log('== task coverage ==');
const byTask = {}, byRoom = {};
for (const s of G.STATIONS) {
  byTask[s.task] = (byTask[s.task] || 0) + 1;
  byRoom[s.room] = (byRoom[s.room] || 0) + 1;
}
console.log('  per task:', Object.entries(byTask).map(([k, v]) => `${k}x${v}`).join(' '));
console.log('  per room:', Object.entries(byRoom).map(([k, v]) => `${k}x${v}`).join(' '));
for (const room of G.ROOMS)
  if (!byRoom[room.id]) warn(`room "${room.id}" contains no task stations`);

console.log(`\n${errors === 0 ? '✅ PASS' : '❌ FAIL'} — ${errors} error(s), ${warns} warning(s)`);
process.exit(errors ? 1 : 0);
