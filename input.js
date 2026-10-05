/* ==========================================================================
   input.js — unified input: keyboard + mouse for desktop, virtual joystick
   and on-screen action buttons for touch devices.
   ========================================================================== */
(function (G) {
  'use strict';

  var input = {
    x: 0, y: 0,
    touchMode: false,
    keys: {},
    /* these are set by ui.js so input can trigger game actions */
    actions: {
      use: null, kill: null, report: null, vent: null,
      meeting: null, map: null, emergency: null
    },
    enabled: true
  };
  G.input = input;

  var POINTER_KEY_MAP = {
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right'
  };

  /* ====================================================================== */
  /*  keyboard                                                              */
  /* ====================================================================== */

  function rebuildVectorFromKeys() {
    if (input.touchMode && input.joyActive) return;
    var x = 0, y = 0;
    if (input.keys.up) y -= 1;
    if (input.keys.down) y += 1;
    if (input.keys.left) x -= 1;
    if (input.keys.right) x += 1;
    var len = Math.sqrt(x * x + y * y);
    if (len > 1) { x /= len; y /= len; }
    input.x = x; input.y = y;
  }

  function isTypingTarget(t) {
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }

  window.addEventListener('keydown', function (e) {
    if (isTypingTarget(e.target)) {
      if (e.key === 'Enter' && e.target.id === 'chat-input') {
        e.preventDefault();
        if (input.actions.sendChat) input.actions.sendChat();
      }
      return;
    }
    if (e.repeat) {
      if (POINTER_KEY_MAP[e.code]) e.preventDefault();
      return;
    }
    var mapped = POINTER_KEY_MAP[e.code];
    if (mapped) {
      input.keys[mapped] = true;
      rebuildVectorFromKeys();
      e.preventDefault();
      return;
    }
    switch (e.code) {
      case 'KeyE': if (input.actions.use) input.actions.use(); e.preventDefault(); break;
      case 'KeyQ': if (input.actions.kill) input.actions.kill(); e.preventDefault(); break;
      case 'KeyR': if (input.actions.report) input.actions.report(); e.preventDefault(); break;
      case 'KeyV': if (input.actions.vent) input.actions.vent(); e.preventDefault(); break;
      case 'KeyM': if (input.actions.map) input.actions.map(); e.preventDefault(); break;
      case 'Space': if (input.actions.meeting) input.actions.meeting(); e.preventDefault(); break;
      case 'Escape': if (input.actions.escape) input.actions.escape(); break;
      case 'Enter': if (input.actions.enter) { input.actions.enter(); e.preventDefault(); } break;
    }
  });

  window.addEventListener('keyup', function (e) {
    var mapped = POINTER_KEY_MAP[e.code];
    if (mapped) {
      input.keys[mapped] = false;
      rebuildVectorFromKeys();
      e.preventDefault();
    }
  });

  window.addEventListener('blur', function () {
    input.keys = {};
    input.x = input.y = 0;
    input.joyActive = false;
    resetNub();
  });

  /* ====================================================================== */
  /*  virtual joystick                                                      */
  /* ====================================================================== */

  var joyEl = null, nubEl = null;
  var joyPointerId = null;
  var joyCenter = { x: 0, y: 0 };
  var JOY_MAX = 46;

  function resetNub() {
    if (nubEl) nubEl.style.transform = 'translate(0px, 0px)';
  }

  function setJoyFromPoint(clientX, clientY) {
    var dx = clientX - joyCenter.x, dy = clientY - joyCenter.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    var maxLen = JOY_MAX;
    var clamped = Math.min(len, maxLen);
    var nx = len > 0.0001 ? dx / len : 0;
    var ny = len > 0.0001 ? dy / len : 0;
    if (nubEl) nubEl.style.transform = 'translate(' + (nx * clamped) + 'px,' + (ny * clamped) + 'px)';
    var mag = maxLen > 0 ? clamped / maxLen : 0;
    // inner dead zone so a resting thumb does not drift
    if (mag < 0.16) { input.x = 0; input.y = 0; return; }
    var scaled = (mag - 0.16) / 0.84;
    input.x = nx * scaled;
    input.y = ny * scaled;
  }

  function initJoystick() {
    joyEl = document.getElementById('joystick');
    nubEl = document.getElementById('joy-nub');
    if (!joyEl) return;

    joyEl.addEventListener('pointerdown', function (e) {
      if (joyPointerId !== null) return;
      joyPointerId = e.pointerId;
      joyEl.classList.add('active');
      var r = joyEl.getBoundingClientRect();
      joyCenter.x = r.left + r.width / 2;
      joyCenter.y = r.top + r.height / 2;
      JOY_MAX = r.width * 0.31;
      try { joyEl.setPointerCapture(e.pointerId); } catch (err) {}
      setJoyFromPoint(e.clientX, e.clientY);
      e.preventDefault();
      e.stopPropagation();
    });

    joyEl.addEventListener('pointermove', function (e) {
      if (e.pointerId !== joyPointerId) return;
      setJoyFromPoint(e.clientX, e.clientY);
      e.preventDefault();
      e.stopPropagation();
    });

    function release(e) {
      if (e.pointerId !== joyPointerId) return;
      joyPointerId = null;
      joyEl.classList.remove('active');
      input.x = input.y = 0;
      resetNub();
      e.preventDefault();
    }
    joyEl.addEventListener('pointerup', release);
    joyEl.addEventListener('pointercancel', release);
    joyEl.addEventListener('pointerleave', function (e) {
      if (joyPointerId === null) return;
      // keep control captured, but stop the vector if the finger leaves
      input.x = input.y = 0;
      resetNub();
    });
  }

  /** Enable touch mode: show the joystick and hide desktop-only hints. */
  input.enableTouch = function (on) {
    input.touchMode = !!on;
    document.body.classList.toggle('touch', !!on);
    if (on && !joyEl) initJoystick();
  };

  /* ---------------- landscape prompt / viewport ------------------------- */

  function updateViewportHeight() {
    document.documentElement.style.setProperty('--vh', (window.innerHeight * 0.01) + 'px');
  }
  window.addEventListener('resize', updateViewportHeight);
  window.addEventListener('orientationchange', function () {
    setTimeout(updateViewportHeight, 220);
  });
  updateViewportHeight();

  /* ---------------- prevent page gestures ------------------------------- */

  document.addEventListener('touchmove', function (e) {
    if (e.target.closest && e.target.closest('.screen, .overlay, .card, .chat-log, .players, #hud')) return;
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  document.addEventListener('contextmenu', function (e) {
    if (e.target.tagName === 'CANVAS' || e.target.closest('#hud')) e.preventDefault();
  });

  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });

  document.addEventListener('dblclick', function (e) {
    if (e.target.tagName === 'CANVAS') e.preventDefault();
  }, { passive: false });

  /* ---------------- boot ------------------------------------------------- */

  initJoystick();

  G.on('app-ready', function () {
    initJoystick();
    updateViewportHeight();
  });

})(window.G = window.G || {});
