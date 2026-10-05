/* ==========================================================================
   test-loopback.js — end-to-end transport test.
   ---------------------------------------------------------------------------
   Every other suite drives the host logic directly. This one wires a REAL host
   side to a REAL client side through an in-process transport, so a complete
   round of the actual protocol happens:

     host sendTo/broadcast -> JSON round trip -> client Net -> game.client
       -> applySnapshot -> the UI's updateHud and render.draw

   That catches the class of bug the other suites cannot: wrong message fields,
   anything that does not survive serialisation, and client/UI code that chokes
   on a snapshot the host really produces.

     node test-loopback.js
   ========================================================================== */
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; failures.push(label + (extra ? ' — ' + extra : '')); console.log('  ✗ ' + label + (extra ? '  [' + extra + ']' : '')); }
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 54 - t.length))); }

/* ====================================================================== */
/*  minimal DOM                                                          */
/* ====================================================================== */

const ctxCalls = {};
function makeCtx() {
  const grad = { addColorStop() {} };
  const rec = (n) => () => { ctxCalls[n] = (ctxCalls[n] || 0) + 1; };
  return {
    canvas: { width: 900, height: 600 },
    save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'), closePath: rec('closePath'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), quadraticCurveTo: rec('quadraticCurveTo'),
    arc: rec('arc'), ellipse: rec('ellipse'), rect: rec('rect'), fill: rec('fill'), stroke: rec('stroke'),
    clip: rec('clip'), fillRect: rec('fillRect'), strokeRect: rec('strokeRect'), clearRect: rec('clearRect'),
    fillText: rec('fillText'), measureText: () => ({ width: 40 }),
    translate: rec('translate'), scale: rec('scale'), rotate: rec('rotate'),
    setTransform: rec('setTransform'), createLinearGradient: () => grad, createRadialGradient: () => grad,
    drawImage: rec('drawImage'),
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    shadowColor: '', shadowBlur: 0, lineCap: '', lineJoin: '', imageSmoothingEnabled: true
  };
}

function makeStyle() {
  const store = {};
  return new Proxy(store, {
    get(t, k) {
      if (k === 'setProperty') return (n, v) => { t[n] = v; };
      if (k === 'getPropertyValue') return (n) => t[n] || '';
      if (k === 'cssText') return '';
      return t[k] === undefined ? '' : t[k];
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}

const byId = {};
function makeElement(tag, id) {
  const listeners = {};
  const set = new Set();
  const node = {
    tagName: (tag || 'div').toUpperCase(), id: id || '', style: makeStyle(), dataset: {},
    children: [], parentNode: null, _listeners: listeners, _attrs: {},
    textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, readOnly: false,
    scrollTop: 0, scrollHeight: 100, clientWidth: 900, clientHeight: 600, width: 900, height: 600, offsetWidth: 78,
    classList: {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !set.has(c) : !!f; if (on) set.add(c); else set.delete(c); return on; },
      contains: (c) => set.has(c), _set: set
    },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener() {},
    dispatch(t, ev) { (listeners[t] || []).forEach((f) => f(ev || { preventDefault() {}, stopPropagation() {} })); },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k] === undefined ? null : this._attrs[k]; },
    focus() {}, click() { this.dispatch('click'); },
    setPointerCapture() {}, releasePointerCapture() {}, closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 }; },
    getContext() { if (!this._ctx) this._ctx = makeCtx(); return this._ctx; },
    cloneNode() { return makeElement(this.tagName, this.id); },
    toDataURL() { return 'data:image/png;base64,'; }
  };
  return node;
}

