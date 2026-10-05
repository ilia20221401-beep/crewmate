/* ==========================================================================
   test-game.js — headless simulation tests for the host logic.
   Loads the real src/*.js modules in Node with a minimal window shim and a
   fake transport, then drives complete matches and asserts the outcomes.
   Time is injected through game.clock so a 5 minute match runs instantly.

     node test-game.js
   ========================================================================== */
const { makeShim, loadModules, makeNet } = require('./test-game-shim.js');

const win = makeShim();
const G = loadModules(win, ['utils.js', 'world.js', 'audio.js', 'net.js', 'tasks.js', 'game.js', 'render.js']);
const net = makeNet();

/* ---------------- assertions -------------------------------------------- */

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else {
    failed++;
    failures.push(label + (extra ? ' — ' + extra : ''));
    console.log('  ✗ ' + label + (extra ? '  [' + extra + ']' : ''));
  }
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 58 - t.length))); }

/* ---------------- harness ----------------------------------------------- */

let game = new G.Game();
let clock = 1700000000000;      // injected "now" in ms
let seq = 0;

function reset() {
  game = new G.Game();
  clock = 1700000000000;
  game.clock = clock;
  game.isHost = true;
  game.phase = 'menu';
  game.order = [];
  game.players = {};
  G.game = game;
  game.view.youId = 'host';
  net._crewmateGame = game;
  net._clear();
}

function advance(ms) { clock += ms; game.clock = clock; }

function addPlayer(name, isMobile) {
  seq++;
  const conn = { _playerId: 'pending' + seq, open: true, send() {}, close() {}, on() {} };
  const handler = (net._handlers.join || [])[net._handlers.join.length - 1];
  const before = game.order.slice();
  handler({ conn, name, color: null, sessionId: 'sess_' + seq + '_' + name, isMobile: !!isMobile });
  const added = game.order.filter((id) => before.indexOf(id) < 0);
  return added.length ? added[0] : conn._playerId;
}

function hostSelf() {
  const p = G.host.makePlayer(game, 'host', 'Host', false);
  p.sessionId = 'sess_host';
  p.host = true;
  game.players.host = p;
  game.order.push('host');
  return p;
}

function startRound(nPlayers, impostors) {
  reset();
  G.host.init(game, net);
  hostSelf();
  for (let i = 1; i < nPlayers; i++) addPlayer('Player' + i, i % 2 === 0);
  game.settings.impostors = impostors || 1;
  G.host.startGame(game, net, { impostors: impostors || 1, speed: 1 });
  return game.order.slice();
}

/** advance the host simulation; also advances the injected clock */
function tick(seconds, dt) {
  dt = dt || 1 / 60;
  const steps = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < steps; i++) {
    advance(dt * 1000);
    G.host.tick(game, net, dt);
  }
}

const crewOf = () => game.order.filter((id) => game.players[id].role === 'crew');
const impsOf = () => game.order.filter((id) => game.players[id].role === 'imp');
const livingOf = () => game.order.filter((id) => game.players[id].alive);
const playPhase = () => tick(G.consts.ROLE_REVEAL_TIME + 0.4);

/* ======================================================================= */
section('modules & world');
ok(G.ROOMS.length === 8, 'eight rooms load', 'got ' + G.ROOMS.length);
ok(G.STATIONS.length > 20, 'task stations load', 'got ' + G.STATIONS.length);
ok(typeof G.host.startGame === 'function', 'host api present');
ok(typeof G.drawCrewmate === 'function', 'renderer helper present');
ok(typeof G.tasks.open === 'function', 'task minigames present');
ok(typeof G.host.trySabotage === 'function', 'sabotage api present');

/* ======================================================================= */
section('lobby');
reset();
G.host.init(game, net);
hostSelf();
ok(game.order.length === 1, 'host is player one');
const pB = addPlayer('Bob', true);
const pC = addPlayer('Cara', true);
const pD = addPlayer('Dan', false);
ok(game.order.length === 4, 'three clients joined', 'order=' + game.order.length);
ok(game.players[pB].isMobile === true, 'mobile flag recorded');
ok(new Set(game.order.map((i) => game.players[i].color)).size === 4, 'colours are unique');
G.lobbyState = null;
G.host.pushLobby(game, net);
ok(G.lobbyState && G.lobbyState.players.length === 4, 'lobby state published');
ok(G.lobbyState.canStart === true, 'can start with 4 players');

