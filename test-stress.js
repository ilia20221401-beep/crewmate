/* ==========================================================================
   test-stress.js — randomized full matches driven through the real host loop.
   The bots use a breadth-first pathfinder so they actually reach their tasks,
   which is what makes this a fair test of the game rather than of the bots.

     node test-stress.js [matches]
   ========================================================================== */
const { makeShim, loadModules, makeNet } = require('./test-game-shim.js');
const { createBots } = require('./test-bots.js');

const win = makeShim();
const G = loadModules(win, ['utils.js', 'world.js', 'audio.js', 'net.js', 'tasks.js', 'game.js', 'render.js']);
const net = makeNet();
const bots = createBots(G);

const MATCHES = Number(process.argv[2] || 30);
const R = G.PLAYER_RADIUS;

/* ---------------- harness ------------------------------------------------ */

let game, clock, seq = 0;
const fails = [];

function fresh(nPlayers, impostors) {
  game = new G.Game();
  clock = 1700000000000;
  game.clock = clock;
  game.isHost = true;
  game.order = [];
  game.players = {};
  G.game = game;
  game.view.youId = 'host';
  net._crewmateGame = game;
  net._clear();
  seq++;
  G.host.init(game, net);
  const hp = G.host.makePlayer(game, 'host', 'Host', false);
  hp.host = true; game.players.host = hp; game.order.push('host');
  for (let i = 1; i < nPlayers; i++) {
    seq++;
    net._handlers.join[net._handlers.join.length - 1]({
      conn: { _playerId: 'c' + seq, open: true, send() {}, close() {}, on() {} },
      name: 'P' + i, sessionId: 's' + seq, isMobile: i % 2 === 0
    });
  }
  G.host.startGame(game, net, { impostors: impostors, speed: 1 });
  for (let i = 0; i < 60 * 6; i++) { clock += 16; game.clock = clock; G.host.tick(game, net, 1 / 60); }
  return game.order.slice();
}

const crewOf = () => game.order.filter((id) => game.players[id].role === 'crew');
const impsOf = () => game.order.filter((id) => game.players[id].role === 'imp');
const living = () => game.order.filter((id) => game.players[id].alive);

/** Walk a bot toward a target using the shared pathfinder helper. */
function steerToward(p, tx, ty, speed) {
  return bots.steer(p, tx, ty, speed);
}

let matches = 0, wins = { crew: 0, imp: 0 }, stalls = 0;
let totalKills = 0, totalTasks = 0, oob = 0, inSolid = 0, walledIn = 0;

for (let m = 0; m < MATCHES; m++) {
  const n = 4 + (m % 7);          // 4..10 players
  const imp = 1 + (m % 3);        // 1..3 impostors
  fresh(n, imp);

  const simImp = game.players[impsOf()[0]];
  const simCrew = crewOf().map((id) => game.players[id]);
  let guard = 0;

  while (game.phase !== 'ended' && guard++ < 5000) {
    for (const c of simCrew) {
      // Dead crewmates keep working as ghosts — through walls, as in the real game
      if (c.inVent) continue;
      const next = c.tasks.find((t) => !t.done);
      if (!next) continue;
      const st = G.stationById[next.id];
      if (G.dist(c.x, c.y, st.x, st.y) <= G.consts.USE_RANGE - 8) {
        G.host.doTask(game, net, c, next.id);
      } else if (c.alive) {
        steerToward(c, st.x, st.y, 3.4);
      } else {
        // a ghost flies straight there, ignoring walls
        const dx = st.x - c.x, dy = st.y - c.y, d = Math.hypot(dx, dy) || 1;
        const step = Math.min(d, 5);
        c.x += (dx / d) * step;
        c.y += (dy / d) * step;
      }
    }
    if (simImp.alive && clock >= simImp.killReadyAt) {
      const prey = simCrew.filter((c) => c.alive && c.id !== simImp.id)[0];
      if (prey) {
        const d = Math.hypot(prey.x - simImp.x, prey.y - simImp.y);
        if (d > 50) steerToward(simImp, prey.x, prey.y, 4.2);
        else G.host.tryKill(game, net, simImp);
      }
    }
    clock += 40; game.clock = clock;
    G.host.tick(game, net, 0.04);
  }

  matches++;
  totalKills += game.bodies.length;
  totalTasks += game.tasksDone;

  if (game.phase === 'ended') {
    wins[game.winner] = (wins[game.winner] || 0) + 1;
  } else {
    stalls++;
    const crewAlive = living().filter((id) => game.players[id].role === 'crew').length;
    const pending = crewOf().reduce((a, id) => a + game.players[id].tasks.filter((t) => !t.done).length, 0);
    console.log(`  [stall] #${m} n=${n} imp=${imp} livingCrew=${crewAlive} ` +
      `tasks=${game.tasksDone}/${game.tasksTotal} pending=${pending} guard=${guard}`);
    fails.push('match ' + m + ' never ended');
  }

  for (const id of living()) {
    const p = game.players[id];
    if (p.x < 0 || p.y < 0 || p.x > G.WORLD_W || p.y > G.WORLD_H) {
      oob++; fails.push('out of bounds: ' + id);
    } else if (!p.inVent && G.hitsWall(p.x, p.y, R)) {
      inSolid++;
      fails.push('inside a wall: ' + id + ' at ' + p.x.toFixed(1) + ',' + p.y.toFixed(1));
    }
    let moves = 0;
    for (let a = 0; a < 12; a++) {
      const ang = a * Math.PI / 6;
      const r = G.moveCircle(p.x, p.y, Math.cos(ang) * 2, Math.sin(ang) * 2, R);
      if (Math.abs(r.x - p.x) > 0.4 || Math.abs(r.y - p.y) > 0.4) moves++;
    }
    if (moves === 0) { walledIn++; fails.push('walled in: ' + id); }
  }
}

console.log('\nmatches simulated   :', matches);
console.log('winners             : crew ' + (wins.crew || 0) + ' / impostors ' + (wins.imp || 0));
console.log('stalled matches     :', stalls);
console.log('bodies created      :', totalKills);
console.log('tasks completed     :', totalTasks);
console.log('out of bounds       :', oob);
console.log('inside a wall       :', inSolid);
console.log('walled in           :', walledIn);

if (fails.length) {
  console.log('\nfailures:');
  [...new Set(fails)].slice(0, 12).forEach((f) => console.log('  • ' + f));
  process.exit(1);
}
console.log('\n✅ every match resolved, no wall clipping, no stuck players');
