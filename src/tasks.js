/* ==========================================================================
   tasks.js — task minigames and hold-to-complete interactions
   ========================================================================== */
(function (G) {
  'use strict';

  var api = {};
  G.tasks = api;
  var active = null;   // { station, onDone, cleanup }

  /* ------------------------------------------------------------------ */

  function overlayEls() {
    return {
      ov: document.getElementById('ov-task'),
      title: document.getElementById('task-title'),
      sub: document.getElementById('task-sub'),
      body: document.getElementById('task-body'),
      cancel: document.getElementById('btn-task-cancel')
    };
  }

  api.isOpen = function () { return !!active; };

  api.close = function (cancelled) {
    if (!active) return;
    var a = active;
    active = null;
    if (a.cleanup) { try { a.cleanup(); } catch (e) {} }
    var els = overlayEls();
    els.ov.classList.add('hidden');
    els.body.innerHTML = '';
    G.emit('task-overlay', false);
    if (cancelled && a.onCancel) a.onCancel();
  };

  /** Open the minigame for a station. onDone() is called when it is finished. */
  api.open = function (station, onDone, onCancel) {
    api.close(true);
    var els = overlayEls();
    els.title.textContent = station.name;
    els.sub.textContent = G.roomById[station.room] ? G.roomById[station.room].name : '';
    els.body.innerHTML = '';
    els.ov.classList.remove('hidden');
    G.emit('task-overlay', true);

    var def = station.def || G.TASK_DEFS[station.task];
    var type = def ? def.type : 'hold';

    function finish() {
      var cb = onDone;
      api.close(false);
      if (cb) cb();
    }

    active = {
      station: station, onDone: onDone, onCancel: onCancel,
      cleanup: null
    };

    var builder = BUILDERS[type] || BUILDERS.hold;
    var cleanup = builder(els.body, def || { name: station.name }, finish);
    if (typeof cleanup === 'function') active.cleanup = cleanup;
  };

  /* ====================================================================== */
  /*  builders                                                              */
  /* ====================================================================== */

  var BUILDERS = {};
  api._builders = BUILDERS;      // exposed so tests can assert coverage

  /* ---------------- hold ------------------------------------------------ */

  BUILDERS.hold = function (body, def, done) {
    var secs = def.secs || 3;
    var pct = G.el('div', { class: 'pct', text: '0%' });
    var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    var R = 56, C = 2 * Math.PI * R;
    circle.setAttribute('cx', '65'); circle.setAttribute('cy', '65'); circle.setAttribute('r', String(R));
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', 'rgba(79,209,197,0.18)');
    circle.setAttribute('stroke-width', '9');
    var arc = circle.cloneNode();
    arc.setAttribute('stroke', '#4fd1c5');
    arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('stroke-dasharray', String(C));
    arc.setAttribute('stroke-dashoffset', String(C));
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '130'); svg.setAttribute('height', '130');
    svg.appendChild(circle); svg.appendChild(arc);
    var ring = G.el('div', { class: 'hold-ring' }, [svg, pct]);

    var hint = G.el('p', { text: 'Hold the button to ' + (def.verb || 'work').toLowerCase() + '.', style: 'text-align:center' });
    var target = G.el('div', { class: 'hold-target', text: '✋' });

    body.appendChild(ring);
    body.appendChild(target);
    body.appendChild(hint);

    var held = false, progress = 0, raf = 0, last = G.nowMs(), finished = false;

    function loop() {
      raf = requestAnimationFrame(loop);
      var t = G.nowMs(), dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      if (held) progress += dt / secs;
      else progress = Math.max(0, progress - dt * 0.6);
      if (progress >= 1) {
        progress = 1;
        if (!finished) { finished = true; cancelAnimationFrame(raf); done(); }
      }
      arc.setAttribute('stroke-dashoffset', String(C * (1 - progress)));
      pct.textContent = Math.round(progress * 100) + '%';
    }
    raf = requestAnimationFrame(loop);

    function down(e) { e.preventDefault(); held = true; }
    function up() { held = false; }
    target.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    return function cleanup() {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  };

  /* ---------------- wiring ---------------------------------------------- */

  var WIRE_COLORS = ['#e8453c', '#132ed1', '#117f2d', '#ed54ba', '#f5f557', '#ef7d0d'];

  BUILDERS.wiring = function (body, def, done) {
    var n = 4;
    var cols = G.shuffle(WIRE_COLORS.slice()).slice(0, n);
    var left = G.shuffle(cols.slice());
    var right = G.shuffle(cols.slice());

    var wrap = G.el('div', { style: 'position:relative;padding:8px 0' });
    var panel = G.el('div', { class: 'wire-panel' });
    var colL = G.el('div', { class: 'wire-col' });
    var colR = G.el('div', { class: 'wire-col' });

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'wire-svg');
    svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
    svg.style.left = '0'; svg.style.top = '0';

    var leftNodes = [], rightNodes = [];
    left.forEach(function (color) {
      var nd = G.el('div', { class: 'wire-node', style: 'background:' + color, 'data-color': color });
      colL.appendChild(nd); leftNodes.push(nd);
    });
    right.forEach(function (color) {
      var nd = G.el('div', { class: 'wire-node', style: 'background:' + color, 'data-color': color });
      colR.appendChild(nd); rightNodes.push(nd);
    });

    panel.appendChild(colL);
    panel.appendChild(colR);
    wrap.appendChild(panel);
    wrap.appendChild(svg);
    body.appendChild(wrap);
    body.appendChild(G.el('p', { text: 'Connect each wire to the matching colour.', style: 'text-align:center' }));

    var selected = null;
    var matched = 0;
    var drawn = [];

    function drawWires() {
      svg.innerHTML = '';
      var sr = svg.getBoundingClientRect();
      var wr = wrap.getBoundingClientRect();
      if (!sr.width) return;
      drawn.forEach(function (pair) {
        var a = pair[0].getBoundingClientRect(), b = pair[1].getBoundingClientRect();
        var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', a.right - wr.left); line.setAttribute('y1', a.top + a.height / 2 - wr.top);
        line.setAttribute('x2', b.left - wr.left); line.setAttribute('y2', b.top + b.height / 2 - wr.top);
        line.setAttribute('stroke', pair[2]);
        line.setAttribute('stroke-width', '5');
        line.setAttribute('stroke-linecap', 'round');
        svg.appendChild(line);
      });
    }

    function select(node) {
      if (node.classList.contains('done')) return;
      if (!selected) {
        selected = node;
        node.classList.add('sel');
        return;
      }
      if (selected === node) { selected.classList.remove('sel'); selected = null; return; }
      var sameCol = (leftNodes.indexOf(selected) >= 0) === (leftNodes.indexOf(node) >= 0);
      if (sameCol) {
        selected.classList.remove('sel');
        selected = node;
        node.classList.add('sel');
        return;
      }
      var a = selected, b = node;
      if (a.dataset.color === b.dataset.color) {
        var color = a.dataset.color;
        a.classList.remove('sel');
        a.classList.add('done'); b.classList.add('done');
        drawn.push([a, b, color]);
        selected = null;
        matched++;
        drawWires();
        if (matched === n) setTimeout(done, 260);
      } else {
        a.classList.remove('sel');
        selected = null;
        b.classList.add('sel');
        selected = b;
      }
    }

    function onClick(e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains('wire-node')) select(t);
    }
    panel.addEventListener('click', onClick);
    window.addEventListener('resize', drawWires);
    var t0 = setTimeout(drawWires, 30);

    return function cleanup() {
      clearTimeout(t0);
      panel.removeEventListener('click', onClick);
      window.removeEventListener('resize', drawWires);
    };
  };

  /* ---------------- swipe card ------------------------------------------ */

  BUILDERS.swipe = function (body, def, done) {
    var track = G.el('div', { class: 'swipe-track' });
    var card = G.el('div', { class: 'swipe-card', text: '🪪' });
    var target = G.el('div', { class: 'swipe-target' });
    track.appendChild(target);
    track.appendChild(card);
    body.appendChild(track);
    body.appendChild(G.el('p', { text: 'Drag the card to the green strip — in one smooth motion.', style: 'text-align:center' }));

    var dragging = false, startX = 0, x = 8, samples = [], startT = 0, finished = false;
    var MAX = 0;

    function layout() { MAX = track.clientWidth - card.offsetWidth - 12; }
    layout();
    window.addEventListener('resize', layout);

    function down(e) {
      dragging = true;
      card.classList.add('dragging');
      startX = e.clientX - x;
      samples = []; startT = G.nowMs();
      card.setPointerCapture && card.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
    function move(e) {
      if (!dragging) return;
      x = G.clamp(e.clientX - startX, 0, Math.max(1, MAX));
      card.style.left = (x + 4) + 'px';
      samples.push({ x: x, t: G.nowMs() });
      if (samples.length > 24) samples.shift();
      e.preventDefault();
    }
    function up() {
      if (!dragging) return;
      dragging = false;
      card.classList.remove('dragging');
      var travelled = x;
      var dur = G.nowMs() - startT;
      var speed = dur > 0 ? travelled / dur : 0;      // px per ms
      var reached = x >= MAX - 8;
      var smooth = speed > 0.32;                       // must be a fast swipe
      if (reached && smooth && !finished) {
        finished = true;
        card.style.left = (MAX + 4) + 'px';
        setTimeout(done, 260);
      } else {
        x = 8; card.style.left = '8px';
      }
    }

    card.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    return function cleanup() {
      window.removeEventListener('resize', layout);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  };

  /* ---------------- download -------------------------------------------- */

  BUILDERS.download = function (body, def, done) {
    var wrap = G.el('div', { class: 'download-bars' });
    var bars = [];
    for (var i = 0; i < 3; i++) {
      var fill = G.el('i');
      var label = G.el('span', { text: 'STANDBY' });
      var bar = G.el('div', { class: 'dlbar' }, [fill, label]);
      wrap.appendChild(bar);
      bars.push({ fill: fill, label: label, p: 0, active: false });
    }
    body.appendChild(wrap);
    body.appendChild(G.el('p', { text: 'Downloading data. Keep this screen open.', style: 'text-align:center' }));

    var raf = 0, idx = 0, last = G.nowMs(), finished = false, holdT = 0;

    function loop() {
      raf = requestAnimationFrame(loop);
      var t = G.nowMs(), dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      holdT += dt;
      if (idx < bars.length) {
        var b = bars[idx];
        b.p = Math.min(1, b.p + dt / 1.4);
        b.fill.style.width = (b.p * 100) + '%';
        b.label.textContent = Math.round(b.p * 100) + '%';
        if (b.p >= 1) {
          b.label.textContent = 'DONE';
          idx++;
        }
      } else if (!finished) {
        finished = true;
        cancelAnimationFrame(raf);
        setTimeout(done, 300);
      }
    }
    raf = requestAnimationFrame(loop);
    return function () { cancelAnimationFrame(raf); };
  };

  /* ---------------- asteroids ------------------------------------------- */

  BUILDERS.asteroids = function (body, def, done) {
    var field = G.el('div', { class: 'asteroid-field' });
    body.appendChild(field);
    var counter = G.el('p', { style: 'text-align:center', text: 'Destroy 10 asteroids — tap to shoot.' });
    body.appendChild(counter);

    var rocks = [], shots = 0, hits = 0, target = 10, raf = 0, last = G.nowMs(), spawnAcc = 0, finished = false;

    function spawn() {
      var size = 24 + Math.random() * 26;
      var node = G.el('div', { class: 'rock' });
      node.style.width = node.style.height = size + 'px';
      var x = Math.random() * Math.max(1, field.clientWidth - size);
      node.style.left = x + 'px';
      node.style.top = '-60px';
      field.appendChild(node);
      rocks.push({ node: node, x: x, y: -60, vy: 55 + Math.random() * 60, size: size, dx: (Math.random() - 0.5) * 40 });
    }

    function loop() {
      raf = requestAnimationFrame(loop);
      var t = G.nowMs(), dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      spawnAcc += dt;
      if (spawnAcc > 0.75) { spawnAcc = 0; spawn(); }
      var H = field.clientHeight;
      for (var i = rocks.length - 1; i >= 0; i--) {
        var r = rocks[i];
        r.y += r.vy * dt;
        r.x += r.dx * dt;
        r.x = G.clamp(r.x, -10, field.clientWidth - r.size + 10);
        r.node.style.top = r.y + 'px';
        r.node.style.left = r.x + 'px';
        if (r.y > H) { field.removeChild(r.node); rocks.splice(i, 1); }
      }
      counter.textContent = 'Destroyed ' + hits + ' / ' + target + ' — accuracy ' +
        (shots ? Math.round(hits / shots * 100) : 100) + '%';
    }
    raf = requestAnimationFrame(loop);

    function shoot(e) {
      var rect = field.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      shots++;
      var hit = null;
      for (var i = rocks.length - 1; i >= 0; i--) {
        var r = rocks[i];
        var cx = r.x + r.size / 2, cy = r.y + r.size / 2;
        if (G.dist(mx, my, cx, cy) <= r.size / 2 + 10) { hit = r; break; }
      }
      var mark = G.el('div', { class: 'cross', text: hit ? '💥' : '✳️' });
      mark.style.left = mx + 'px'; mark.style.top = my + 'px';
      field.appendChild(mark);
      setTimeout(function () { if (mark.parentNode) mark.parentNode.removeChild(mark); }, 320);
      if (hit) {
        hits++;
        if (hit.node.parentNode) hit.node.parentNode.removeChild(hit.node);
        rocks.splice(rocks.indexOf(hit), 1);
        if (hits >= target && !finished) {
          finished = true;
          cancelAnimationFrame(raf);
          setTimeout(done, 260);
        }
      }
    }
    field.addEventListener('pointerdown', shoot);

    return function cleanup() {
      cancelAnimationFrame(raf);
      field.removeEventListener('pointerdown', shoot);
    };
  };

  /* ---------------- simon / calibrate ----------------------------------- */

  BUILDERS.simon = function (body, def, done) {
    var PADS = ['#e8453c', '#132ed1', '#117f2d', '#f5f557'];
    var grid = G.el('div', { class: 'simon-grid' });
    var pads = PADS.map(function (color) {
      var p = G.el('div', { class: 'simon-pad', style: 'background:' + color + ';color:' + color });
      grid.appendChild(p);
      return p;
    });
    body.appendChild(grid);
    var status = G.el('p', { style: 'text-align:center', text: 'Watch the sequence.' });
    body.appendChild(status);

    var seq = [], input = [], playing = true, finished = false, timers = [];

    function later(fn, ms) { var id = setTimeout(fn, ms); timers.push(id); return id; }

    function nextRound() {
      seq.push(Math.floor(Math.random() * 4));
      input = [];
      playing = true;
      status.textContent = 'Watch the sequence.';
      seq.forEach(function (idx, i) {
        later(function () {
          pads[idx].classList.add('lit');
          later(function () { pads[idx].classList.remove('lit'); }, 320);
        }, 420 + i * 560);
      });
      later(function () {
        playing = false;
        status.textContent = 'Repeat the sequence (' + seq.length + ' steps).';
      }, 480 + seq.length * 560);
    }

    function tap(i) {
      if (playing || finished) return;
      pads[i].classList.add('lit');
      later(function () { pads[i].classList.remove('lit'); }, 180);
      input.push(i);
      var k = input.length - 1;
      if (input[k] !== seq[k]) {
        status.textContent = 'Wrong! Starting over…';
        playing = true;
        later(function () { seq = []; nextRound(); }, 800);
        return;
      }
      if (input.length === seq.length) {
        if (seq.length >= 5) {
          finished = true;
          status.textContent = 'Calibrated!';
          later(done, 400);
          return;
        }
        playing = true;
        status.textContent = 'Correct!';
        later(nextRound, 800);
      }
    }

    pads.forEach(function (p, i) { p.addEventListener('pointerdown', function () { tap(i); }); });

    later(nextRound, 500);

    return function cleanup() { timers.forEach(clearTimeout); };
  };

  /* ---------------- prime (press every button) -------------------------- */

  BUILDERS.prime = function (body, def, done) {
    var count = 8;
    var row = G.el('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0' });
    var left = count, finished = false;
    var counter = G.el('p', { style: 'text-align:center', text: 'Press all ' + count + ' buttons.' });
    for (var i = 0; i < count; i++) {
      (function () {
        var b = G.el('div', {
          style: 'aspect-ratio:1/1;border-radius:12px;background:linear-gradient(180deg,#3b82f6,#1d4ed8);' +
            'border:3px solid rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;font-size:22px;cursor:pointer',
          text: '⬤',
          onpointerdown: function () {
            if (b.dataset.done) return;
            b.dataset.done = '1';
            b.style.background = 'linear-gradient(180deg,#22c55e,#15803d)';
            b.textContent = '✔';
            left--;
            counter.textContent = left ? (left + ' button' + (left === 1 ? '' : 's') + ' left.') : 'All primed!';
            if (!left && !finished) { finished = true; setTimeout(done, 320); }
          }
        });
        row.appendChild(b);
      })();
    }
    body.appendChild(counter);
    body.appendChild(row);
  };

  /* ---------------- generic fallback ------------------------------------ */

  BUILDERS.fallback = function (body, def, done) {
    body.appendChild(G.el('p', { style: 'text-align:center', text: 'This task needs no work right now.' }));
    var b = G.el('button', { class: 'btn primary', text: 'Complete', onclick: done });
    body.appendChild(b);
  };

})(window.G = window.G || {});