// regression: the lobby payload must actually reach the clients, or every one of
// them sits on "waiting for the host" with no player list at all
net._clear();
G.host.pushLobby(game, net);
const lobbySent = net._sent.filter((s) => s.msg && s.msg.t === 'lobby');
ok(lobbySent.length === 3, 'the lobby packet is sent to every remote client (not the host)',
  'sent to ' + lobbySent.length + ': ' + lobbySent.map((s) => s.to).join(','));
ok(lobbySent.every((s) => s.msg.players && s.msg.players.length === 4),
  'each lobby packet carries the full player list');
ok(!lobbySent.some((s) => s.to === 'host'), 'the host is not sent its own lobby packet');

// reconnecting with the same session id must not create a second slot
const bobSession = game.players[pB].sessionId;
const beforeCount = game.order.length;
const jh = net._handlers.join[net._handlers.join.length - 1];
jh({ conn: { _playerId: pB, open: true, send() {}, close() {}, on() {} }, name: 'Bob', sessionId: bobSession, isMobile: true });
ok(game.order.length === beforeCount, 'reconnect reuses the player slot', 'order=' + game.order.length);

ok(game.players[addPlayer('Eve', false)].isMobile === false, 'desktop client flagged as desktop');

reset();
G.host.init(game, net);
hostSelf();
addPlayer('Solo', false);
G.host.startGame(game, net, {});
ok(game.phase !== 'reveal', 'cannot start with 2 players', 'phase=' + game.phase);

/* ======================================================================= */
section('round start');
startRound(6, 1);
ok(game.phase === 'reveal', 'phase moves to reveal');
ok(impsOf().length === 1, 'exactly one impostor', 'got ' + impsOf().length);
ok(crewOf().length === 5, 'five crewmates');
ok(crewOf().every((id) => game.players[id].tasks.length >= 3), 'every crewmate has >= 3 tasks');
ok(impsOf().every((id) => game.players[id].tasks.length === 0), 'impostors have no tasks');
ok(game.tasksTotal > 0, 'task totals computed', 'total=' + game.tasksTotal);
ok(new Set(crewOf().map((i) => game.players[i].tasks.map((t) => t.id).join())).size > 1,
  'tasks are distributed, not identical');
ok(net._sent.filter((s) => s.msg.t === 'event' && s.msg.kind === 'role').length >= 5,
  'role packets sent to clients');
ok(game.order.every((id) => !G.hitsWall(game.players[id].x, game.players[id].y, 18)), 'spawns walkable');
ok(new Set(game.order.map((id) => Math.round(game.players[id].x) + ',' + Math.round(game.players[id].y))).size === game.order.length,
  'spawns distinct');
playPhase();
ok(game.phase === 'play', 'reveal ends and play begins', 'phase=' + game.phase);

/* ======================================================================= */
section('movement & collision');
const mover = game.players[crewOf()[0]];
const startX = mover.x, startY = mover.y;
mover.inx = 1; mover.iny = 0;
tick(0.5);
ok(mover.x > startX + 20, 'player moves with input', 'dx=' + (mover.x - startX).toFixed(1));
ok(!G.hitsWall(mover.x, mover.y, 18), 'never ends up in a wall');
ok(Math.abs(mover.y - startY) < 2, 'no perpendicular drift');
mover.inx = -1; mover.iny = -1;
tick(6);
ok(!G.hitsWall(mover.x, mover.y, 18), 'still outside walls after ramming a corner');
ok(mover.x >= 0 && mover.y >= 0 && mover.x <= G.WORLD_W && mover.y <= G.WORLD_H, 'stays in the world');
mover.inx = 0; mover.iny = 0;