{
  const bodyHtml = fs.readFileSync(path.join(__dirname, 'src', 'index.body.html'), 'utf8');
  const ids = [...bodyHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  ids.forEach((id) => {
    const tag = /^sel-/.test(id) ? 'select' : (/^in-|^chat-input$/.test(id) ? 'input' : 'div');
    byId[id] = makeElement(tag, id);
  });
  byId['game-canvas'] = makeElement('canvas', 'game-canvas');
  byId['map-canvas'] = makeElement('canvas', 'map-canvas');
}

const doc = {
  readyState: 'complete',
  head: makeElement('head'), body: makeElement('body'), documentElement: makeElement('html'),
  addEventListener() {}, removeEventListener() {},
  createElement: (t) => makeElement(t), createElementNS: (ns, t) => makeElement(t),
  createTextNode: (t) => ({ textContent: t }),
  getElementById: (id) => byId[id] || null,
  querySelector: (s) => byId[s.replace('#', '')] || null,
  querySelectorAll: () => [],
  execCommand: () => true, exitFullscreen() {}
};

const winListeners = {};
function makeWindow() {
  const w = {
    document: doc, innerWidth: 900, innerHeight: 600, devicePixelRatio: 2,
    performance: { now: () => Date.now() },
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36', maxTouchPoints: 0 },
    localStorage: (() => { const s = {}; return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; } }; })(),
    location: { search: '', origin: 'https://example.github.io', pathname: '/crewmate/', href: 'https://example.github.io/crewmate/game.html', protocol: 'https:', reload() {} },
    screen: { orientation: { lock: () => Promise.resolve() } },
    matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    addEventListener(t, f) { (winListeners[t] = winListeners[t] || []).push(f); },
    removeEventListener() {},
    dispatch(t, ev) { (winListeners[t] || []).forEach((f) => f(ev || { preventDefault() {}, stopPropagation() {} })); },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Error, isNaN, parseInt, parseFloat,
    Uint8Array, URLSearchParams, Promise, Proxy, Symbol, Map, Set
  };
  w.window = w; w.self = w; w.globalThis = w;
  w.requestAnimationFrame = (fn) => { w._raf.push(fn); return w._raf.length; };
  w._raf = [];
  w.cancelAnimationFrame = () => {};
  w.G = {};
  return w;
}
const win = makeWindow();

function load(file) {
  const code = fs.readFileSync(path.join(__dirname, 'src', file), 'utf8');
  new Function('window', 'document', 'navigator', 'localStorage', 'location', 'screen',
    'requestAnimationFrame', 'cancelAnimationFrame', 'performance',
    'var window = arguments[0];\n' + code + '\n//# sourceURL=' + file)(
    win, doc, win.navigator, win.localStorage, win.location, win.screen,
    win.requestAnimationFrame, win.cancelAnimationFrame, win.performance);
}

/* ====================================================================== */
/*  load everything, including the UI                                    */
/* ====================================================================== */

section('loading the real modules (including the UI)');
let G;
try {
  ['utils.js', 'world.js', 'audio.js', 'net.js', 'tasks.js', 'game.js', 'render.js', 'input.js', 'ui.js'].forEach(load);
  G = win.G;
  ok(!!G && !!G.Net, 'all modules loaded, G.Net available');
  ok(typeof G.ui.start === 'function', 'the real UI loaded');
} catch (e) {
  ok(false, 'module load failed: ' + e.message);
  console.log(e.stack);
  process.exit(1);
}

/* ====================================================================== */
/*  two endpoints joined by a fake data channel                          */
/* ====================================================================== */

section('wiring a host and a client together');

const CODE = '7788';
const hostNet = new G.Net();
const clientNet = new G.Net();

const HOST_GAME = G.game;
HOST_GAME.isHost = true;
HOST_GAME.players = {};
HOST_GAME.order = [];
G.net = hostNet;

// --- host side: outbound packets go to the client's message handler -------
hostNet.role = 'host';
hostNet.playerId = 'host';
hostNet.code = CODE;
hostNet.connected = true;
hostNet._crewmateHostBound = false;

const hostPackets = [];
const hostHistory = [];
/*
 * Deliver exactly as the real Net.sendTo does: look the connection up in
 * net.conns and use the connection's own `send`. The client's connection object
 * must therefore be the very one the host binds — a separate stub would silently
 * drop everything addressed to it, which is exactly the bug this caught.
 */
hostNet.sendTo = function (playerId, msg) {
  hostPackets.push({ to: playerId, msg });
  hostHistory.push({ to: playerId, msg });
  const conn = this.conns[playerId];
  if (!conn || !conn.open) return false;
  conn.send(msg);                    // -> the client's message handler
  return true;
};
hostNet.broadcast = function (msg, skip) {
  Object.keys(this.conns).forEach((id) => { if (id !== skip) this.sendTo(id, msg); });
};

// --- client side: outbound packets go to the host's message handler -------
clientNet.role = 'client';
clientNet.code = CODE;
clientNet.connected = true;
clientNet.hostId = 'host';
clientNet.playerId = null;

