/* ==========================================================================
   audio.js — procedural sound effects using the Web Audio API.
   ---------------------------------------------------------------------------
   No asset files: every sound is synthesised from oscillators at runtime, so
   the game stays a single self-contained HTML file.

   Browsers block audio until the user interacts with the page, so the context
   is created lazily on the first sound request that follows a real gesture.
   ========================================================================== */
(function (G) {
  'use strict';

  var STORE_KEY = 'crewmate-muted';

  var audio = {
    enabled: true,
    ready: false
  };
  G.audio = audio;

  var ctx = null;
  var master = null;
  var failed = false;

  /* ---------------- lifecycle ------------------------------------------ */

  function loadMuted() {
    try { return localStorage.getItem(STORE_KEY) === '1'; } catch (e) { return false; }
  }

  audio.muted = loadMuted();

  function saveMuted() {
    try { localStorage.setItem(STORE_KEY, audio.muted ? '1' : '0'); } catch (e) {}
  }

  function ensureContext() {
    if (failed || ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { failed = true; return null; }
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      audio.ready = true;
    } catch (e) {
      failed = true;
      ctx = null;
    }
    return ctx;
  }

  /** Resume a suspended context — must happen inside a user gesture. */
  audio.unlock = function () {
    var c = ensureContext();
    if (!c) return;
    if (c.state === 'suspended' && c.resume) {
      c.resume().catch(function () {});
    }
  };

  audio.setMuted = function (muted) {
    audio.muted = !!muted;
    saveMuted();
    if (master) master.gain.value = audio.muted ? 0 : 0.5;
    G.emit('mute-changed', audio.muted);
  };

  audio.toggleMute = function () {
    audio.setMuted(!audio.muted);
    if (!audio.muted) audio.blip(660, 0.09, 'square', 0.16);
    return audio.muted;
  };

  /* ---------------- primitives ----------------------------------------- */

  /**
   * One note.
   *   freq     starting frequency in Hz
   *   dur      seconds
   *   type     oscillator wave
   *   gain     peak gain (0..1)
   *   freqTo   optional glide target
   *   delay    seconds to wait before starting
   */
  function tone(freq, dur, type, gain, freqTo, delay) {
    if (!audio.enabled || audio.muted) return;
    var c = ensureContext();
    if (!c) return;
    if (c.state === 'suspended' && c.resume) c.resume().catch(function () {});

    var t0 = c.currentTime + (delay || 0);
    var osc = c.createOscillator();
    var env = c.createGain();

    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (freqTo && osc.frequency.exponentialRampToValueAtTime) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), t0 + dur);
    }

    // short attack, exponential decay — reads as a "blip" rather than a click
    var peak = gain === undefined ? 0.18 : gain;
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.02, dur * 0.25));
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(env);
    env.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  /** Filtered white noise — used for impacts and whooshes. */
  function noise(dur, gain, filterHz, sweepTo, delay) {
    if (!audio.enabled || audio.muted) return;
    var c = ensureContext();
    if (!c) return;

    var t0 = c.currentTime + (delay || 0);
    var frames = Math.max(1, Math.floor(c.sampleRate * dur));
    var buffer = c.createBuffer(1, frames, c.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < frames; i++) {
      // decaying noise
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }
    var src = c.createBufferSource();
    src.buffer = buffer;

    var filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterHz || 900, t0);
    if (sweepTo && filter.frequency.exponentialRampToValueAtTime) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), t0 + dur);
    }

    var env = c.createGain();
    env.gain.setValueAtTime(gain === undefined ? 0.22 : gain, t0);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filter);
    filter.connect(env);
    env.connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  audio.tone = tone;
  audio.noise = noise;
  audio.blip = tone;

  /* ---------------- the actual sound set ------------------------------- */

  var SOUNDS = {
    /** UI: a soft click for any button. */
    click: function () { tone(520, 0.05, 'triangle', 0.10); },

    /** You were given a task. */
    taskDone: function () {
      tone(660, 0.09, 'triangle', 0.16);
      tone(880, 0.11, 'triangle', 0.15, null, 0.08);
      tone(1180, 0.13, 'triangle', 0.12, null, 0.16);
    },

    /** A task belongs to someone else / not allowed. */
    denied: function () {
      tone(220, 0.14, 'square', 0.11);
      tone(165, 0.18, 'square', 0.11, null, 0.1);
    },

    /** You stabbed someone. */
    kill: function () {
      noise(0.26, 0.3, 1400, 160);
      tone(150, 0.3, 'sawtooth', 0.2, 55);
    },

    /** A body was reported / meeting called. */
    meeting: function () {
      tone(880, 0.16, 'square', 0.16);
      tone(660, 0.16, 'square', 0.15, null, 0.17);
      tone(880, 0.22, 'square', 0.16, null, 0.34);
    },

    /** Someone was ejected. */
    eject: function () {
      noise(0.7, 0.26, 2200, 120);
      tone(420, 0.7, 'sine', 0.14, 90);
    },

    /** The lights went out. */
    sabotage: function () {
      tone(500, 0.16, 'sawtooth', 0.16, 160);
      tone(300, 0.3, 'sawtooth', 0.13, 90, 0.12);
    },

    /** Lights restored. */
    repair: function () {
      tone(440, 0.1, 'triangle', 0.15);
      tone(660, 0.1, 'triangle', 0.14, null, 0.09);
      tone(880, 0.16, 'triangle', 0.13, null, 0.18);
    },

    /** Kill is available again. */
    killReady: function () { tone(1040, 0.07, 'square', 0.10); },

    /** Countdown warning. */
    tick: function () { tone(880, 0.045, 'square', 0.07); },

    /** Round won. */
    win: function () {
      [523, 659, 784, 1046].forEach(function (f, i) {
        tone(f, 0.22, 'triangle', 0.17, null, i * 0.13);
      });
    },

    /** Round lost. */
    lose: function () {
      [392, 330, 262, 196].forEach(function (f, i) {
        tone(f, 0.3, 'sawtooth', 0.13, null, i * 0.17);
      });
    },

    /** A player joined the lobby. */
    join: function () {
      tone(700, 0.07, 'sine', 0.11);
      tone(1000, 0.09, 'sine', 0.10, null, 0.06);
    },

    /** Error / cannot do that. */
    error: function () { tone(180, 0.2, 'square', 0.13); },

    /** Chat message arrives. */
    chat: function () { tone(1500, 0.035, 'sine', 0.06); },

    /** Vent in / out. */
    vent: function () {
      noise(0.3, 0.22, 500, 2600);
      tone(200, 0.24, 'triangle', 0.12, 700);
    }
  };

  audio.play = function (name) {
    var fn = SOUNDS[name];
    if (!fn) return;
    try { fn(); } catch (e) { /* never let audio break the game */ }
  };

  audio.names = function () { return Object.keys(SOUNDS); };

  /* ---------------- unlock on the first gesture ------------------------ */

  function firstGesture() {
    audio.unlock();
    window.removeEventListener('pointerdown', firstGesture);
    window.removeEventListener('keydown', firstGesture);
    window.removeEventListener('touchstart', firstGesture);
  }
  window.addEventListener('pointerdown', firstGesture);
  window.addEventListener('keydown', firstGesture);
  window.addEventListener('touchstart', firstGesture);

})(window.G = window.G || {});