const speedy = game.players[crewOf()[1]];
speedy.x = G.CAFETERIA.cx; speedy.y = G.CAFETERIA.cy;
speedy.inx = 1; speedy.iny = 0;
tick(0.4);
const straight = Math.abs(speedy.x - G.CAFETERIA.cx);
speedy.x = G.CAFETERIA.cx; speedy.y = G.CAFETERIA.cy;
speedy.inx = 1; speedy.iny = 1;
tick(0.4);
const diagonal = Math.hypot(speedy.x - G.CAFETERIA.cx, speedy.y - G.CAFETERIA.cy);
ok(straight > 10 && Math.abs(straight - diagonal) / straight < 0.15,
  'diagonal is not faster than straight', straight.toFixed(1) + ' vs ' + diagonal.toFixed(1));
speedy.inx = 0; speedy.iny = 0;

/* ======================================================================= */
section('tasks');
const worker = game.players[crewOf()[0]];
const st0 = G.stationById[worker.tasks[0].id];
worker.x = st0.x; worker.y = st0.y;
net._clear();
G.host.doTask(game, net, worker, st0.id);
ok(worker.tasks[0].done === true, 'task completes on its station');
ok(game.tasksDone === 1, 'global counter increments');
ok(net._to(worker.id).some((m) => m.kind === 'task-result' && m.ok), 'success reported');

const other = G.STATIONS.find((s) => !worker.tasks.some((t) => t.id === s.id));
net._clear();
worker.x = other.x; worker.y = other.y;
G.host.doTask(game, net, worker, other.id);
ok(worker.tasks.every((t) => !(t.id === other.id && t.done)), 'foreign station does nothing');
ok(net._to(worker.id).some((m) => m.kind === 'task-result' && !m.ok), 'rejection reported');

const far = game.players[crewOf()[1]];
const itsTask = far.tasks.find((t) => !t.done);
far.x = G.stationById[itsTask.id].x + 500;
far.y = G.stationById[itsTask.id].y + 500;
net._clear();
G.host.doTask(game, net, far, itsTask.id);
ok(itsTask.done === false, 'no completion from far away');

// the final task ends the round
startRound(5, 1);
playPhase();
const lastWorker = game.players[crewOf()[0]];
game.order.forEach((id) => (game.players[id].tasks || []).forEach((t) => { t.done = true; }));
const lastTask = lastWorker.tasks[lastWorker.tasks.length - 1];
lastTask.done = false;
game.tasksDone = game.tasksTotal - 1;
lastWorker.x = G.stationById[lastTask.id].x;
lastWorker.y = G.stationById[lastTask.id].y;
G.host.doTask(game, net, lastWorker, lastTask.id);
ok(game.phase === 'ended' && game.winner === 'crew', 'crew wins when the last task completes',
  'phase=' + game.phase + ' winner=' + game.winner);

/* ======================================================================= */
section('impostor kill');
startRound(6, 1);
playPhase();
const imp = game.players[impsOf()[0]];
const crewIds = crewOf();
const victim = game.players[crewIds[0]];
imp.x = G.CAFETERIA.cx; imp.y = G.CAFETERIA.cy;
victim.x = imp.x + 40; victim.y = imp.y;
imp.killReadyAt = 0;
net._clear();
G.host.tryKill(game, net, imp);
ok(victim.alive === false, 'victim dies');
ok(game.bodies.length === 1, 'a body is created');
ok(imp.killReadyAt > clock, 'cooldown starts');
ok(game.bodies.length && game.bodies[0].room && game.bodies[0].room.length > 0,
  'body records its room', 'room=' + (game.bodies[0] && game.bodies[0].room));

const victim2 = game.players[crewIds[1]];
victim2.x = imp.x + 30; victim2.y = imp.y;
net._clear();
G.host.tryKill(game, net, imp);
ok(victim2.alive === true, 'cannot kill during cooldown');
ok(net._to(imp.id).some((m) => m.kind === 'kill-result' && !m.ok && m.reason === 'cooldown'), 'cooldown reported');

imp.killReadyAt = 0;
imp.x = -9999; imp.y = -9999;
net._clear();
G.host.tryKill(game, net, imp);
ok(net._to(imp.id).some((m) => m.kind === 'kill-result' && m.reason === 'no-target'), 'out of range reported');

