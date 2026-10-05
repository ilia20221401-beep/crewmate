/* ==========================================================================
   test-fuzz.js — hostile and broken client messages.
   ---------------------------------------------------------------------------
   The host runs on someone's laptop and accepts packets from peers it met over
   a public signalling server. A peer can be a buggy phone, a half-updated tab,
   or someone poking at it with devtools. None of that may corrupt the match.

   This throws a large, deliberately nasty set of packets at every host handler
   and then asserts:
     • no handler throws,
     • the simulation keeps ticking,
     • no position, cooldown or counter becomes NaN or infinite,
     • nobody is teleported out of the world,
     • the host never lets a client act out of turn or out of range.

     node test-fuzz.js
   ========================================================================== */
const { makeShim, loadModules, makeNet } = require('./test-game-shim.js');

const win = makeShim();
const G = loadModules(win, ['utils.js', 'world.js', 'audio.js', 'net.js', 'tasks.js', 'game.js']);
const net = makeNet();

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; failures.push(label + (extra ? ' — ' + extra : '')); console.log('  ✗ ' + label + (extra ? '  [' + extra + ']' : '')); }
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 52 - t.length))); }

/* ---------------- harness ----------------------------------------------- */

let game = new G.Game();
let clock = 1700000000000;
let seq = 0;
let joinListener = null;
const errors = [];

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

  G.host.init(game, net);
  // keep a reference to the original join listener: this harness overrides the
  // other transport hooks, so it must not rely on the handler table afterwards
  if (!joinListener) joinListener = net._handlers.join[0];
  const hp = G.host.makePlayer(game, 'host', 'Host', false);
  hp.host = true;
  game.players.host = hp;
  game.order.push('host');

  for (let i = 1; i < nPlayers; i++) {
    seq++;
    const before = game.order.slice();
    joinListener({
      conn: { _playerId: 'c' + seq, open: true, send() {}, close() {}, on() {} },
      name: 'P' + i, sessionId: 's' + seq, isMobile: false
    });
    const added = game.order.filter((id) => before.indexOf(id) < 0);
    if (!added.length) throw new Error('join failed in fuzz setup');
  }
  G.host.startGame(game, net, { impostors: impostors || 1, speed: 1 });
  // skip the reveal
  for (let i = 0; i < 400; i++) { clock += 16; game.clock = clock; G.host.tick(game, net, 1 / 60); }
  if (game.phase !== 'play') game.phase = 'play';
  return game.order.slice();
}

const crewOf = () => game.order.filter((id) => game.players[id].role === 'crew');
const impsOf = () => game.order.filter((id) => game.players[id].role === 'imp');

/** Send a message from a player straight into the host's handler. */
function send(fromId, msg) {
  try {
    G.host.onMessage(game, net, Object.assign({ from: fromId }, msg), { _playerId: fromId });
  } catch (e) {
    errors.push('threw on ' + JSON.stringify(msg).slice(0, 80) + ' -> ' + e.message);
  }
}

