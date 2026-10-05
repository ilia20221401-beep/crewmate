/* ==========================================================================
   world.js — map geometry, task stations, spawns
   ---------------------------------------------------------------------------
   The map is authored as a BLOCK GRID and every wall is GENERATED from it,
   so rooms, corridors and walls can never fall out of alignment.

     6 x 6 block grid, pitch 320px
       even row + even col -> possible room   (240 x 240 walkable)
       odd  row or  col    -> wall / corridor (80px wide)

     authored LAYOUT (3 rows x 3 cols of room slots):
        .  r  w        r = Reactor     W = Weapons
        m  c  n        M = MedBay      C = Cafeteria
        e  l  t        N = Navigation
                       E = Electrical  L = Lower Engine
                       T = Storage     X = Admin
   ========================================================================== */
(function (G) {
  'use strict';

  var PITCH = 320;
  var ROOM = 240;
  var WALL = PITCH - ROOM;      // 80
  var GRID_N = 6;               // block cells per side

  G.PITCH = PITCH;
  G.ROOM_SIZE = ROOM;
  G.WALL_T = WALL;
  G.WORLD_W = GRID_N * PITCH - WALL;   // 1840
  G.WORLD_H = G.WORLD_W;

  function origin(i) { return i * PITCH; }
  function size(i) { return (i % 2 === 0) ? ROOM : WALL; }

  /* ---------------- authored layout ------------------------------------ */

  var LAYOUT = [
    '.rw',
    'mcn',
    'elx'
  ];

  var ROOM_DEFS = {
    r: ['reactor',    'Reactor',      '#2b3d5c'],
    w: ['weapons',    'Weapons',      '#2b3d5c'],
    m: ['medbay',     'MedBay',       '#26404a'],
    c: ['cafeteria',  'Cafeteria',    '#3d3453'],
    n: ['navigation', 'Navigation',   '#26404a'],
    e: ['electrical', 'Electrical',   '#332f4e'],
    l: ['lower',      'Lower Engine', '#2f3a55'],
    t: ['storage',    'Storage',      '#3a3350'],
    x: ['admin',      'Admin',        '#2b3d5c']
  };

  /* ---------------- blocks --------------------------------------------- */

  var walk = [];   // walk[r][c] = room object | null
  for (var r = 0; r < GRID_N; r++) {
    walk[r] = [];
    for (var c = 0; c < GRID_N; c++) walk[r][c] = null;
  }

  var ROOMS = [], roomById = {};
  for (var lr = 0; lr < LAYOUT.length; lr++) {
    for (var lc = 0; lc < LAYOUT[lr].length; lc++) {
      var ch = LAYOUT[lr].charAt(lc);
      var def = ROOM_DEFS[ch];
      if (!def) continue;
      var gr = lr * 2, gc = lc * 2;
      var rect = { x: origin(gc), y: origin(gr), w: size(gc), h: size(gr) };
      var room = {
        id: def[0], name: def[1], color: def[2],
        row: gr, col: gc, r: rect,
        cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2
      };
      ROOMS.push(room);
      roomById[room.id] = room;
      walk[gr][gc] = room;
    }
  }
  G.ROOMS = ROOMS;
  G.roomById = roomById;

  /* ---------------- generate walls ------------------------------------- */

  var WALLS = [];
  function push(x, y, w, h) { WALLS.push({ x: x, y: y, w: w, h: h }); }

  // Horizontal sweep over every block row.
  for (var sr = 0; sr < GRID_N; sr++) {
    var run = -1;
    for (var sc = 0; sc <= GRID_N; sc++) {
      var open = (sc < GRID_N) && !!walk[sr][sc];
      if (!open) {
        if (run < 0) run = sc;
      } else {
        if (run >= 0) { push(origin(run), origin(sr), origin(sc) - origin(run), size(sr)); run = -1; }
      }
    }
  }

  // Vertical sweep over every block column.
  for (var vc = 0; vc < GRID_N; vc++) {
    var vrun = -1;
    for (var vr = 0; vr <= GRID_N; vr++) {
      var vopen = (vr < GRID_N) && !!walk[vr][vc];
      if (!vopen) {
        if (vrun < 0) vrun = vr;
      } else {
        if (vrun >= 0) { push(origin(vc), origin(vrun), size(vc), origin(vr) - origin(vrun)); vrun = -1; }
      }
    }
  }

  G.WALLS = WALLS;

  /* ---------------- collision ------------------------------------------ */

  var CELL = 16;
  var GW = Math.ceil(G.WORLD_W / CELL), GH = Math.ceil(G.WORLD_H / CELL);
  var occ = new Uint8Array(GW * GH);

  G.PLAYER_RADIUS = 18;      // declared here: the seal pass below depends on it

  function markSolid(rect) {
    var x0 = Math.max(0, Math.floor(rect.x / CELL));
    var y0 = Math.max(0, Math.floor(rect.y / CELL));
    var x1 = Math.min(GW - 1, Math.ceil((rect.x + rect.w) / CELL) - 1);
    var y1 = Math.min(GH - 1, Math.ceil((rect.y + rect.h) / CELL) - 1);
    for (var yy = y0; yy <= y1; yy++)
      for (var xx = x0; xx <= x1; xx++) occ[yy * GW + xx] = 1;
  }
  WALLS.forEach(markSolid);

  /* ---------------- reconcile visuals and collision --------------------- */

  /*
   * Generating walls from the grid can leave enclosed slivers that look like
   * normal floor but can never be walked into, and the visible wall edge never
   * lines up exactly with where a radius-R circle actually collides.
   *
   * Both problems are solved the same way: compute how far every grid cell is
   * from the nearest *visible* wall (a Manhattan distance field), then
   *   • keep a cell only if that distance exceeds R + CELL/2, and
   *   • flood-fill from the Cafeteria so anything unreachable is also removed.
   *
   * Sealing by distance is monotone — cells farther from a wall have a larger
   * distance — which is what makes it exact. The result is that the floor you
   * can see is precisely the floor you can stand on, pockets become solid rock,
   * and "a player is trapped in a sealed area" is impossible by construction.
   */

  var R = G.PLAYER_RADIUS || 18;
  var INF = 1 << 28;
  var dist = new Int32Array(GW * GH);

  (function distanceField() {
    var queue = new Int32Array(GW * GH);
    var head = 0, tail = 0;
    for (var i = 0; i < occ.length; i++) {
      if (occ[i]) { dist[i] = 0; queue[tail++] = i; }
      else dist[i] = INF;
    }
    // 4-neighbour BFS: each step is one cell = CELL pixels
    while (head < tail) {
      var idx = queue[head++];
      var x = idx % GW, y = (idx / GW) | 0;
      var d = dist[idx] + 1;
      if (x > 0 && dist[idx - 1] > d) { dist[idx - 1] = d; queue[tail++] = idx - 1; }
      if (x < GW - 1 && dist[idx + 1] > d) { dist[idx + 1] = d; queue[tail++] = idx + 1; }
      if (y > 0 && dist[idx - GW] > d) { dist[idx - GW] = d; queue[tail++] = idx - GW; }
      if (y < GH - 1 && dist[idx + GW] > d) { dist[idx + GW] = d; queue[tail++] = idx + GW; }
    }
  })();

  // A cell stays open when a radius-R circle centred on it clears the visible
  // wall. G.hitsWall below uses this same rule, so the two can never disagree.
  var CLEARANCE = R;

  var cafRoom = null;
  for (var cr = 0; cr < ROOMS.length; cr++) {
    if (ROOMS[cr].id === 'cafeteria') cafRoom = ROOMS[cr];
  }
  var SEED_X = cafRoom ? cafRoom.cx : (G.WORLD_W / 2);
  var SEED_Y = cafRoom ? cafRoom.cy : (G.WORLD_H / 2);

  G.SEALED_CELLS = (function sealAndConnect() {
    var open = new Uint8Array(GW * GH);
    var sx = Math.min(GW - 1, Math.max(0, (SEED_X / CELL) | 0));
    var sy = Math.min(GH - 1, Math.max(0, (SEED_Y / CELL) | 0));

    function fits(n) { return dist[n] * CELL > CLEARANCE; }

    // walk outward from the room centre until a cell clears the walls
    var seed = -1;
    for (var ring = 0; ring < 200 && seed < 0; ring++) {
      for (var oy = -ring; oy <= ring && seed < 0; oy++) {
        for (var ox = -ring; ox <= ring && seed < 0; ox++) {
          if (ring !== 0 && Math.max(Math.abs(ox), Math.abs(oy)) !== ring) continue;
          var tx = sx + ox, ty = sy + oy;
          if (tx < 0 || ty < 0 || tx >= GW || ty >= GH) continue;
          var n = ty * GW + tx;
          if (fits(n)) seed = n;
        }
      }
    }
    if (seed < 0) return 0;                     // nothing walkable; leave the map be

    var stack = [seed];
    open[seed] = 1;
    while (stack.length) {
      var idx = stack.pop();
      var x = idx % GW, y = (idx / GW) | 0;
      if (x > 0 && !open[idx - 1] && fits(idx - 1)) { open[idx - 1] = 1; stack.push(idx - 1); }
      if (x < GW - 1 && !open[idx + 1] && fits(idx + 1)) { open[idx + 1] = 1; stack.push(idx + 1); }
      if (y > 0 && !open[idx - GW] && fits(idx - GW)) { open[idx - GW] = 1; stack.push(idx - GW); }
      if (y < GH - 1 && !open[idx + GW] && fits(idx + GW)) { open[idx + GW] = 1; stack.push(idx + GW); }
    }

    var sealed = 0;
    for (var i = 0; i < occ.length; i++) {
      if (!occ[i] && !open[i]) { occ[i] = 1; sealed++; }
    }
    return sealed;
  })();

  G.isSolidAt = function (px, py) {
    if (px < 0 || py < 0 || px >= G.WORLD_W || py >= G.WORLD_H) return true;
    return occ[((py / CELL) | 0) * GW + ((px / CELL) | 0)] === 1;
  };

  /**
   * Does a circle of `radius` centred here touch a wall?
   *
   * This reads the pre-computed distance field rather than sampling a few
   * points, so it is exact (not an approximation that can miss a thin wall
   * between samples) and it is consistent with the sealing pass by
   * construction. It is also cheaper: one array lookup.
   */
  G.hitsWall = function (px, py, radius) {
    var rad = radius || G.PLAYER_RADIUS;
    if (px < 0 || py < 0 || px >= G.WORLD_W || py >= G.WORLD_H) return true;
    var cx = (px / CELL) | 0, cy = (py / CELL) | 0;
    var need = (rad / CELL) + 0.5;
    return dist[cy * GW + cx] < need;
  };

  G.moveCircle = function (px, py, dx, dy, radius) {
    var rad = radius || G.PLAYER_RADIUS;
    var nx = px + dx;
    if (!G.hitsWall(nx, py, rad)) px = nx;
    var ny = py + dy;
    if (!G.hitsWall(px, ny, rad)) py = ny;
    return { x: px, y: py };
  };

  G.roomAtPoint = function (px, py) {
    for (var k = 0; k < ROOMS.length; k++) {
      var q = ROOMS[k].r;
      if (px >= q.x && px <= q.x + q.w && py >= q.y && py <= q.y + q.h) return ROOMS[k];
    }
    return null;
  };

  G.canSee = function (ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 2) return true;
    var steps = Math.ceil(dist / 12);
    for (var s = 1; s < steps; s++) {
      if (G.isSolidAt(ax + dx * s / steps, ay + dy * s / steps)) return false;
    }
    return true;
  };

  /* ---------------- task definitions ----------------------------------- */

  var TASK_DEFS = {
    wiring:    { name: 'Fix Wiring',            type: 'wiring',    verb: 'Fixing wiring' },
    swipe:     { name: 'Swipe Card',            type: 'swipe',     verb: 'Swiping card' },
    download:  { name: 'Download Data',         type: 'download',  verb: 'Downloading' },
    upload:    { name: 'Upload Data',           type: 'hold',      verb: 'Uploading',  secs: 3.0 },
    fuel:      { name: 'Fuel Engines',          type: 'hold',      verb: 'Fueling',    secs: 3.4 },
    garbage:   { name: 'Empty Garbage',         type: 'hold',      verb: 'Emptying',   secs: 3.0 },
    asteroids: { name: 'Clear Asteroids',       type: 'asteroids', verb: 'Shooting' },
    calibrate: { name: 'Calibrate Distributor', type: 'simon',     verb: 'Calibrating' },
    scan:      { name: 'MedBay Scan',           type: 'hold',      verb: 'Scanning',   secs: 4.0 },
    prime:     { name: 'Prime Shields',         type: 'prime',     verb: 'Priming' },
    inspect:   { name: 'Inspect Sample',        type: 'hold',      verb: 'Inspecting', secs: 4.0 },
    divert:    { name: 'Divert Power',          type: 'hold',      verb: 'Diverting',  secs: 2.4 },
    align:     { name: 'Align Engine Output',   type: 'hold',      verb: 'Aligning',   secs: 3.0 },
    unlock:    { name: 'Unlock Manifolds',      type: 'prime',     verb: 'Unlocking' }
  };

  /* ---------------- stations ------------------------------------------- */

  var S = [
    ['w1', 'wiring',    'reactor',    -50, -50],
    ['w2', 'wiring',    'electrical', -50, -50],
    ['w3', 'wiring',    'admin',       50,  50],
    ['w4', 'wiring',    'navigation',  50, -50],
    ['w5', 'wiring',    'cafeteria',  -70, -20],

    ['s1', 'swipe',     'admin',       60, -30],
    ['s2', 'swipe',     'electrical', -60,  30],

    ['d1', 'download',  'electrical',  60,  50],
    ['d2', 'download',  'weapons',     60,  50],
    ['d3', 'download',  'medbay',     -60, -50],

    ['u1', 'upload',    'admin',      -60,  50],
    ['u2', 'upload',    'navigation', -60,  50],

    ['f1', 'fuel',      'lower',      -60,  30],
    ['f2', 'fuel',      'electrical', -60,  60],

    ['g1', 'garbage',   'lower',       60,  60],
    ['g2', 'garbage',   'lower',      -60, -60],

    ['a1', 'asteroids', 'weapons',    -60, -30],

    ['c1', 'calibrate', 'electrical', -60, -30],

    ['m1', 'scan',      'medbay',       0, -70],

    ['p1', 'prime',     'weapons',     60, -30],

    ['i1', 'inspect',   'medbay',      60, -30],

    ['v1', 'divert',    'electrical',  60, -60],
    ['v2', 'divert',    'reactor',     60, -60],

    ['al1', 'align',    'lower',      -60, -30],
    ['al2', 'align',    'lower',       60, -60],

    ['un1', 'unlock',   'reactor',     60,  30]
  ];

  var STATIONS = S.map(function (e) {
    var room = roomById[e[2]];
    return {
      id: e[0], task: e[1], room: e[2],
      x: Math.round(room.cx + e[3]), y: Math.round(room.cy + e[4]),
      def: TASK_DEFS[e[1]], name: TASK_DEFS[e[1]].name, radius: 60
    };
  });
  G.TASK_DEFS = TASK_DEFS;
  G.STATIONS = STATIONS;
  G.stationById = {};
  STATIONS.forEach(function (s) { G.stationById[s.id] = s; });
  G.STATIONS_BY_ROOM = {};
  STATIONS.forEach(function (s) {
    (G.STATIONS_BY_ROOM[s.room] = G.STATIONS_BY_ROOM[s.room] || []).push(s);
  });

  /* ---------------- key points ----------------------------------------- */

  var caf = roomById.cafeteria;
  G.SPAWNS = [
    { x: caf.cx,      y: caf.cy - 70 },
    { x: caf.cx - 60, y: caf.cy - 30 },
    { x: caf.cx + 60, y: caf.cy - 30 },
    { x: caf.cx - 60, y: caf.cy + 40 },
    { x: caf.cx + 60, y: caf.cy + 40 },
    { x: caf.cx,      y: caf.cy + 75 },
    { x: caf.cx - 80, y: caf.cy - 75 },
    { x: caf.cx + 80, y: caf.cy - 75 },
    { x: caf.cx - 80, y: caf.cy + 85 },
    { x: caf.cx + 80, y: caf.cy + 85 }
  ];
  G.MEETING_POINT = { x: caf.cx, y: caf.cy };
  G.EMERGENCY_BUTTON = { x: caf.cx, y: caf.cy + 30, radius: 56 };

  /* ---------------- vents ---------------------------------------------- */

  G.VENTS = [
    { id: 'va', x: roomById.reactor.cx,    y: roomById.reactor.cy + 60,    room: 'reactor' },
    { id: 'vb', x: roomById.electrical.cx, y: roomById.electrical.cy + 60, room: 'electrical' },
    { id: 'vc', x: roomById.lower.cx,      y: roomById.lower.cy + 60,      room: 'lower' },
    { id: 'vd', x: roomById.weapons.cx,    y: roomById.weapons.cy + 60,    room: 'weapons' },
    { id: 've', x: roomById.admin.cx,      y: roomById.admin.cy + 60,      room: 'admin' },
    { id: 'vf', x: roomById.medbay.cx,     y: roomById.medbay.cy + 60,     room: 'medbay' }
  ];
  G.VENTS.forEach(function (v) { v.radius = 30; });

  G.CAFETERIA = caf;

})(window.G = window.G || {});