// a crewmate cannot kill
const notImp = game.players[crewIds[2]];
notImp.killReadyAt = 0;
net._clear();
G.host.tryKill(game, net, notImp);
ok(notImp.alive === true && game.players[crewIds[3]].alive === true, 'crewmates cannot kill');

/* ======================================================================= */
section('body report & voting');
const reporter = game.players[crewIds[3]];
const body = game.bodies[0];
reporter.x = body.x; reporter.y = body.y;
G.host.tryReport(game, net, reporter, body.id);
ok(game.phase === 'meeting', 'reporting starts a meeting', 'phase=' + game.phase);
ok(game.meeting && game.meeting.kind === 'body', 'meeting remembers the body report');
ok(game.bodies.length === 0, 'bodies cleared for the meeting');
ok(game.chat.length > 0 && game.chat[0].sys, 'system chat announces the report');

const impId = impsOf()[0];
livingOf().forEach((id) => G.host.doVote(game, net, game.players[id], impId));
ok(game.phase === 'play' || game.phase === 'ended', 'meeting resolves when all voted', 'phase=' + game.phase);
ok(!game.players[impId].alive, 'the impostor is ejected');
if (game.phase === 'ended') ok(game.winner === 'crew', 'crew wins after ejecting the only impostor');

startRound(6, 1);
playPhase();
const aliveNow = livingOf();
G.host.startMeeting(game, net, game.players[aliveNow[0]], 'emergency', null);
ok(game.phase === 'meeting', 'emergency meeting starts');
const suspects = aliveNow.filter((id) => id !== aliveNow[0]).slice(0, 3);
G.host.doVote(game, net, game.players[aliveNow[0]], suspects[0]);
G.host.doVote(game, net, game.players[aliveNow[1]], suspects[1]);
G.host.doVote(game, net, game.players[aliveNow[2]], 'skip');
G.host.doVote(game, net, game.players[aliveNow[3]], suspects[2]);
G.host.doVote(game, net, game.players[aliveNow[4]], 'skip');
G.host.doVote(game, net, game.players[aliveNow[5]], 'skip');
ok(game.phase === 'play' || game.phase === 'ended', 'a tie resolves the meeting');
if (game.phase === 'play') ok(suspects.every((s) => game.players[s].alive), 'a tie ejects nobody');

game.phase = 'meeting';
game.meeting = { text: 'x', endsAt: clock + 30000, timeLeft: 30, kind: 'body' };
game.votes = {};
const v1 = livingOf()[0];
G.host.doVote(game, net, game.players[v1], suspects[0]);
G.host.doVote(game, net, game.players[v1], suspects[1]);
ok(game.votes[v1] === suspects[0], 'one vote per player');

// a meeting times out on its own
G.host.startMeeting(game, net, game.players[livingOf()[0]], 'emergency', null);
tick(G.consts.MEETING_TIME + 1);
ok(game.phase === 'play' || game.phase === 'ended', 'a meeting resolves when the timer expires',
  'phase=' + game.phase);

/* ======================================================================= */
section('win conditions');
startRound(6, 1);
playPhase();
const impsA = impsOf();
const crewA = crewOf();
crewA.forEach((id) => {
  const victimP = game.players[id];
  if (!victimP.alive) return;
  if (livingOf().filter((x) => game.players[x].role === 'crew').length <= impsA.length) return;
  const impP = game.players[impsA[0]];
  impP.x = victimP.x + 20; impP.y = victimP.y;
  impP.killReadyAt = 0;
  G.host.tryKill(game, net, impP);
});
ok(game.phase === 'ended', 'match ends when the impostors outnumber the crew', 'phase=' + game.phase);
ok(game.winner === 'imp', 'impostors win', 'winner=' + game.winner);

startRound(6, 2);
ok(impsOf().length === 2, 'two impostors when requested', 'got ' + impsOf().length);
ok(crewOf().length === 4, 'four crewmates with two impostors');
playPhase();
const impPair = impsOf().map((id) => game.players[id]);
impPair[0].x = G.CAFETERIA.cx; impPair[0].y = G.CAFETERIA.cy;
impPair[1].x = impPair[0].x + 20; impPair[1].y = impPair[0].y;
impPair[0].killReadyAt = 0;
G.host.tryKill(game, net, impPair[0]);
ok(impPair[1].alive === true, 'impostors cannot kill each other');