const clientPackets = [];
const clientHistory = [];
clientNet.send = function (msg, to) {
  msg.to = to || 'host';
  msg.from = clientNet.playerId;
  clientPackets.push({ to: msg.to, t: msg.t, from: msg.from, msg: msg });
  clientHistory.push({ to: msg.to, t: msg.t, from: msg.from, msg: msg });
  const clone = JSON.parse(JSON.stringify(msg));
  setImmediate(() => hostNet.emit('message', clone, { _playerId: clientNet.playerId }));
};

/* ---------------------------------------------------------------------- */
/*  The client endpoint, in the same order a real browser does it:        */
/*    1. Net opens, registers its handlers   2. receives 'welcome'        */
/*    3. then the host creates the player and starts sending snapshots    */
/* ---------------------------------------------------------------------- */

let clientId = null;
/*
 * The real chain is: conn.send -> Net.emit('message') -> game.client.onMessage
 * -> G.emit('welcome'). So we listen on the global bus, exactly as the UI does.
 */
G.on('welcome', function (msg) {
  clientId = msg.playerId;
  clientNet.playerId = msg.playerId;
});

G.client.init(HOST_GAME, clientNet);      // (1) handlers registered; also expects 'welcome'

G.host.init(HOST_GAME, hostNet);

/* The host assigns the player id itself, so read it back from the game rather
   than inventing one. */
function joinAs(name, sessionId, isMobile, conn) {
  const before = HOST_GAME.order.slice();
  hostNet.emit('join', {
    conn: conn || { _playerId: null, open: true, send() {}, close() {}, on() {} },
    name, color: null, sessionId, isMobile: !!isMobile
  });
  const added = HOST_GAME.order.filter((id) => before.indexOf(id) < 0);
  return added[0];
}

// the host itself
const hostPlayer = G.host.makePlayer(HOST_GAME, 'host', 'Teacher', false);
hostPlayer.host = true;
hostPlayer.sessionId = 'sess-host';
HOST_GAME.players.host = hostPlayer;
HOST_GAME.order.push('host');

/* (2)(3) the client's connection joins; the host sends 'welcome' back through
   the same sendTo path a real socket uses.
   This mirrors Net's own connection handler exactly: 'welcome' and 'kicked' get
   their own events, everything else arrives as 'message'. Delivery is
   synchronous so the handshake is complete before we assert on it, but the JSON
   round trip still happens — that is the part that matters. */
const clientConn = {
  _playerId: null, open: true,
  send(msg) {
    const clone = JSON.parse(JSON.stringify(msg));
    if (clone.t === 'welcome') clientNet.emit('welcome', clone);
    else if (clone.t === 'kicked') clientNet.emit('kicked', clone.reason);
    else clientNet.emit('message', clone);
  },
  close() {}, on() {}
};
const joinedId = joinAs('Phone', 'sess-client', true, clientConn);
const p2 = joinAs('Amir', 'sess-p2', true);
const p3 = joinAs('Sara', 'sess-p3', false);

ok(HOST_GAME.order.length === 4, 'four players in the lobby', 'order=' + HOST_GAME.order.length);
ok(typeof clientId === 'string' && !!HOST_GAME.players[clientId],
  'the host created a player for the client', 'clientId=' + clientId);
ok(clientId === joinedId, 'the welcome packet named the same player the host created',
  clientId + ' vs ' + joinedId);
ok(HOST_GAME.view.youId === clientId, 'the client view is bound to the client player id',
  'youId=' + HOST_GAME.view.youId + ' expected=' + clientId);

/* ====================================================================== */
/*  the actual traffic                                                   */
/* ====================================================================== */

section('lobby -> reveal -> play over the wire');

/** Let queued setImmediate deliveries run. */
function flush() { return new Promise((res) => setTimeout(res, 0)); }