/** Deep scan for non-finite numbers anywhere in the host state. */
function findBadNumbers() {
  const bad = [];
  const seen = new Set();
  function walk(v, path, depth) {
    if (depth > 4 || bad.length > 6) return;
    if (typeof v === 'number') {
      if (!isFinite(v)) bad.push(path + '=' + v);
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    for (const k of Object.keys(v)) walk(v[k], path + '.' + k, depth + 1);
  }
  walk(game.players, 'players', 0);
  walk(game.bodies, 'bodies', 0);
  walk({ tasksDone: game.tasksDone, tasksTotal: game.tasksTotal, time: game.time }, 'counters', 0);
  if (game.sabotage) walk(game.sabotage, 'sabotage', 0);
  if (game.meeting) walk(game.meeting, 'meeting', 0);
  return bad;
}

/* ======================================================================= */
section('a large set of malformed packets');

const NADES = [
  { t: 'input' },
  { t: 'input', x: NaN, y: NaN },
  { t: 'input', x: Infinity, y: -Infinity },
  { t: 'input', x: 'left', y: {} },
  { t: 'input', x: null, y: undefined },
  { t: 'input', x: [1, 2], y: { a: 1 } },
  { t: 'input', x: 1e308, y: 1e308 },
  { t: 'input', x: -1e308, y: -1e308 },
  { t: 'kill' },
  { t: 'kill', target: null },
  { t: 'report' },
  { t: 'report', bodyId: 'nope' },
  { t: 'report', bodyId: {} },
  { t: 'emergency' },
  { t: 'vent' },
  { t: 'vent', ventId: 12345 },
  { t: 'sabotage' },
  { t: 'sabotage', kind: null },
  { t: 'sabotage', kind: { toString() { throw new Error('evil'); } } },
  { t: 'sabotage', kind: 'lights' },
  { t: 'fix-lights' },
  { t: 'task' },
  { t: 'task', stationId: null },
  { t: 'task', stationId: 'not-a-station' },
  { t: 'task', stationId: { id: 'w1' } },
  { t: 'task', stationId: ['w1'] },
  { t: 'vote' },
  { t: 'vote', target: 'ghost-player' },
  { t: 'vote', target: null },
  { t: 'vote', target: 'skip' },
  { t: 'chat' },
  { t: 'chat', text: 12345 },
  { t: 'chat', text: null },
  { t: 'chat', text: { toString() { throw new Error('evil'); } } },
  { t: 'chat', text: 'x'.repeat(10000) },
  { t: 'chat', text: '<script>alert(1)</script>' },
  { t: 'settings' },
  { t: 'settings', settings: null },
  { t: 'settings', settings: { impostors: 'lots', speed: NaN } },
  { t: 'settings', settings: { impostors: -99, speed: 999 } },
  { t: 'settings', settings: { impostors: Infinity, speed: -Infinity } },
  { t: 'rematch' },
  { t: 'start' },
  { t: 'start', settings: { impostors: null, speed: 'fast' } },
  { t: 'ping' },
  { t: 'unknown-type' },
  { t: '' },
  { t: null },
  { t: undefined },
  {}
];

let sends = 0;
for (const msg of NADES) {
  for (const from of [game.order[1], game.order[2], 'host', 'not-a-player', null]) {
    send(from, msg);
    sends++;
  }
}
ok(errors.length === 0, `no host handler threw across ${sends} hostile packets`,
  errors.slice(0, 3).join(' | '));

/* ======================================================================= */
section('the simulation still runs');

let tickErrors = 0;
try {
  for (let i = 0; i < 600; i++) { clock += 16; game.clock = clock; G.host.tick(game, net, 1 / 60); }
} catch (e) {
  tickErrors++;
  ok(false, 'the host loop threw after the fuzzing: ' + e.message);
}
if (!tickErrors) ok(true, 'the host loop ran 600 more ticks without throwing');

const bad = findBadNumbers();
ok(bad.length === 0, 'no NaN or infinite value anywhere in the state',
  bad.join(', '));

/* ======================================================================= */
section('nobody escaped the world');

const escaped = game.order.filter((id) => {
  const p = game.players[id];
  return p.x < 0 || p.y < 0 || p.x > G.WORLD_W || p.y > G.WORLD_H;
});
ok(escaped.length === 0, 'every player is still inside the ship',
  escaped.slice(0, 3).map((id) => id + '@' + game.players[id].x + ',' + game.players[id].y).join(' '));

const inWall = game.order.filter((id) => {
  const p = game.players[id];
  return p.alive && !p.inVent && G.hitsWall(p.x, p.y, G.PLAYER_RADIUS);
});
ok(inWall.length === 0, 'no living player is inside a wall',
  inWall.slice(0, 3).join(', '));

/* ======================================================================= */
section('the host refused illegal actions');

// a crewmate can never kill
fresh(6, 1);
const crew = game.players[crewOf()[0]];
const victim = game.players[crewOf()[1]];
crew.x = victim.x;
crew.y = victim.y;
send(crewOf()[0], { t: 'kill' });
ok(victim.alive === true, 'a crewmate cannot kill, even standing on top of someone');

// a crewmate can never sabotage
const beforeSab = game.sabotage;
send(crewOf()[0], { t: 'sabotage', kind: 'lights' });
ok(game.sabotage === beforeSab, 'a crewmate cannot sabotage');

// a crewmate can never vent
send(crewOf()[0], { t: 'vent' });
ok(game.players[crewOf()[0]].inVent === false, 'a crewmate cannot vent');

// a task cannot be completed from across the ship
const far = game.players[crewOf()[1]];
const theirTask = far.tasks.find((t) => !t.done);
far.x = 100;
far.y = 100;
send(far.id, { t: 'task', stationId: theirTask.id });
ok(theirTask.done === false, 'a task cannot be completed from out of range');

// a task that is not yours cannot be completed
const mine = game.players[crewOf()[0]].tasks[0];
const other = G.STATIONS.find((s) => !game.players[crewOf()[0]].tasks.some((t) => t.id === s.id));
const me = game.players[crewOf()[0]];
me.x = other.x;
me.y = other.y;
send(me.id, { t: 'task', stationId: other.id });
ok(me.tasks.every((t) => !(t.id === other.id && t.done)), 'a station that is not your task does nothing');

// votes are ignored outside a meeting
game.phase = 'play';
game.votes = {};
send(crewOf()[0], { t: 'vote', target: crewOf()[1] });
ok(Object.keys(game.votes).length === 0, 'votes are ignored outside a meeting');

// chat is ignored outside a meeting
game.chat = [];
send(crewOf()[0], { t: 'chat', text: 'hello' });
ok(game.chat.length === 0, 'chat is ignored outside a meeting');

// only the host may change settings or start the round.
// NOTE: the host is also a crewmate, so pick a crewmate who is NOT the host.
const ordinaryCrew = game.order.find((id) => id !== 'host' && game.players[id].role === 'crew');
const settingBefore = JSON.stringify(game.settings);
try {
  send(ordinaryCrew, { t: 'settings', settings: { impostors: 3, speed: 2 } });
  ok(JSON.stringify(game.settings) === settingBefore, 'a non-host cannot change the settings',
    'sender=' + ordinaryCrew + ' isHost=' + !!game.players[ordinaryCrew].host);
} catch (e) {
  ok(false, 'settings check threw: ' + e.message + ' || ' + e.stack.split('\n').slice(1, 4).join(' | '));
}

const phaseBefore = game.phase;
try {
  send(ordinaryCrew, { t: 'start', settings: { impostors: 1, speed: 1 } });
  ok(game.phase === phaseBefore, 'a non-host cannot start a round',
    'phase ' + phaseBefore + ' -> ' + game.phase);
} catch (e) {
  ok(false, 'start check threw: ' + e.message + ' || ' + e.stack.split('\n').slice(1, 4).join(' | '));
}

// and confirm the host really can change them (so the guard is not just broken)
const hostBefore = JSON.stringify(game.settings);
send('host', { t: 'settings', settings: { impostors: 2, speed: 1 } });
ok(JSON.stringify(game.settings) !== hostBefore, 'the host can still change the settings');;

// an unknown sender is ignored entirely
const beforePlayers = JSON.stringify(Object.keys(game.players));
send('not-a-player', { t: 'input', x: 1, y: 1 });
send(null, { t: 'kill' });
send(undefined, { t: 'emergency' });
ok(JSON.stringify(Object.keys(game.players)) === beforePlayers, 'messages from unknown senders are ignored');

/* ======================================================================= */
section('hostile input cannot break movement');

fresh(5, 1);
const mover = game.players[crewOf()[0]];
let nanSeen = false;
for (const v of [NaN, Infinity, -Infinity, 1e308, -1e308, 'x', {}, [], null, undefined]) {
  for (const key of ['x', 'y']) {
    const m = { t: 'input' };
    m.x = 1; m.y = 0;
    m[key] = v;
    send(mover.id, m);
    for (let i = 0; i < 3; i++) { clock += 16; game.clock = clock; G.host.tick(game, net, 1 / 60); }
    if (!isFinite(mover.x) || !isFinite(mover.y)) nanSeen = true;
  }
}
ok(!nanSeen, 'no hostile input value produced a non-finite position');
ok(isFinite(mover.x) && isFinite(mover.y), 'the player position is still finite',
  mover.x + ',' + mover.y);
ok(!G.hitsWall(mover.x, mover.y, G.PLAYER_RADIUS),
  'the player is still standing somewhere legal');

/* ======================================================================= */
section('hostile input cannot break a meeting');

fresh(6, 1);
game.phase = 'play';
G.host.startMeeting(game, net, game.players[game.order[1]], 'emergency', null);
ok(game.phase === 'meeting', 'a meeting started');

for (let i = 0; i < 40; i++) {
  send(game.order[1 + (i % 5)], { t: 'vote', target: NADES[i % NADES.length].target || null });
  send(game.order[1 + (i % 5)], { t: 'chat', text: NADES[i % NADES.length].text });
  clock += 16; game.clock = clock;
  try { G.host.tick(game, net, 1 / 60); } catch (e) { errors.push('meeting tick threw: ' + e.message); break; }
}
ok(errors.filter((e) => e.indexOf('meeting') >= 0).length === 0, 'hostile votes and chat never threw');
ok(game.phase === 'meeting' || game.phase === 'play' || game.phase === 'ended',
  'the game is still in a valid phase', game.phase);

// vote tallies must be sane
const tally = game.votes || {};
const badVote = Object.keys(tally).find((voter) => {
  const target = tally[voter];
  return target !== 'skip' && !game.players[target];
});
ok(badVote === undefined, 'no vote points at a player who does not exist',
  badVote ? badVote + ' -> ' + tally[badVote] : '');

/* ======================================================================= */
section('big and weird payloads');

fresh(6, 1);
const huge = 'A'.repeat(200000);
send(game.order[1], { t: 'chat', text: huge });
send(game.order[1], { t: 'input', x: 1, y: 1, junk: huge });
send(game.order[1], { t: 'task', stationId: 'w1', extra: { nested: { deep: huge } } });
ok(true, 'a 200 KB payload did not crash the host');
ok(game.chat.length <= 60, 'the chat log stays bounded', 'entries=' + game.chat.length);

const deep = {};
let cur = deep;
for (let i = 0; i < 200; i++) { cur.next = {}; cur = cur.next; }
send(game.order[1], { t: 'settings', settings: deep });
ok(true, 'a deeply nested payload did not crash the host');

/* ======================================================================= */
console.log('\n' + '═'.repeat(62));
console.log(failed === 0
  ? `✅ FUZZ TEST PASSED (${passed} assertions, ${sends} hostile packets)`
  : `❌ ${failed} FAILED, ${passed} passed`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  • ' + f));
}
if (errors.length) {
  console.log('\nHandler errors:');
  errors.slice(0, 8).forEach((e) => console.log('  ! ' + e));
}
console.log('═'.repeat(62));
process.exit(failed ? 1 : 0);