/* ======================================================================= */
section('vents');
startRound(6, 1);
playPhase();
const ventImp = game.players[impsOf()[0]];
const vent = G.VENTS[0];
ventImp.x = vent.x; ventImp.y = vent.y;
net._clear();
G.host.tryVent(game, net, ventImp);
ok(ventImp.inVent === true, 'impostor enters a vent');
ok(net._to(ventImp.id).some((m) => m.kind === 'vent' && m.inVent === true), 'client told about the vent');
const crewVent = game.players[crewOf()[0]];
crewVent.x = vent.x; crewVent.y = vent.y;
G.host.tryVent(game, net, crewVent);
ok(crewVent.inVent === false, 'crewmates cannot vent');
G.host.tryVent(game, net, ventImp);
ok(ventImp.inVent === false, 'impostor leaves the vent');

ventImp.x = vent.x; ventImp.y = vent.y;
G.host.tryVent(game, net, ventImp);
ventImp.inx = 1; ventImp.iny = 0;
const beforeX = ventImp.x;
tick(0.5);
ok(Math.abs(ventImp.x - beforeX) < 1, 'a vented impostor stays put');
G.host.tryVent(game, net, ventImp);
ventImp.inx = 0; ventImp.iny = 0;

/* ======================================================================= */
section('sabotage');
startRound(6, 1);
playPhase();
const sabImp = game.players[impsOf()[0]];
net._clear();
G.host.trySabotage(game, net, sabImp, 'lights');
ok(game.sabotage && game.sabotage.active === true, 'lights sabotage becomes active');
ok(G.lightsOut === true, 'lights-out flag set');
ok(net._sent.some((s) => s.msg.kind === 'sabotage'), 'sabotage event broadcast');
net._clear();
G.host.trySabotage(game, net, sabImp, 'lights');
ok(net._sent.some((s) => s.msg.reason === 'active'), 'cannot stack sabotages');
const sabCrew = game.players[crewOf()[0]];
net._clear();
G.host.trySabotage(game, net, sabCrew, 'lights');
ok(game.sabotage.active === true, 'crewmates cannot sabotage');
net._clear();
G.host.tryFixLights(game, net, sabCrew);
ok(game.sabotage && game.sabotage.active, 'cannot fix the lights from elsewhere');
ok(net._to(sabCrew.id).some((m) => m.kind === 'fix-result' && m.reason === 'far'), 'reported as out of range');
const elec = G.roomById.electrical;
sabCrew.x = elec.cx; sabCrew.y = elec.cy;
G.host.tryFixLights(game, net, sabCrew);
ok(!game.sabotage && G.lightsOut === false, 'lights are fixed from Electrical');
advance(60000);   // wait out the sabotage recharge
G.host.trySabotage(game, net, sabImp, 'lights');
ok(game.sabotage && game.sabotage.active, 'the impostor can sabotage again after recharging');
game.sabotage.endsAt = clock - 1;
tick(0.2);
ok(!game.sabotage && G.lightsOut === false, 'sabotage expires by itself');

/* ======================================================================= */
section('emergency meetings');
startRound(6, 1);
playPhase();
const caller = game.players[crewOf()[0]];
caller.x = G.EMERGENCY_BUTTON.x; caller.y = G.EMERGENCY_BUTTON.y;
G.host.tryEmergency(game, net, caller);
ok(game.phase === 'meeting', 'emergency meeting starts at the button');
ok(caller.usedEmergency === true, 'the caller used their meeting');
game.phase = 'play';
G.host.tryEmergency(game, net, caller);
ok(game.phase === 'play', 'the same player cannot call twice');
const farCaller = game.players[crewOf()[2]];
farCaller.x = G.roomById.reactor.cx;
farCaller.y = G.roomById.reactor.cy;
net._clear();
G.host.tryEmergency(game, net, farCaller);
ok(game.phase === 'play', 'cannot call a meeting from across the ship');
ok(net._to(farCaller.id).some((m) => m.kind === 'emergency-result' && m.reason === 'far'), 'out-of-range reported');

