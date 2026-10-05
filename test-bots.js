/* ==========================================================================
   test-bots.js — a shared pathfinding bot for the tests that play full matches.
   ---------------------------------------------------------------------------
   The game itself has no pathfinder: a human does the steering. These bots give
   the tests something that can actually navigate the ship, so a match failing to
   end means a real game problem rather than a stupid bot.

     const bots = createBots(G);
     bots.steer(player, x, y, speed)   // one step, using the game's collision
     bots.reach(player, x, y, slack)   // is the player close enough?
   ========================================================================== */
'use strict';

function createBots(G, opts) {
  opts = opts || {};
  const STEP = opts.cell || 16;
  const PW = Math.ceil(G.WORLD_W / STEP);
  const PH = Math.ceil(G.WORLD_H / STEP);
  const R = G.PLAYER_RADIUS;

  // precomputed: can a player stand in this cell?
  const walkable = new Uint8Array(PW * PH);
  for (let x = 0; x < PW; x++) {
    for (let y = 0; y < PH; y++) {
      walkable[y * PW + x] = G.hitsWall(x * STEP + STEP / 2, y * STEP + STEP / 2, R) ? 0 : 1;
    }
  }

  function nearestWalkable(px, py) {
    const cx = Math.min(PW - 1, Math.max(0, Math.floor(px / STEP)));
    const cy = Math.min(PH - 1, Math.max(0, Math.floor(py / STEP)));
    for (let ring = 0; ring < 60; ring++) {
      for (let oy = -ring; oy <= ring; oy++) {
        for (let ox = -ring; ox <= ring; ox++) {
          if (ring !== 0 && Math.max(Math.abs(ox), Math.abs(oy)) !== ring) continue;
          const x = cx + ox, y = cy + oy;
          if (x < 0 || y < 0 || x >= PW || y >= PH) continue;
          const i = y * PW + x;
          if (walkable[i]) return { cx: x, cy: y, i };
        }
      }
    }
    return null;
  }

  const cameFrom = new Int32Array(PW * PH);
  const visitStamp = new Int32Array(PW * PH);
  const queue = new Int32Array(PW * PH);
  let stamp = 0;

  /** The next cell to walk to on the way from A to B, or null if unreachable. */
  function nextWaypoint(fromX, fromY, toX, toY) {
    const a = nearestWalkable(fromX, fromY);
    const b = nearestWalkable(toX, toY);
    if (!a || !b) return null;
    if (a.i === b.i) return { x: toX, y: toY };

    stamp++;
    let head = 0, tail = 0;
    queue[tail++] = a.i;
    visitStamp[a.i] = stamp;

    while (head < tail) {
      const cur = queue[head++];
      if (cur === b.i) break;
      const cx = cur % PW, cy = (cur / PW) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= PW || ny >= PH) continue;
        const n = ny * PW + nx;
        if (!walkable[n] || visitStamp[n] === stamp) continue;
        visitStamp[n] = stamp;
        cameFrom[n] = cur;
        queue[tail++] = n;
      }
    }
    if (visitStamp[b.i] !== stamp) return null;

    let node = b.i;
    let last = b.i;
    let hops = 0;
    while (node !== a.i && hops++ < 6000) {
      last = node;
      node = cameFrom[node];
    }
    return { x: (last % PW) * STEP + STEP / 2, y: (((last / PW) | 0)) * STEP + STEP / 2 };
  }

  /**
   * Move a player one step toward (tx, ty) using the game's own collision code,
   * so a bot can never end up somewhere a real player could not.
   * Returns true when it actually moved.
   */
  function steer(p, tx, ty, speed) {
    const wp = nextWaypoint(p.x, p.y, tx, ty);
    let goalX = tx, goalY = ty;
    if (wp) { goalX = wp.x; goalY = wp.y; }
    else {
      // unreachable by the grid: drift straight at it so the test cannot stall
      goalX = tx; goalY = ty;
    }
    const dx = goalX - p.x, dy = goalY - p.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.5) return false;
    const r = G.moveCircle(p.x, p.y, (dx / d) * speed, (dy / d) * speed, R);
    const moved = Math.abs(r.x - p.x) > 0.05 || Math.abs(r.y - p.y) > 0.05;
    p.x = r.x; p.y = r.y;
    return moved;
  }

  /** Is the player within `slack` of the point? */
  function reach(p, tx, ty, slack) {
    const s = slack === undefined ? G.consts.USE_RANGE - 10 : slack;
    return G.dist(p.x, p.y, tx, ty) <= s;
  }

  return {
    steer, reach, nextWaypoint, nearestWalkable,
    walkable, STEP, PW, PH,
    openCells: walkable.reduce((n, v) => n + v, 0)
  };
}

module.exports = { createBots };