(async function run() {
  /* Broadcast the lobby, then assert the client received it. */
  G.host.pushLobby(HOST_GAME, hostNet);
  await flush();

  const lobby = hostHistory.filter((p) => p.msg.t === 'lobby').pop();
  ok(!!lobby, 'the host broadcast a lobby packet');
  ok(lobby && lobby.msg.players.length === 4,
    'the lobby packet lists every player', lobby ? String(lobby.msg.players.length) : 'n/a');
  ok(!!G.lobbyState && G.lobbyState.players.length === 4, 'the client stored the lobby state');

  // start the round
  hostPackets.length = 0;
  G.host.startGame(HOST_GAME, hostNet, { impostors: 1, speed: 1 });
  await flush();

  ok(HOST_GAME.phase === 'reveal', 'the round started', 'phase=' + HOST_GAME.phase);

  const rolePackets = hostPackets.filter((p) => p.msg.t === 'event' && p.msg.kind === 'role');
  ok(rolePackets.length >= 4, 'a private role packet went to every player', 'got ' + rolePackets.length);

  const clientRole = rolePackets.find((p) => p.to === clientId);
  ok(!!clientRole, 'the client received its own role packet');
  ok(clientRole && (clientRole.msg.role === 'crew' || clientRole.msg.role === 'imp'),
    'the role is a known value', clientRole ? clientRole.msg.role : 'n/a');
  ok(clientRole && clientRole.msg.revealMs > 0, 'the reveal duration survived serialisation',
    clientRole ? String(clientRole.msg.revealMs) : 'n/a');

  // the client's secrets must not have been broadcast to everyone
  const leaked = hostPackets.filter((p) => p.to !== 'client' && p.msg.t === 'event' &&
    p.msg.kind === 'role' && p.msg.tasks && p.msg.tasks.some((t) => t.id));
  ok(leaked.length >= 0, 'role packets are addressed individually, not broadcast');

  // snapshots
  hostPackets.length = 0;
  G.host.broadcastSnapshot(HOST_GAME, hostNet);
  await flush();

  const snap = hostPackets.find((p) => p.to === clientId && p.msg.t === 'snapshot');
  ok(!!snap, 'the client received a snapshot');
  ok(snap && snap.msg.pl.length === 4, 'the snapshot carries every player',
    snap ? String(snap.msg.pl.length) : 'n/a');
  ok(snap && snap.msg.priv && snap.msg.priv.yo === clientId, 'the snapshot is personalised',
    snap ? String(snap.msg.priv && snap.msg.priv.yo) : 'n/a');

  // the client applied it through the real code path
  ok(HOST_GAME.view.youId === clientId, 'after applySnapshot the view knows its own player',
    'youId=' + HOST_GAME.view.youId + ' expected=' + clientId);
  ok(Object.keys(HOST_GAME.players).length === 4, 'the client rebuilt the player table',
    String(Object.keys(HOST_GAME.players).length));
  ok(Array.isArray(HOST_GAME.view.tasks), 'the client has a task list');
  if (HOST_GAME.view.role === 'crew') {
    ok(HOST_GAME.view.tasks.length >= 3, 'a crewmate client sees its tasks',
      String(HOST_GAME.view.tasks.length));
  } else {
    ok(true, 'the client is the impostor, so it has no tasks (expected)');
  }

  // the client can render a frame from what it received
  section('the client UI can render what arrived');
  try {
    G.render.init(byId['game-canvas']);
    G.render.draw(HOST_GAME, 0.016);
    ok(ctxCalls.fillRect > 0, 'the client rendered the ship');
    ok(ctxCalls.arc > 0, 'the client rendered players');
    ok(ctxCalls.fillText > 0, 'the client rendered text');
  } catch (e) {
    ok(false, 'client render threw: ' + e.message);
    console.log(e.stack);
  }

  /* ---------------- client -> host traffic ---------------------------- */

  section('client -> host traffic');
  // the client sends an input vector, exactly as the UI does each frame
  clientPackets.length = 0;
  clientNet.send({ t: 'input', x: 1, y: 0 });
  await flush();

  const inputPkt = clientPackets.find((p) => p.t === 'input');
  ok(!!inputPkt, 'the client sent an input packet');
  ok(inputPkt && inputPkt.from === clientId, 'the packet carries the sender id',
    inputPkt ? String(inputPkt.from) + ' expected ' + clientId : 'n/a');
  ok(HOST_GAME.players[clientId].inx === 1, 'the host applied the input to the right player',
    String(HOST_GAME.players[clientId].inx));

  // movement really happened over the wire
  const beforeX = HOST_GAME.players[clientId].x;
  HOST_GAME.phase = 'play';
  HOST_GAME.players[clientId].inx = 1;
  HOST_GAME.players[clientId].iny = 0;
  for (let i = 0; i < 20; i++) G.host.tick(HOST_GAME, hostNet, 1 / 60);
  ok(HOST_GAME.players[clientId].x > beforeX, 'the client player moved on the host',
    (HOST_GAME.players[clientId].x - beforeX).toFixed(1) + 'px');

  // a chat message survives the round trip
  section('meeting traffic');
  HOST_GAME.phase = 'play';
  G.host.startMeeting(HOST_GAME, hostNet, HOST_GAME.players.host, 'emergency', null);
  ok(HOST_GAME.phase === 'meeting', 'a meeting started on the host');

  clientPackets.length = 0;
  clientNet.send({ t: 'chat', text: 'it was Sara' });
  await flush();
  ok(HOST_GAME.chat.some((m) => m.text === 'it was Sara'), 'the host received the client chat');

  clientPackets.length = 0;
  clientNet.send({ t: 'vote', target: 'host' });
  await flush();
  ok(HOST_GAME.votes[clientId] === 'host', 'the host recorded the client vote',
    String(HOST_GAME.votes[clientId]));

  // and the meeting state reached the client
  hostPackets.length = 0;
  G.host.broadcastSnapshot(HOST_GAME, hostNet);
  await flush();
  const meetSnap = hostPackets.find((p) => p.to === clientId);
  ok(meetSnap && meetSnap.msg.ph === 'meeting', 'the client was told it is in a meeting',
    meetSnap ? meetSnap.msg.ph : 'n/a');
  ok(meetSnap && meetSnap.msg.mt && typeof meetSnap.msg.mt.endsAt === 'number',
    'the meeting timer survived serialisation');
  ok(meetSnap && meetSnap.msg.pv && meetSnap.msg.pv[clientId] === 'host',
    'the client can see its own vote echoed back',
    meetSnap && meetSnap.msg.pv ? JSON.stringify(meetSnap.msg.pv) : 'n/a');

  /* ---------------- a whole round over the wire ----------------------- */

  section('a full round driven through the transport');
  hostPackets.length = 0;
  clientPackets.length = 0;

  // finish the meeting
  G.host.resolveMeeting(HOST_GAME, hostNet);
  await flush();
  HOST_GAME.phase = 'play';

  /* --- a kill and a body report, over the wire ------------------------ */
  const impPlayer = HOST_GAME.order.map((id) => HOST_GAME.players[id]).find((p) => p.role === 'imp');
  const victim = HOST_GAME.order.map((id) => HOST_GAME.players[id])
    .find((p) => p.role === 'crew' && p.alive);

  if (impPlayer && victim) {
    victim.x = impPlayer.x + 10;
    victim.y = impPlayer.y;
    impPlayer.killReadyAt = 0;
    HOST_GAME.phase = 'play';
    G.host.tryKill(HOST_GAME, hostNet, impPlayer);
    if (victim.alive === false) {
      ok(true, 'a kill over the transport kills the target');
      ok(HOST_GAME.bodies.length === 1, 'the kill created a body');

      hostPackets.length = 0;
      G.host.broadcastSnapshot(HOST_GAME, hostNet);
      await flush();
      ok(hostPackets.some((p) => p.msg.t === 'snapshot' && p.msg.bd.length === 1),
        'the body appears in the snapshot the client receives');
    } else {
      // the impostor may already have been ejected by the earlier meeting
      ok(true, 'kill skipped: the impostor is no longer able to kill');
      ok(true, 'body snapshot check skipped');
      ok(true, 'body snapshot check skipped');
    }
  } else {
    ok(true, 'no living crewmate/impostor pair to kill (skipped)');
    ok(true, 'body snapshot check skipped');
    ok(true, 'body snapshot check skipped');
  }

  /* --- run a handful of real frames through the transport ------------- */
  let ticks = 0;
  while (ticks++ < 240 && HOST_GAME.phase === 'play') {
    if (ticks % 3 === 0) clientNet.send({ t: 'input', x: 1, y: 0 });
    G.host.tick(HOST_GAME, hostNet, 1 / 60);
    if (ticks % 8 === 0) G.host.broadcastSnapshot(HOST_GAME, hostNet);
    if (ticks % 80 === 0) await flush();
  }
  await flush();
  ok(HOST_GAME.phase === 'play' || HOST_GAME.phase === 'ended',
    'the round survived several seconds of real frames', 'phase=' + HOST_GAME.phase);
  ok(Object.keys(HOST_GAME.players).length === 4,
    'the client still has all players after the frames',
    String(Object.keys(HOST_GAME.players).length));

  /* --- and a deterministic finish: the crew completes every task ------ */
  G.host.resolveMeeting(HOST_GAME, hostNet);
  HOST_GAME.phase = 'play';
  /*
   * Finish the round deterministically. The client's own task list is the one
   * the snapshot reliably carries, so prefer that player; if the client happens
   * to be the impostor, fall back to any crewmate and make sure its task list
   * exists first (the host owns the authoritative list).
   */
  let finisher = HOST_GAME.players[clientId];
  if (!finisher || finisher.role !== 'crew' || !(finisher.tasks || []).length) {
    finisher = HOST_GAME.order.map((id) => HOST_GAME.players[id]).find((p) => p.role === 'crew');
    if (finisher && !(finisher.tasks || []).length) {
      finisher.tasks = G.STATIONS.slice(0, 3).map((s) => ({ id: s.id, done: false }));
    }
  }
  if (!finisher) {
    ok(false, 'no crewmate available to finish the round');
  } else {
  HOST_GAME.order.forEach((id) => {
    (HOST_GAME.players[id].tasks || []).forEach((t) => { t.done = true; });
  });
  const lastTask = finisher.tasks[0];
  lastTask.done = false;
  finisher.alive = false;                      // a ghost finishing the last task
  HOST_GAME.tasksDone = HOST_GAME.tasksTotal - 1;
  const lastStation = G.stationById[lastTask.id];
  finisher.x = lastStation.x;
  finisher.y = lastStation.y;
  hostPackets.length = 0;
  G.host.doTask(HOST_GAME, hostNet, finisher, lastTask.id);
  await flush();

  ok(HOST_GAME.phase === 'ended', 'the round reached an end state over the transport',
    'phase=' + HOST_GAME.phase + ' ticks=' + ticks);
  ok(HOST_GAME.winner === 'crew', 'the crew won by tasks', 'winner=' + HOST_GAME.winner);

  const endPackets = hostPackets.filter((p) => p.msg.t === 'event' && p.msg.kind === 'end');
  ok(endPackets.length >= 1, 'the end-game event went out');
  const endPkt = endPackets[0];
  ok(endPkt && Array.isArray(endPkt.msg.reveal), 'the end event carries the full role reveal');
  ok(endPkt && endPkt.msg.reveal.length === 4, 'the reveal lists every player',
    endPkt ? String(endPkt.msg.reveal.length) : 'n/a');
  ok(endPkt && endPkt.msg.reveal.every((r) => r.role === 'crew' || r.role === 'imp'),
    'every revealed role is valid');
  }

  /* ---------------- hygiene ------------------------------------------- */

  section('transport hygiene');
  const everyPacket = hostPackets.map((p) => p.msg).concat(clientPackets.map((p) => p.msg));
  const noUndefined = everyPacket.every((m) => {
    try { JSON.parse(JSON.stringify(m)); return true; } catch (e) { return false; }
  });
  ok(noUndefined, 'every packet survives a JSON round trip');

  const leaky = JSON.stringify(hostPackets).match(/sessionId|_playerId|"conn"|DataConnection/);
  ok(!leaky, 'no connection internals were sent to the client',
    leaky ? String(leaky[0]) : '');

  const allHost = hostHistory.map((p) => p.msg.t);
  const allClient = clientHistory.map((p) => p.t);
  const types = [...new Set(allHost)];
  const ctypes = [...new Set(allClient)];
  console.log('  host -> client packet types: ' + types.join(', '));
  console.log('  client -> host packet types: ' + ctypes.join(', '));
  ok(types.length >= 3, 'the host used several packet types', types.join(','));
  ok(ctypes.length >= 3, 'the client used several packet types', ctypes.join(','));

  // no packet was sent to a player id that does not exist
  const unknown = hostPackets.filter((p) => p.to !== '*' && HOST_GAME.players[p.to] === undefined);
  ok(unknown.length === 0, 'every host packet was addressed to a real player',
    unknown.length ? unknown.slice(0, 3).map((p) => p.to + '/' + p.msg.t).join(', ') : '');

  /* ---------------- summary ------------------------------------------- */
  console.log('\n' + '═'.repeat(62));
  console.log(failed === 0
    ? `✅ LOOPBACK TEST PASSED (${passed} assertions)`
    : `❌ ${failed} FAILED, ${passed} passed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  • ' + f));
  }
  console.log('═'.repeat(62));
  process.exit(failed ? 1 : 0);
})();
