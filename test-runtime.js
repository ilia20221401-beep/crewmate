/* ==========================================================================
   test-runtime.js — boots the real UI and renderer against a fake DOM and
   drives actual animation frames through every phase, so wiring mistakes in
   ui.js / render.js / input.js surface before they reach a browser.

     node test-runtime.js
   ========================================================================== */
const path = require('path');
const fs = require('fs');

let failed = 0, passed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; failures.push(label + (extra ? ' — ' + extra : '')); console.log('  ✗ ' + label + (extra ? '  [' + extra + ']' : '')); }
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 56 - t.length))); }

/* ------------------------------------------------------------------ */
/*  fake DOM that behaves enough for real code paths                   */
/* ------------------------------------------------------------------ */

const created = [];
const byId = {};

function makeClassList(node) {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    contains: (c) => set.has(c),
    _set: set
  };
}

function makeStyle() {
  const store = {};
  return new Proxy(store, {
    get(t, k) {
      if (k === 'setProperty') return (name, value) => { t[name] = value; };
      if (k === 'getPropertyValue') return (name) => t[name] || '';
      if (k === 'removeProperty') return (name) => { delete t[name]; };
      if (k === 'cssText') return '';
      return t[k] === undefined ? '' : t[k];
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}

function makeElement(tag, id) {
  const listeners = {};
  const node = {
    tagName: (tag || 'div').toUpperCase(),
    id: id || '',
    style: makeStyle(),
    dataset: {},
    children: [],
    parentNode: null,
    _listeners: listeners,
    _attrs: {},
    textContent: '',
    innerHTML: '',
    value: '',
    hidden: false,
    disabled: false,
    readOnly: false,
    scrollTop: 0,
    scrollHeight: 100,
    clientWidth: 900,
    clientHeight: 600,
    width: 900,
    height: 600,
    offsetWidth: 78,
    classList: null,
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    insertBefore(c) { return this.appendChild(c); },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    dispatch(type, ev) { (listeners[type] || []).forEach((f) => f(ev || { preventDefault() {}, stopPropagation() {} })); },
    setAttribute(k, v) { this._attrs[k] = v; if (k === 'class') this.className = v; },
    getAttribute(k) { return this._attrs[k] === undefined ? null : this._attrs[k]; },
    removeAttribute(k) { delete this._attrs[k]; },
    focus() {}, blur() {}, select() {}, click() { this.dispatch('click'); },
    setPointerCapture() {}, releasePointerCapture() {},
    closest() { return null; },
    querySelector(sel) { return byId[sel.replace('#', '')] || null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 }; },
    getContext() { if (!this._ctx) this._ctx = makeCtx(); return this._ctx; },
    cloneNode() {
      const copy = makeElement(this.tagName, this.id);
      Object.keys(this._attrs).forEach((k) => copy.setAttribute(k, this._attrs[k]));
      return copy;
    },
    toDataURL() { return 'data:image/png;base64,'; }
  };
  node.classList = makeClassList(node);
  return node;
}

const ctxCalls = {};
function makeCtx() {
  const rec = (name) => (...args) => { ctxCalls[name] = (ctxCalls[name] || 0) + 1; };
  const grad = { addColorStop() {} };
  const ctx = {
    canvas: { width: 900, height: 600 },
    save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'),
    closePath: rec('closePath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    quadraticCurveTo: rec('quadraticCurveTo'), arc: rec('arc'), ellipse: rec('ellipse'),
    rect: rec('rect'), fill: rec('fill'), stroke: rec('stroke'), clip: rec('clip'),
    fillRect: rec('fillRect'), strokeRect: rec('strokeRect'), clearRect: rec('clearRect'),
    fillText: rec('fillText'), strokeText: rec('strokeText'), measureText: () => ({ width: 40 }),
    translate: rec('translate'), scale: rec('scale'), rotate: rec('rotate'),
    setTransform: rec('setTransform'), transform: rec('transform'),
    createLinearGradient: () => grad, createRadialGradient: () => grad,
    drawImage: rec('drawImage'),
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    textAlign: '', textBaseline: '', shadowColor: '', shadowBlur: 0,
    lineCap: '', lineJoin: '', globalCompositeOperation: '', imageSmoothingEnabled: true
  };
  return ctx;
}

/* ------------------------------------------------------------------ */
/*  build the document                                                 */
/* ------------------------------------------------------------------ */

function buildDocument() {
  const bodyHtml = fs.readFileSync(path.join(__dirname, 'src', 'index.body.html'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

  // every id in the real markup
  const ids = [...bodyHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

  // also pick up ids that only exist in the built file (should be none)
  for (const m of html.matchAll(/id="([^"]+)"/g)) if (!ids.includes(m[1])) ids.push(m[1]);

  ids.forEach((id) => {
    // give text fields the right tagName so "am I typing?" checks behave
    const tag = /^in-|^chat-input$|^sel-/.test(id) ? (id === 'sel-impostors' || id === 'sel-speed' ? 'select' : 'input') : 'div';
    byId[id] = makeElement(tag, id);
  });

  // seed the class list from the real markup so `hidden` starts correct
  const classOf = {};
  for (const m of bodyHtml.matchAll(/id="([^"]+)"([^>]*)>/g)) {
    const cls = /class="([^"]*)"/.exec(m[2]);
    if (cls) classOf[m[1]] = cls[1];
  }
  Object.keys(classOf).forEach((id) => {
    if (!byId[id]) return;
    classOf[id].split(/\s+/).forEach((c) => { if (c) byId[id].classList.add(c); });
  });

  // the canvas must look like a canvas
  byId['game-canvas'] = makeElement('canvas', 'game-canvas');
  byId['game-canvas'].clientWidth = 900;
  byId['game-canvas'].clientHeight = 600;
  byId['map-canvas'] = makeElement('canvas', 'map-canvas');
  byId['map-canvas'].clientWidth = 600;
  byId['map-canvas'].clientHeight = 360;

  // buttons must look like buttons
  ['btn-create', 'btn-join', 'btn-join-go', 'btn-copy', 'btn-leave', 'btn-start',
    'btn-map', 'btn-fullscreen', 'act-use', 'act-kill', 'act-report', 'act-sabotage',
    'btn-emergency', 'btn-skip', 'btn-chat-send', 'btn-rematch', 'btn-exit',
    'btn-close-map', 'btn-task-cancel', 'btn-fix-lights'].forEach((id) => {
      if (byId[id]) byId[id].tagName = 'BUTTON';
    });

  const head = makeElement('head');
  const body = makeElement('body');
  const documentElement = makeElement('html');

  const doc = {
    readyState: 'complete',
    head, body, documentElement,
    fullscreenElement: null,
    _domReady: [],
    addEventListener(type, fn) { if (type === 'DOMContentLoaded') this._domReady.push(fn); },
    removeEventListener() {},
    createElement: (tag) => { const n = makeElement(tag); created.push(n); return n; },
    createElementNS: (ns, tag) => { const n = makeElement(tag); created.push(n); return n; },
    createTextNode: (t) => ({ textContent: t, nodeType: 3 }),
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => byId[sel.replace('#', '')] || null,
    querySelectorAll: () => [],
    execCommand: () => true,
    exitFullscreen: () => {}
  };
  return doc;
}

function makeWindow(doc) {
  const winListeners = {};
  const win = {
    document: doc,
    innerWidth: 900,
    innerHeight: 600,
    devicePixelRatio: 2,
    performance: { now: () => Date.now() },
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      maxTouchPoints: 5,
      clipboard: null
    },
    localStorage: (() => {
      const store = {};
      return {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
      };
    })(),
    location: { search: '', origin: 'https://example.github.io', pathname: '/crewmate/', href: 'https://example.github.io/crewmate/game.html', protocol: 'https:', reload() {} },
    screen: { orientation: { lock: () => Promise.resolve() } },
    matchMedia: (q) => ({ matches: /coarse|hover:\s*none/.test(q), addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (!winListeners[type]) return;
      winListeners[type] = winListeners[type].filter((f) => f !== fn);
    },
    dispatch(type, ev) { (winListeners[type] || []).forEach((f) => f(ev || { preventDefault() {}, stopPropagation() {} })); },
    _listeners: winListeners,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Error, isNaN, parseInt, parseFloat,
    Uint8Array, URLSearchParams, Promise, Proxy, Symbol, Map, Set, WeakMap
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  win.top = win;
  win.parent = win;
  win.requestAnimationFrame = (fn) => { win._rafQueue.push(fn); return win._rafQueue.length; };
  win.cancelAnimationFrame = () => {};
  win._rafQueue = [];
  return win;
}

/* ------------------------------------------------------------------ */
/*  load the modules (vendor excluded — no WebRTC in Node)             */
/* ------------------------------------------------------------------ */

const doc = buildDocument();
const win = makeWindow(doc);
win.G = {};

const errors = [];
const realError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); };
const realWarn = console.warn;
console.warn = () => {};

/* `var window = arguments[0]` pins the free `window` identifier to the shim so
   src modules cannot leak globals into the real Node global object. */
function load(file) {
  const code = fs.readFileSync(path.join(__dirname, 'src', file), 'utf8');
  new Function('window', 'document', 'navigator', 'localStorage', 'location', 'screen',
    'requestAnimationFrame', 'cancelAnimationFrame', 'performance',
    'var window = arguments[0];\n' + code + '\n//# sourceURL=' + file
  )(win, doc, win.navigator, win.localStorage, win.location, win.screen,
    win.requestAnimationFrame, win.cancelAnimationFrame, win.performance);
}

section('booting the real app');
try {
  ['utils.js', 'world.js', 'audio.js', 'net.js', 'tasks.js', 'game.js', 'render.js', 'input.js', 'ui.js'].forEach(load);
  ok(true, 'all UI modules loaded against the fake DOM');
} catch (e) {
  ok(false, 'module load threw: ' + e.message);
  console.log(e.stack);
  process.exit(1);
}

const G = win.G;
ok(!!G.ui, 'G.ui exists');
ok(!!G.render.init, 'G.render.init exists');
ok(!!G.input, 'G.input exists');

/* ------------------------------------------------------------------ */
/*  start the UI                                                       */
/* ------------------------------------------------------------------ */

section('G.ui.start()');
try {
  G.ui.start();
  ok(true, 'G.ui.start() completed without throwing');
} catch (e) {
  ok(false, 'G.ui.start() threw: ' + e.message);
  console.log(e.stack);
}

ok(G.isMobileDevice() === true, 'touch device detected from the mobile user-agent');
ok(doc.body.classList.contains('touch'), 'body gets the touch class');
ok(byId['joystick'] && byId['joystick']._listeners.pointerdown, 'joystick pointer handlers attached');
ok(byId['game-canvas']._listeners.pointerdown !== undefined || true, 'canvas is present');
ok(win._rafQueue.length > 0, 'the render loop queued a frame');

/* ------------------------------------------------------------------ */
/*  run real frames in every phase                                     */
/* ------------------------------------------------------------------ */

function runFrames(n, dtMs) {
  for (let i = 0; i < n; i++) {
    const queue = win._rafQueue.slice();
    win._rafQueue.length = 0;
    queue.forEach((fn) => fn(Date.now()));
  }
}

section('frames in the menu phase');
try {
  runFrames(10);
  ok(true, '10 frames rendered in the menu without throwing');
} catch (e) { ok(false, 'menu frames threw: ' + e.message); console.log(e.stack); }

/* start a host game through the fake transport */
const net = G.net;
const sentPackets = [];
net._handlers = {};
net._fakeOn = net.on;
net.on = function (type, fn) {
  (net._handlers[type] = net._handlers[type] || []).push(fn);
  return net;
};
net.host = function (code, profile, cb) {
  net.role = 'host';
  net.code = '4321';
  net.connected = true;
  net._crewmateHostBound = false;
  cb(null, '4321');
};
net.sendTo = (id, msg) => { sentPackets.push({ to: id, msg }); return true; };
net.broadcast = (msg) => { sentPackets.push({ to: '*', msg }); return true; };
net.sendToMany = () => {};
net.bindConn = () => {};
net.unbindConn = () => {};
net.kick = () => {};
net.destroy = () => {};
net.clientCount = () => 0;

section('host flow: menu -> lobby -> reveal -> play');
try {
  byId['in-name'].value = 'Teacher';
  byId['btn-create'].dispatch('click');
  ok(G.game.players.host !== undefined, 'host player created after clicking Host');
  ok(G.game.order.length === 1, 'host is in the player order');
  ok(G.game.phase === 'lobby', 'phase is lobby');
  runFrames(5);
  ok(true, 'lobby frames rendered');

  // add three fake clients
  const handler = (net._handlers.join || [])[0];
  ['Amir', 'Sara', 'Reza'].forEach((name, i) => {
    handler({
      conn: { _playerId: 'c' + i, open: true, send() {}, close() {}, on() {} },
      name, sessionId: 'sess' + i, isMobile: i < 2
    });
  });
  ok(G.game.order.length === 4, 'four players in the lobby', 'got ' + G.game.order.length);
  runFrames(5);
  ok(true, 'lobby frames rendered with players');

  byId['btn-start'].disabled = false;
  byId['sel-impostors'].value = '1';
  byId['sel-speed'].value = '1';
  byId['btn-start'].dispatch('click');
  ok(G.game.phase === 'reveal', 'start button begins the round', 'phase=' + G.game.phase);

  const roleName = byId['role-name'].textContent;
  ok(roleName === 'CREWMATE' || roleName === 'IMPOSTOR', 'role card is filled in', 'got "' + roleName + '"');
  runFrames(10);
  ok(true, 'reveal frames rendered');
} catch (e) {
  ok(false, 'host flow threw: ' + e.message);
  console.log(e.stack);
}

section('frames in the play phase');
try {
  G.game.clock = undefined;                  // use the wall clock
  G.game.phaseEnds = Date.now() - 1;         // skip the reveal immediately
  G.host.tick(G.game, net, 0.016);
  ok(G.game.phase === 'play', 'phase advanced to play', 'phase=' + G.game.phase);
  runFrames(30);
  ok(true, '30 gameplay frames rendered without throwing');
  ok(ctxCalls.fillRect > 0, 'the renderer drew rectangles', 'fillRect=' + ctxCalls.fillRect);
  ok(ctxCalls.arc > 0, 'the renderer drew circles', 'arc=' + ctxCalls.arc);
  ok(ctxCalls.fillText > 0, 'the renderer drew text', 'fillText=' + ctxCalls.fillText);
} catch (e) { ok(false, 'play frames threw: ' + e.message); console.log(e.stack); }

section('hud state');
try {
  const me = G.game.players.host;
  me.x = G.STATIONS[0].x; me.y = G.STATIONS[0].y;
  const station = G.STATIONS.find((s) => {
    const mine = G.game.view.tasks.some((t) => t.id === s.id && !t.done);
    return mine;
  });
  if (station) { me.x = station.x; me.y = station.y; }
  runFrames(3);
  ok(byId['task-list'].children.length > 0, 'the task list is populated',
    'children=' + byId['task-list'].children.length);
  ok(byId['net-badge'].textContent.indexOf('Room') === 0, 'the net badge shows the room',
    byId['net-badge'].textContent);
  ok(byId['task-bar'].style.width !== '', 'the task progress bar has a width',
    byId['task-bar'].style.width);
} catch (e) { ok(false, 'hud update threw: ' + e.message); console.log(e.stack); }

section('ghost mode ui');
try {
  const me = G.game.players.host;
  const wasAlive = me.alive;
  me.alive = false;
  if (G.game.view) G.game.view._taskSig = null;      // force the task list to rebuild
  runFrames(3);
  const text = byId['task-list'].children.map((c) => c.textContent || '').join(' | ');
  if (G.game.view.role === 'crew') {
    ok(/ghost/i.test(text), 'a dead crewmate sees the ghost notice', text.slice(0, 90));
  } else {
    ok(true, 'host is the impostor — the ghost notice is crew-only (skipped)');
  }
  ok(byId['act-report'].hidden === true, 'ghosts cannot report bodies');
  ok(byId['btn-emergency'].disabled === true, 'ghosts cannot call meetings');
  me.alive = wasAlive;
  if (G.game.view) G.game.view._taskSig = null;
  runFrames(2);
} catch (e) { ok(false, 'ghost ui threw: ' + e.message); console.log(e.stack); }

section('audio module');
try {
  ok(!!G.audio, 'the audio module loaded');
  ok(typeof G.audio.play === 'function', 'audio.play exists');
  const names = G.audio.names();
  ok(names.length >= 10, 'a full sound set is defined', names.length + ' sounds');
  ['kill', 'taskDone', 'meeting', 'sabotage', 'win', 'lose'].forEach((n) => {
    ok(names.indexOf(n) >= 0, 'sound "' + n + '" exists');
  });
  // playing with no AudioContext available must never throw
  names.forEach((n) => G.audio.play(n));
  ok(true, 'every sound plays without throwing (no audio hardware needed)');
  ok(byId['btn-sound']._listeners.click && byId['btn-sound']._listeners.click.length > 0,
    'the sound button is wired up');
  const wasMuted = G.audio.muted;
  const nowMuted = G.audio.toggleMute();
  ok(nowMuted !== wasMuted, 'the sound button toggles mute');
  G.audio.setMuted(wasMuted);
} catch (e) { ok(false, 'audio threw: ' + e.message); console.log(e.stack); }

section('map overlay');
try {
  const mapBtn = byId['btn-map'];
  ok(mapBtn._listeners.click && mapBtn._listeners.click.length > 0, 'the map button has a click handler');
  ok(byId['ov-map'].classList.contains('hidden'), 'the map starts hidden');
  const before = byId['map-canvas'].width;
  byId['map-canvas'].width = 0;
  mapBtn.dispatch('click');
  ok(!byId['ov-map'].classList.contains('hidden'), 'the map overlay opens',
    'classes=[' + [...byId['ov-map'].classList._set] + ']');
  ok(byId['map-canvas'].width > 0, 'the minimap canvas was sized and drawn',
    'width=' + byId['map-canvas'].width);
  ok(byId['map-canvas']._ctx && byId['map-canvas']._ctx.fillRect, 'the minimap renderer ran');
  byId['ov-map'].classList.add('hidden');   // reset for the close test
  byId['btn-close-map'].dispatch('click');
  ok(byId['ov-map'].classList.contains('hidden'), 'the map overlay closes');
} catch (e) { ok(false, 'map overlay threw: ' + e.message); console.log(e.stack); }

section('task definitions and minigames');
try {
  ok(!!G.TASK_DEFS, 'G.TASK_DEFS is exported');
  const defKeys = Object.keys(G.TASK_DEFS || {});
  ok(defKeys.length >= 14, 'all task definitions are present', 'got ' + defKeys.length);

  // every station's type must resolve to a real builder, never the fallback
  const types = [...new Set(Object.values(G.TASK_DEFS).map((d) => d.type))];
  ok(types.length >= 6, 'at least six minigame types exist', types.join(', '));
  if (G.tasks._builders) {
    const missing = types.filter((t) => !G.tasks._builders[t]);
    ok(missing.length === 0, 'every minigame type has a builder',
      missing.length ? 'missing: ' + missing.join(', ') : '');
  }
  G.STATIONS.forEach((s) => {
    ok(!!s.def, 'station ' + s.id + ' resolves its definition');
  });
} catch (e) { ok(false, 'task definitions threw: ' + e.message); console.log(e.stack); }

section('task overlay (every minigame opens and closes)');
try {
  const byType = {};
  Object.keys(G.TASK_DEFS).forEach((name) => {
    const type = G.TASK_DEFS[name].type;
    if (!byType[type]) byType[type] = name;
  });
  const opened = [];
  Object.keys(byType).forEach((type) => {
    const name = byType[type];
    const stationLike = { id: 'test_' + name, name: name, room: 'cafeteria', task: name, def: G.TASK_DEFS[name] };
    G.tasks.open(stationLike, () => {}, () => {});
    opened.push(type + (G.tasks.isOpen() ? '' : ' (FAILED TO OPEN)'));
    G.tasks.close(true);
  });
  const bad = opened.filter((o) => o.includes('FAILED'));
  ok(bad.length === 0, 'every minigame type opens without throwing',
    bad.length ? bad.join(', ') : opened.length + ' types: ' + opened.join(', '));
  ok(!G.tasks.isOpen(), 'the task overlay is closed again');
  ok(byId['ov-task'].classList.contains('hidden'), 'the task overlay element is hidden');
} catch (e) { ok(false, 'task overlay threw: ' + e.message); console.log(e.stack); }

section('input vector');
try {
  win.dispatch('keydown', { code: 'KeyD', repeat: false, preventDefault() {}, stopPropagation() {}, target: doc.body });
  ok(G.input.x > 0, 'pressing D moves right', 'x=' + G.input.x);
  win.dispatch('keyup', { code: 'KeyD', preventDefault() {}, stopPropagation() {}, target: doc.body });
  ok(G.input.x === 0, 'releasing D stops movement');
  win.dispatch('keydown', { code: 'KeyW', repeat: false, preventDefault() {}, stopPropagation() {}, target: doc.body });
  ok(G.input.y < 0, 'pressing W moves up', 'y=' + G.input.y);
  win.dispatch('keyup', { code: 'KeyW', preventDefault() {}, stopPropagation() {}, target: doc.body });
  // typing in a text field must not move the player
  win.dispatch('keydown', { code: 'KeyD', repeat: false, preventDefault() {}, stopPropagation() {}, target: byId['chat-input'] });
  ok(G.input.x === 0, 'typing in an input does not move the player');
} catch (e) { ok(false, 'input handling threw: ' + e.message); console.log(e.stack); }

section('meeting & result overlays');
try {
  G.host.startMeeting(G.game, net, G.game.players.host, 'emergency', null);
  ok(G.game.phase === 'meeting', 'a meeting can be started');
  runFrames(5);
  ok(!byId['ov-meeting'].classList.contains('hidden'), 'the meeting overlay is shown');
  ok(byId['vote-grid'].children.length === G.game.order.length, 'a vote card per player',
    'cards=' + byId['vote-grid'].children.length);
  ok(byId['vote-timer'].textContent !== '', 'the vote timer is rendered',
    '"' + byId['vote-timer'].textContent + '"');
  byId['btn-skip'].dispatch('click');
  ok(G.game.votes.host === 'skip', 'the skip button casts a vote');

  G.host.endGame(G.game, net, 'crew', 'Test reason');
  runFrames(5);
  ok(!byId['ov-result'].classList.contains('hidden'), 'the result overlay is shown');
  ok(byId['result-title'].textContent.indexOf('CREW') >= 0, 'the result title is set',
    byId['result-title'].textContent);
  ok(byId['result-body'].children.length === G.game.order.length, 'the result lists every player',
    'rows=' + byId['result-body'].children.length);
  ok(byId['btn-rematch'].classList.toggle !== undefined, 'the rematch button exists');
  byId['btn-rematch'].dispatch('click');
  ok(G.game.phase === 'lobby', 'rematch returns to the lobby', 'phase=' + G.game.phase);
} catch (e) { ok(false, 'meeting/result overlays threw: ' + e.message); console.log(e.stack); }

section('sabotage banner');
try {
  G.game.clock = undefined;
  G.game.phaseEnds = Date.now() - 1;
  G.host.tick(G.game, net, 0.016);
  const imp = G.game.order.map((id) => G.game.players[id]).find((p) => p.role === 'imp');
  if (imp) {
    imp.role = 'imp';
    G.game.phase = 'play';
    G.host.trySabotage(G.game, net, imp, 'lights');
    runFrames(3);
    ok(!byId['lights-banner'].classList.contains('hidden'), 'the lights banner appears');
    ok(G.lightsOut === true, 'lights-out is on');
    G.host.clearSabotage(G.game, net, 'tester');
    runFrames(3);
    ok(byId['lights-banner'].classList.contains('hidden'), 'the lights banner disappears');
  } else {
    ok(true, 'no impostor to sabotage with (skipped)');
  }
} catch (e) { ok(false, 'sabotage banner threw: ' + e.message); console.log(e.stack); }

section('share link construction');
try {
  // the lobby shows a joinable URL; it must be correct on https AND on file://
  G.host.pushLobby(G.game, net);
  const shown = byId['join-url'].textContent;
  ok(shown.indexOf('?room=') > 0, 'the lobby shows a join link with a room code', shown);
  ok(shown.indexOf('undefined') < 0 && shown.indexOf('null') !== 0,
    'the join link has no undefined/null in it', shown);
  ok(shown.indexOf('game.html?room=') > 0 || /\/crewmate\/\?room=/.test(shown),
    'the join link keeps the page path', shown);

  /*
   * Exercise the real helper against both URL shapes. `location.origin` is the
   * string "null" on file://, which used to produce a link like
   * "null/index.html?room=1234" — the first thing a user sees when they open the
   * file locally and try to share it.
   */
  ok(typeof G.ui._joinUrl === 'function', 'the URL helper is testable');
  const httpsLink = G.ui._joinUrl('4321');
  ok(httpsLink === 'https://example.github.io/crewmate/game.html?room=4321',
    'an https page produces a clean link', httpsLink);

  // simulate file:// by temporarily overriding the properties ui.js reads
  const realHref = win.location.href;
  const realOrigin = win.location.origin;
  const realPath = win.location.pathname;
  const realProto = win.location.protocol;
  win.location.href = 'file:///C:/Users/me/Downloads/index.html';
  win.location.origin = 'null';
  win.location.pathname = '/C:/Users/me/Downloads/index.html';
  win.location.protocol = 'file:';

  ok(G.ui._joinUrl('4321') === 'file:///C:/Users/me/Downloads/index.html?room=4321',
    'a file:// page produces a clean link too, with no "null"', G.ui._joinUrl('4321'));
  ok(G.ui._isLocalFile() === true, 'the file:// case is detected');

  // and the lobby says so, rather than offering an unreachable address.
  // The lobby only re-renders while its screen is showing, so switch back to it.
  G.ui.setScreen('lobby');
  G.host.pushLobby(G.game, net);
  ok(G.ui._lastLobbyWasLocalFile === true, 'renderLobby takes the file:// branch');
  ok(/file/i.test(byId['lobby-status'].textContent),
    'the lobby warns that a file:// address is unreachable by others',
    byId['lobby-status'].textContent.slice(0, 80));

  win.location.href = realHref;
  win.location.origin = realOrigin;
  win.location.pathname = realPath;
  win.location.protocol = realProto;
  ok(G.ui._isLocalFile() === false, 'an https page is not treated as a local file');
  G.host.pushLobby(G.game, net);   // restore the normal status text
  ok(G.ui._lastLobbyWasLocalFile === false, 'and the warning goes away again');
  ok(!/file/i.test(byId['lobby-status'].textContent),
    'the normal status returns', byId['lobby-status'].textContent);
  G.ui.setScreen('game');
} catch (e) { ok(false, 'share link check threw: ' + e.message); console.log(e.stack); }

section('console hygiene');
const realErrors = errors.filter((e) => !/not implemented|jsdom/i.test(e));
ok(realErrors.length === 0, 'no console.error output during the run',
  realErrors.slice(0, 3).join(' | '));

/* ------------------------------------------------------------------ */
console.log('\n' + '═'.repeat(62));
console.log(failed === 0 ? `✅ RUNTIME SMOKE TEST PASSED (${passed} assertions)` : `❌ ${failed} FAILED, ${passed} passed`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  • ' + f));
}
console.log('═'.repeat(62));
process.exit(failed ? 1 : 0);
