/* ==========================================================================
   main.js — boot
   ========================================================================== */
(function (G) {
  'use strict';

  G.lightsOut = false;
  G.lobbyState = null;
  G.VERSION = '1.0.0';

  var CDN_FALLBACK = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';

  /**
   * PeerJS ships inside the bundle. If it is somehow unavailable (someone
   * stripped vendor.js, or a very old browser failed to evaluate it) try the
   * CDN once so the game still works rather than silently doing nothing.
   */
  function ensurePeer(done) {
    if (typeof window.Peer !== 'undefined') { done(true); return; }
    console.warn('[crewmate] PeerJS missing from the bundle — falling back to the CDN');
    var s = document.createElement('script');
    s.src = CDN_FALLBACK;
    s.onload = function () {
      G.PeerAvailable = typeof window.Peer !== 'undefined';
      G.emit('peer-ready', G.PeerAvailable);
      done(G.PeerAvailable);
    };
    s.onerror = function () {
      G.emit('peer-ready', false);
      done(false);
    };
    document.head.appendChild(s);
  }

  function boot() {
    // landscape + fullscreen helpers on the first real interaction (mobile
    // browsers only grant these inside a user gesture)
    var once = function () {
      if (G.isMobileDevice()) {
        G.requestFullscreen();
        document.body.classList.add('touch');
      }
      window.removeEventListener('pointerdown', once);
    };
    window.addEventListener('pointerdown', once);

    ensurePeer(function () {
      G.ui.start();
      document.body.classList.add('ready');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.addEventListener('error', function (e) {
    if (e && e.message) console.error('[crewmate]', e.message);
  });

  window.addEventListener('unhandledrejection', function (e) {
    console.warn('[crewmate] unhandled promise', e && e.reason);
  });

})(window.G = window.G || {});
