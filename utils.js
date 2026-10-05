/* ==========================================================================
   utils.js — tiny helpers, event bus, DOM shortcuts, toasts
   ========================================================================== */
(function (G) {
  'use strict';

  /* ---------------- DOM ------------------------------------------------ */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'style') node.setAttribute('style', attrs[k]);
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) node.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (ch) {
        if (ch === null || ch === undefined || ch === false) return;
        node.appendChild(typeof ch === 'string' ? document.createTextNode(ch) : ch);
      });
    }
    return node;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- event bus ------------------------------------------ */

  var handlers = {};
  function on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); return fn; }
  function off(type, fn) {
    if (!handlers[type]) return;
    handlers[type] = handlers[type].filter(function (h) { return h !== fn; });
  }
  function emit(type, payload) {
    var list = handlers[type];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); }
      catch (e) { console.error('[handler ' + type + ']', e); G.toast('Something went wrong.', 'err'); }
    }
  }

  /* ---------------- misc ----------------------------------------------- */

  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function dist(ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy); }
  function dist2(ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }
  function fmtTime(sec) {
    sec = Math.max(0, Math.ceil(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function sessionKey() {
    try {
      var k = localStorage.getItem('crewmate-sid');
      if (!k) {
        k = 'sid_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('crewmate-sid', k);
      }
      return k;
    } catch (e) {
      return 'sid_' + Math.random().toString(36).slice(2);
    }
  }

  /** Is this a touch-first device? Touch *capability* alone is not enough —
      Windows laptops report touch points, so we also require a coarse pointer. */
  function isMobileDevice() {
    var ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Windows Phone|webOS|BlackBerry|Opera Mini/i.test(ua)) return true;
    if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;     // iPadOS
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    var noHover = window.matchMedia && window.matchMedia('(hover: none)').matches;
    return !!(coarse && noHover && navigator.maxTouchPoints > 0);
  }

  /* ---------------- toasts --------------------------------------------- */

  var toastWrap = null;
  function toast(text, kind, ms) {
    if (!toastWrap) toastWrap = document.getElementById('toast-wrap');
    if (!toastWrap) return;
    var node = el('div', { class: 'toast' + (kind ? ' ' + kind : ''), text: text });
    toastWrap.appendChild(node);
    setTimeout(function () {
      node.style.transition = 'opacity .25s ease, transform .25s ease';
      node.style.opacity = '0';
      node.style.transform = 'translateY(-8px)';
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 260);
    }, ms || 2600);
  }

  /* ---------------- avatars -------------------------------------------- */

  var AVATAR_CACHE = {};

  /** Draw a little crewmate into an offscreen canvas; used by DOM avatars. */
  function crewmateDataUrl(color, size, dead) {
    size = size || 40;
    var key = color + '|' + size + '|' + (dead ? 'd' : 'a');
    if (AVATAR_CACHE[key]) return AVATAR_CACHE[key];
    var c = document.createElement('canvas');
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr; c.height = size * dpr;
    var g = c.getContext('2d');
    g.scale(dpr, dpr);
    G.drawCrewmate(g, size / 2, size / 2 + size * 0.06, size * 0.40, color, {
      dir: 1, moving: false, dead: !!dead, hat: null
    });
    var url = c.toDataURL();
    AVATAR_CACHE[key] = url;
    return url;
  }

  /* ---------------- fullscreen ----------------------------------------- */

  function requestFullscreen() {
    var d = document.documentElement;
    var fn = d.requestFullscreen || d.webkitRequestFullscreen || d.msRequestFullscreen;
    if (fn) { try { fn.call(d, { navigationUI: 'hide' }); } catch (e) { try { fn.call(d); } catch (e2) {} } }
    if (screen.orientation && screen.orientation.lock) {
      try { screen.orientation.lock('landscape').catch(function () {}); } catch (e) {}
    }
  }
  function exitFullscreen() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (fn && (document.fullscreenElement || document.webkitFullscreenElement)) {
      try { fn.call(document); } catch (e) {}
    }
  }
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  G.$ = $; G.$$ = $$; G.el = el; G.escapeHtml = escapeHtml;
  G.on = on; G.off = off; G.emit = emit;
  G.nowMs = nowMs; G.clamp = clamp; G.lerp = lerp;
  G.dist = dist; G.dist2 = dist2; G.fmtTime = fmtTime;
  G.shuffle = shuffle; G.pick = pick; G.sessionKey = sessionKey;
  G.isMobileDevice = isMobileDevice;
  G.toast = toast;
  G.crewmateDataUrl = crewmateDataUrl;
  G.requestFullscreen = requestFullscreen;
  G.exitFullscreen = exitFullscreen;
  G.isFullscreen = isFullscreen;

})(window.G = window.G || {});