/* ======================================================================= */
section('snapshots');
startRound(6, 1);
playPhase();
net._clear();
G.host.broadcastSnapshot(game, net);
const snaps = net._sent.filter((s) => s.msg.t === 'snapshot');
ok(snaps.length >= 5, 'a snapshot per remote player', 'got ' + snaps.length);
const firstSnap = snaps[0].msg;
ok(Array.isArray(firstSnap.pl) && firstSnap.pl.length === 6, 'snapshot carries all players');
ok(firstSnap.priv && firstSnap.priv.yo === snaps[0].to, 'each snapshot personalised');
ok(firstSnap.pl.every((p) => typeof p.x === 'number' && typeof p.y === 'number'), 'positions numeric');
const crewSnap = snaps.find((s) => s.msg.priv.ro === 'crew');
ok(crewSnap && crewSnap.msg.priv.tk.length >= 3, 'crewmate snapshot has their tasks');
ok(!/sessionId|_playerId|"conn"/.test(JSON.stringify(firstSnap)), 'no connection internals leak');

// a client can rebuild the world from a snapshot without errors
const cliGame = new G.Game();
cliGame.isHost = false;
cliGame.clock = clock;
G.client.applySnapshot(cliGame, crewSnap.msg);
ok(Object.keys(cliGame.players).length === 6, 'client rebuilds all players from a snapshot');
ok(cliGame.view.youId === crewSnap.to, 'the client knows which player it is',
  'youId=' + cliGame.view.youId + ' recipient=' + crewSnap.to);
ok(cliGame.view.tasks.length >= 3, 'client knows its tasks');

// the host's own private view is well formed
const priv = G.host.privateFor(game, 'host');
ok(priv && typeof priv.ro === 'string' && Array.isArray(priv.tk), 'host private view is well formed');

/* ======================================================================= */
section('chat');
game.phase = 'meeting';
game.chat = [];
const chatter = game.players[game.order[0]];
G.host.doChat(game, net, chatter, '  hello <b>there</b>  ');
ok(game.chat.length === 1, 'chat message recorded');
ok(!/[<>]/.test(game.chat[0].text), 'html characters stripped');
G.host.doChat(game, net, chatter, '     ');
ok(game.chat.length === 1, 'empty messages are ignored');
G.host.doChat(game, net, chatter, 'x'.repeat(400));
ok(game.chat[1].text.length <= 120, 'chat is truncated', 'len=' + game.chat[1].text.length);

/* ======================================================================= */
section('rematch & leaving');
G.host.endGame(game, net, 'crew', 'test');
ok(game.phase === 'ended', 'game ends');
G.host.rematch(game, net);
ok(game.phase === 'lobby', 'rematch returns to the lobby', 'phase=' + game.phase);
ok(game.order.every((id) => game.players[id].alive), 'everyone alive again');
ok(game.order.every((id) => game.players[id].tasks.length === 0), 'tasks cleared');
ok(G.lobbyState && G.lobbyState.players.length === game.order.length, 'lobby republished');

const leaver = game.order[game.order.length - 1];
const countBefore = game.order.length;
(net._handlers.leave || []).forEach((f) => f(leaver));
ok(game.order.length === countBefore - 1, 'a leaving player is removed from the lobby',
  'order=' + game.order.length);

/* ======================================================================= */
section('ghosts (dead crewmates)');
/*
 * Design guarantee: a dead crewmate can still finish their tasks. Without this
 * the crew's "all tasks done" victory becomes unreachable as soon as someone
 * dies with work left, and a match can deadlock forever.
 */
startRound(6, 1);
playPhase();
const ghost = game.players[crewOf()[0]];
const ghostTask = ghost.tasks.find((t) => !t.done);
ghost.alive = false;
const ghostStation = G.stationById[ghostTask.id];
ghost.x = ghostStation.x; ghost.y = ghostStation.y;
net._clear();
G.host.doTask(game, net, ghost, ghostTask.id);
ok(ghostTask.done === true, 'a dead crewmate can complete a task');
ok(ghost.alive === false, 'completing a task does not revive them');

