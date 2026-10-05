/* Shared Node-side shim so tests and debug scripts load the real game modules. */
const fs = require('fs');
const path = require('path');

function makeShim() {
  const noop = () => {};
  const elStub = () => ({
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    appendChild: noop, removeChild: noop, addEventListener: noop, removeEventListener: noop,
    setAttribute: noop, getAttribute: () => null, querySelector: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }),
    textContent: '', innerHTML: '', value: '', focus: noop, select: noop,
    children: [], parentNode: null, clientWidth: 100, clientHeight: 100, width: 100, height: 100,
    getContext: () => null, toDataURL: () => ''
  });
  const win = {
    performance: { now: () => Date.now() },
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addListener: noop, removeListener: noop }),
    navigator: { userAgent: 'node', maxTouchPoints: 0 },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { search: '', origin: 'http://localhost', pathname: '/', reload: noop },
    requestAnimationFrame: noop, cancelAnimationFrame: noop,
    screen: { orientation: null },
    document: {
      readyState: 'complete',
      documentElement: elStub(),
      body: elStub(),
      addEventListener: noop,
      createElement: elStub,
      createElementNS: elStub,
      createTextNode: (t) => ({ textContent: t }),
      getElementById: () => elStub(),
      querySelector: () => elStub(),
      querySelectorAll: () => [],
      exitFullscreen: noop,
      execCommand: noop
    },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Error, isNaN, parseInt, parseFloat,
    Uint8Array, URLSearchParams
  };
  win.window = win; win.self = win; win.globalThis = win;
  return win;
}

/**
 * Evaluate the game modules with `window` bound to the shim.
 *
 * The modules do `(function (G) { ... })(window.G = window.G || {})`. Inside a
 * compiled function the free variable `window` resolves to the real global
 * object, not the shim, and a bare assignment would leak. So we evaluate each
 * module with an explicit preamble that pins window.G to one shared object —
 * both on the shim and in the function's own scope.
 */
function loadModules(win, files) {
  win.G = win.G || {};
  for (const f of files) {
    const code = fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
    const wrapped = 'var window = arguments[0];\n' + code + '\n//# sourceURL=' + f;
    new Function('window', 'document', 'navigator', 'localStorage', 'location', 'screen',
      'requestAnimationFrame', 'cancelAnimationFrame', 'performance', wrapped)(
      win, win.document, win.navigator, win.localStorage, win.location, win.screen,
      win.requestAnimationFrame, win.cancelAnimationFrame, win.performance
    );
  }
  return win.G;
}

function makeNet() {
  const sent = [];
  const conns = {};
  const handlers = {};
  const raw = {
    code: '1234', role: 'host', connected: true,
    sendTo(id, msg) { sent.push({ to: id, msg }); return true; },
    broadcast(msg, skip) { sent.push({ to: '*', msg, skip }); return true; },
    sendToMany(ids, msg) { ids.forEach((i) => this.sendTo(i, msg)); },
    bindConn(id, conn) { conns[id] = conn; },
    unbindConn(id) { delete conns[id]; },
    kick(id) { delete conns[id]; },
    clientCount() { return Object.keys(conns).length; },
    on(t, f) { (handlers[t] = handlers[t] || []).push(f); return raw; },
    emit(t, p) { (handlers[t] || []).forEach((f) => f(p)); },
    destroy() {}
  };
  raw._sent = sent;
  raw._handlers = handlers;
  raw._to = (id) => sent.filter((s) => s.to === id).map((s) => s.msg);
  raw._clear = () => { sent.length = 0; };
  raw._kind = (kind) => sent.filter((s) => s.msg.kind === kind);
  return raw;
}

module.exports = { makeShim, loadModules, makeNet };