ghost.x = 20; ghost.y = 20;                       // inside the outer wall
ghost.inx = 1; ghost.iny = 1;
tick(0.4);
ok(ghost.x !== 20 || ghost.y !== 20, 'a ghost moves freely, ignoring walls',
  'pos=' + ghost.x.toFixed(1) + ',' + ghost.y.toFixed(1));
ghost.inx = 0; ghost.iny = 0;

startRound(5, 1);
playPhase();
game.order.forEach((id) => (game.players[id].tasks || []).forEach((t) => { t.done = true; }));
const deadWorker = game.players[crewOf()[0]];
const finalTask = deadWorker.tasks[0];
finalTask.done = false;
deadWorker.alive = false;
game.tasksDone = game.tasksTotal - 1;
const finalStation = G.stationById[finalTask.id];
deadWorker.x = finalStation.x;
deadWorker.y = finalStation.y;
G.host.doTask(game, net, deadWorker, finalTask.id);
ok(game.phase === 'ended' && game.winner === 'crew',
  'a ghost completing the final task wins it for the crew',
  'phase=' + game.phase + ' winner=' + game.winner);

startRound(6, 1);
playPhase();
const deadVoter = game.players[crewOf()[0]];
deadVoter.alive = false;
G.host.startMeeting(game, net, game.players[livingOf()[0]], 'emergency', null);
const ghostVoteTarget = crewOf().find((id) => game.players[id].alive);
G.host.doVote(game, net, deadVoter, ghostVoteTarget);
ok(game.votes[deadVoter.id] === ghostVoteTarget, 'a dead player can still cast a vote');

/* ======================================================================= */
section('hostile payloads (regression)');
/*
 * A peer can send any JS value. `String(x)` runs the value's own toString, so a
 * crafted object used to throw straight out of the message handler and break the
 * packet pump. These must all be absorbed.
 */
startRound(5, 1);
playPhase();
game.phase = 'meeting';
game.chat = [];
const attacker = game.players[crewOf()[0]];

const evil = { toString() { throw new Error('boom'); } };
const evilPrim = {};
Object.defineProperty(evilPrim, Symbol.toPrimitive, { value() { throw new Error('boom2'); } });

let threw = null;
try {
  G.host.doChat(game, net, attacker, evil);
  G.host.doChat(game, net, attacker, evilPrim);
  G.host.doChat(game, net, attacker, {});
  G.host.doChat(game, net, attacker, null);
  G.host.doChat(game, net, attacker, ['a', 'b']);
  G.host.doChat(game, net, attacker, 42);
  G.host.trySabotage(game, net, game.players[impsOf()[0]], evil);
  G.host.doTask(game, net, attacker, evil);
  G.host.doTask(game, net, attacker, { id: 'w1' });
  G.host.doTask(game, net, attacker, ['w1']);
} catch (e) {
  threw = e;
}
ok(!threw, 'hostile values never escape a handler', threw ? threw.message : '');
ok(game.chat.every((m) => typeof m.text === 'string'), 'every stored chat message is a string');
ok(game.chat.every((m) => m.text.length <= 120), 'no stored chat message is oversized');
ok(!/[<>]/.test(game.chat.map((m) => m.text).join('')), 'no angle brackets survive into the chat');

// the whole dispatch path is guarded too
playPhase();
game.phase = 'play';
let dispatchThrew = null;
try {
  G.host.onMessage(game, net, { from: attacker.id, t: 'chat', text: evil }, null);
  G.host.onMessage(game, net, { from: attacker.id, t: 'task', stationId: evil }, null);
  G.host.onMessage(game, net, { from: attacker.id, t: 'sabotage', kind: evil }, null);
} catch (e) {
  dispatchThrew = e;
}
ok(!dispatchThrew, 'the message dispatcher absorbs hostile values',
  dispatchThrew ? dispatchThrew.message : '');

/* ======================================================================= */
section('full match simulation');
/* This drives the REAL host loop through a whole match. The bots use a real
   pathfinder and the game's own collision code, so a match failing to end means
   a genuine game problem rather than a bot that cannot navigate. */
const bots = require('./test-bots.js').createBots(G);
startRound(7, 1);
playPhase();
const simImp = game.players[impsOf()[0]];
const simCrew = crewOf().map((id) => game.players[id]);
let guard = 0;

while (game.phase === 'play' && guard++ < 4000) {
  for (const c of simCrew) {
    // dead crewmates keep working as ghosts, exactly as the real game allows
    const next = c.tasks.find((t) => !t.done);
    if (!next) continue;
    const st = G.stationById[next.id];
    if (c.alive) {
      if (bots.reach(c, st.x, st.y)) G.host.doTask(game, net, c, next.id);
      else bots.steer(c, st.x, st.y, 3.4);
    } else if (bots.reach(c, st.x, st.y)) {
      G.host.doTask(game, net, c, next.id);      // a ghost uses a station in range
    } else {
      // a ghost flies straight through walls
      const dx = st.x - c.x, dy = st.y - c.y, d = Math.hypot(dx, dy) || 1;
      const step = Math.min(d, 6);
      c.x += (dx / d) * step;
      c.y += (dy / d) * step;
    }
  }
  if (simImp.alive && clock >= simImp.killReadyAt) {
    const prey = simCrew.filter((c) => c.alive)[0];
    if (prey) {
      if (bots.reach(simImp, prey.x, prey.y, G.consts.KILL_RANGE - 8)) {
        G.host.tryKill(game, net, simImp);
      } else {
        bots.steer(simImp, prey.x, prey.y, 4.2);
      }
    }
  }
  advance(50);
  G.host.tick(game, net, 0.05);
}
ok(guard < 4000, 'the match reaches an end state', 'iterations=' + guard);
ok(game.phase === 'ended', 'match ends', 'phase=' + game.phase + ' winner=' + game.winner);
ok(game.winner === 'crew' || game.winner === 'imp', 'a valid winner', 'winner=' + game.winner);
ok(livingOf().length < game.order.length, 'the simulation caused real deaths',
  livingOf().length + '/' + game.order.length + ' alive');
ok(game.tasksDone <= game.tasksTotal, 'tasks done never exceeds total',
  game.tasksDone + '/' + game.tasksTotal);
ok(game.order.filter((id) => game.players[id].alive)
  .every((id) => !G.hitsWall(game.players[id].x, game.players[id].y, 18)),
  'no living player ended inside a wall');
ok(game.tasksDone > 0, 'the crew actually completed tasks', game.tasksDone + ' done');

/* a match where the crew wins on tasks */
startRound(6, 1);
playPhase();
let guard2 = 0;
const crew2 = crewOf().map((id) => game.players[id]);
// park the impostor far away so it cannot interfere
game.players[impsOf()[0]].x = G.roomById.reactor.cx;
game.players[impsOf()[0]].y = G.roomById.reactor.cy;
game.players[impsOf()[0]].killReadyAt = clock + 600000;
while (game.phase === 'play' && guard2++ < 2000) {
  for (const c of crew2) {
    if (!c.alive) continue;
    const next = c.tasks.find((t) => !t.done);
    if (!next) continue;
    const st = G.stationById[next.id];
    c.x = st.x; c.y = st.y;
    G.host.doTask(game, net, c, next.id);
  }
  advance(30);
  G.host.tick(game, net, 0.03);
}
ok(game.phase === 'ended', 'a crew task victory ends the match', 'phase=' + game.phase);
ok(game.winner === 'crew', 'crew wins by completing every task', 'winner=' + game.winner);
ok(game.tasksDone === game.tasksTotal, 'every task was completed',
  game.tasksDone + '/' + game.tasksTotal);

/* ======================================================================= */
console.log('\n' + '═'.repeat(62));
console.log(failed === 0 ? `✅ ALL ${passed} ASSERTIONS PASSED` : `❌ ${failed} FAILED, ${passed} passed`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  • ' + f));
}
console.log('═'.repeat(62));
process.exit(failed ? 1 : 0);
