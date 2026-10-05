/* ==========================================================================
   render.js — canvas renderer for the ship, players and effects
   ========================================================================== */
(function (G) {
  'use strict';

  var render = {};
  G.render = render;

  render.canvas = null;
  render.ctx = null;
  render.dpr = 1;
  render.cam = { x: 0, y: 0, zoom: 1, w: 0, h: 0 };
  render.effects = [];       // floating texts / puffs
  render.fps = 0;

  /* ------------------------------------------------------------------ */

  render.init = function (canvas) {
    render.canvas = canvas;
    render.ctx = canvas.getContext('2d');
    render.resize();
    render.buildFloor();
    window.addEventListener('resize', render.resize);
    window.addEventListener('orientationchange', function () { setTimeout(render.resize, 220); });
  };

  /* ------------------------------------------------------------------ */
  /*  static floor: rooms + the exact collision surface                  */
  /* ------------------------------------------------------------------ */

  /*
   * The ship is painted once into an offscreen canvas. Solid cells are drawn
   * from the very same field the collision uses, so the wall you see is the
   * wall you bump into — no invisible edges and no floor that cannot be walked.
   */
  render.buildFloor = function () {
    var W = G.WORLD_W, H = G.WORLD_H;
    var pad = 48;
    var c = document.createElement('canvas');
    c.width = W + pad * 2;
    c.height = H + pad * 2;
    var g = c.getContext('2d');
    if (!g) return;

    var OX = pad, OY = pad;
    g.translate(OX, OY);

    // 1. the void around the ship
    g.fillStyle = 'rgba(4, 7, 13, 0.92)';
    g.fillRect(-pad, -pad, W + pad * 2, H + pad * 2);

    // 2. floor plate under everything the player can walk on
    g.fillStyle = '#121b2e';
    g.fillRect(0, 0, W, H);

    // 3. room tints
    for (var i = 0; i < G.ROOMS.length; i++) {
      var room = G.ROOMS[i];
      g.fillStyle = room.color;
      g.fillRect(room.r.x, room.r.y, room.r.w, room.r.h);
    }

    // 4. the solid surface, drawn on the same lattice as the collision grid
    var CELL = 16;
    g.fillStyle = '#22304e';
    for (var y = 0; y * CELL < H; y++) {
      var x = 0;
      while (x * CELL < W) {
        if (!G.isSolidAt(x * CELL + CELL / 2, y * CELL + CELL / 2)) { x++; continue; }
        var run = x;
        while (run * CELL < W && G.isSolidAt(run * CELL + CELL / 2, y * CELL + CELL / 2)) run++;
        g.fillRect(x * CELL, y * CELL, (run - x) * CELL, CELL);
        x = run;
      }
    }

    // 5. grout lines where solid meets open, plus a lit top edge
    g.lineWidth = 2;
    for (var gy = 0; gy * CELL < H; gy++) {
      for (var gx = 0; gx * CELL < W; gx++) {
        var px = gx * CELL + CELL / 2, py = gy * CELL + CELL / 2;
        if (!G.isSolidAt(px, py)) {
          if (G.isSolidAt(px, py + CELL)) {
            g.fillStyle = 'rgba(120,165,230,0.28)';
            g.fillRect(gx * CELL, gy * CELL + CELL - 2, CELL, 2);
          }
          continue;
        }
        // solid: draw an edge only where it borders open space
        var openBelow = !G.isSolidAt(px, py + CELL) && gy * CELL + CELL < H;
        var openAbove = !G.isSolidAt(px, py - CELL) && gy > 0;
        var openLeft = !G.isSolidAt(px - CELL, py) && gx > 0;
        var openRight = !G.isSolidAt(px + CELL, py) && gx * CELL + CELL < W;
        g.fillStyle = 'rgba(150,190,255,0.26)';
        if (openBelow) g.fillRect(gx * CELL, gy * CELL + CELL - 2, CELL, 2);
        if (openAbove) g.fillRect(gx * CELL, gy * CELL, CELL, 3);
        if (openLeft) g.fillRect(gx * CELL, gy * CELL, 2, CELL);
        if (openRight) g.fillRect(gx * CELL + CELL - 2, gy * CELL, 2, CELL);
      }
    }

    // 6. room labels and inner outlines
    for (var k = 0; k < G.ROOMS.length; k++) {
      var r2 = G.ROOMS[k];
      g.fillStyle = 'rgba(200,220,255,0.30)';
      g.font = '700 24px "Segoe UI", system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(r2.name.toUpperCase(), r2.cx, r2.r.y + 30);
    }

    g.setTransform(1, 0, 0, 1, 0, 0);
    render.floorCanvas = c;
    render.floorPad = pad;
  };

  render.resize = function () {
    var c = render.canvas;
    if (!c) return;
    var dpr = Math.min(2.5, window.devicePixelRatio || 1);
    render.dpr = dpr;
    var w = c.clientWidth || window.innerWidth;
    var h = c.clientHeight || window.innerHeight;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    render.cam.w = w; render.cam.h = h;
    // keep a consistent amount of the world visible on every screen size
    var base = Math.min(w, h);
    render.cam.zoom = G.clamp(base / 560, 0.62, 1.35);
  };

  render.screenToWorld = function (sx, sy) {
    var cam = render.cam;
    return {
      x: (sx - cam.w / 2) / cam.zoom + cam.x,
      y: (sy - cam.h / 2) / cam.zoom + cam.y
    };
  };

  /* ------------------------------------------------------------------ */
  /*  crewmate sprite                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Draw a crewmate centred at (x, y).
   * r      = half the body height (so the sprite is about 2r tall)
   * opts   = { dir, moving, dead, ghost, alpha, outline, visor }
   */
  G.drawCrewmate = function (ctx, x, y, r, color, opts) {
    opts = opts || {};
    var dir = opts.dir >= 0 ? 1 : -1;
    var dead = !!opts.dead;
    var alpha = opts.alpha === undefined ? 1 : opts.alpha;

    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(x, y);
    ctx.scale(dir, 1);

    var bodyW = r * 1.42, bodyH = r * 1.86;

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.beginPath();
    ctx.ellipse(0, bodyH * 0.54, bodyW * 0.62, bodyH * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();

    if (opts.outline) {
      ctx.save();
      ctx.shadowColor = opts.outline;
      ctx.shadowBlur = r * 0.85;
      ctx.restore();
    }

    if (dead) {
      // a slumped corpse
      ctx.rotate(Math.PI / 2.4);
    }

    // legs
    var legSwing = opts.moving ? Math.sin(G.nowMs() * 0.014) * r * 0.22 : 0;
    ctx.fillStyle = darken(color, 0.30);
    roundRect(ctx, -bodyW * 0.52, bodyH * 0.30 + Math.max(0, legSwing), bodyW * 0.36, bodyH * 0.34, r * 0.16);
    ctx.fill();
    roundRect(ctx, bodyW * 0.16, bodyH * 0.30 + Math.max(0, -legSwing), bodyW * 0.36, bodyH * 0.34, r * 0.16);
    ctx.fill();

    // backpack
    ctx.fillStyle = darken(color, 0.22);
    roundRect(ctx, -bodyW * 0.86, -bodyH * 0.42, bodyW * 0.42, bodyH * 0.62, r * 0.24);
    ctx.fill();

    // body
    var grad = ctx.createLinearGradient(-bodyW * 0.5, -bodyH * 0.5, bodyW * 0.5, bodyH * 0.5);
    grad.addColorStop(0, lighten(color, 0.14));
    grad.addColorStop(0.55, color);
    grad.addColorStop(1, darken(color, 0.18));
    ctx.fillStyle = grad;
    roundRect(ctx, -bodyW * 0.5, -bodyH * 0.5, bodyW, bodyH, r * 0.44);
    ctx.fill();

    // visor
    ctx.fillStyle = 'rgba(190, 226, 255, 0.96)';
    ctx.beginPath();
    ctx.ellipse(bodyW * 0.16, -bodyH * 0.16, bodyW * 0.28, bodyH * 0.19, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.ellipse(bodyW * 0.05, -bodyH * 0.24, bodyW * 0.11, bodyH * 0.07, -0.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  };

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  G.roundRect = roundRect;

  function hexToRgb(hex) {
    hex = String(hex).replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function lighten(hex, amt) {
    var c = hexToRgb(hex);
    return 'rgb(' + Math.round(c.r + (255 - c.r) * amt) + ',' +
      Math.round(c.g + (255 - c.g) * amt) + ',' + Math.round(c.b + (255 - c.b) * amt) + ')';
  }
  function darken(hex, amt) {
    var c = hexToRgb(hex);
    return 'rgb(' + Math.round(c.r * (1 - amt)) + ',' + Math.round(c.g * (1 - amt)) + ',' + Math.round(c.b * (1 - amt)) + ')';
  }
  G.lighten = lighten; G.darken = darken;

  /* ------------------------------------------------------------------ */
  /*  background & ship                                                  */
  /* ------------------------------------------------------------------ */

  function drawStarfield(ctx, cam) {
    var g = ctx.createLinearGradient(0, 0, 0, cam.h);
    g.addColorStop(0, '#060912');
    g.addColorStop(1, '#0a1020');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cam.w, cam.h);

    // parallax stars keyed off the camera so they feel like space
    var s = 1;
    ctx.save();
    for (var layer = 0; layer < 3; layer++) {
      var spacing = 120 + layer * 90;
      var par = 0.06 + layer * 0.06;
      var ox = -cam.x * par, oy = -cam.y * par;
      ctx.fillStyle = ['rgba(255,255,255,0.30)', 'rgba(190,215,255,0.22)', 'rgba(255,255,255,0.14)'][layer];
      var startX = Math.floor((-ox) / spacing) * spacing + ox;
      var startY = Math.floor((-oy) / spacing) * spacing + oy;
      for (var x = startX; x < cam.w + spacing; x += spacing) {
        for (var y = startY; y < cam.h + spacing; y += spacing) {
          var jx = ((Math.sin(x * 12.9898 + y * 78.233 + layer) * 43758.5453) % 1 + 1) % 1;
          var jy = ((Math.sin(x * 39.3468 + y * 11.135 + layer) * 24634.6345) % 1 + 1) % 1;
          var sz = 0.7 + jx * 1.5;
          ctx.fillRect(x + jx * spacing * 0.7, y + jy * spacing * 0.7, sz, sz);
        }
      }
    }
    ctx.restore();
  }

  function drawShip(ctx) {
    if (render.floorCanvas) {
      var pad = render.floorPad || 48;
      ctx.drawImage(render.floorCanvas, -pad, -pad);
      return;
    }
    // fallback (floor canvas unavailable): plain fill so the game still renders
    ctx.fillStyle = '#121b2e';
    ctx.fillRect(-40, -40, G.WORLD_W + 80, G.WORLD_H + 80);
    for (var i = 0; i < G.ROOMS.length; i++) {
      var r = G.ROOMS[i].r;
      ctx.fillStyle = G.ROOMS[i].color;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    for (var w = 0; w < G.WALLS.length; w++) {
      var q = G.WALLS[w];
      ctx.fillStyle = '#22304e';
      ctx.fillRect(q.x, q.y, q.w, q.h);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  stations                                                           */
  /* ------------------------------------------------------------------ */

  var STATION_ICON = {
    wiring: '⚡', swipe: '💳', download: '⬇️', upload: '⬆️',
    fuel: '⛽', garbage: '🗑️', asteroids: '☄️', calibrate: '🎛️',
    scan: '🧬', prime: '🛡️', inspect: '🔬', divert: '🔌',
    align: '📐', cleano2: '🌬️', unlock: '🔓'
  };

  function drawStations(ctx, game) {
    var me = G.localPlayer();
    var myTasks = {};
    var view = game.view;
    for (var i = 0; i < view.tasks.length; i++) myTasks[view.tasks[i].id] = view.tasks[i];

    for (var s = 0; s < G.STATIONS.length; s++) {
      var st = G.STATIONS[s];
      var mine = myTasks[st.id];
      var isMine = !!mine;
      var done = isMine && mine.done;
      var near = me && G.dist2(me.x, me.y, st.x, st.y) < (st.radius + 40) * (st.radius + 40);

      ctx.save();
      ctx.translate(st.x, st.y);

      // pad
      var pulse = 1 + Math.sin(G.nowMs() * 0.004 + s) * 0.05;
      ctx.globalAlpha = isMine && !done ? 0.85 : 0.5;
      ctx.fillStyle = done ? 'rgba(82,210,115,0.22)' : (isMine ? 'rgba(79,209,197,0.22)' : 'rgba(120,150,200,0.14)');
      ctx.beginPath();
      ctx.arc(0, 0, (isMine && !done ? 34 : 28) * pulse, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 1;
      ctx.strokeStyle = done ? '#52d273' : (isMine ? '#4fd1c5' : 'rgba(140,170,220,0.45)');
      ctx.lineWidth = near && isMine && !done ? 4 : 2;
      ctx.beginPath();
      ctx.arc(0, 0, 30, 0, Math.PI * 2);
      ctx.stroke();

      ctx.font = '26px system-ui, "Segoe UI Emoji", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = done ? 0.45 : 0.95;
      ctx.fillText(STATION_ICON[st.task] || '⚙️', 0, 1);
      ctx.globalAlpha = 1;

      if (done) {
        ctx.strokeStyle = '#52d273';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(-12, 2); ctx.lineTo(-3, 12); ctx.lineTo(13, -10);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  ghosts / dead / bodies                                             */
  /* ------------------------------------------------------------------ */

  function drawBodies(ctx, game) {
    for (var i = 0; i < game.bodies.length; i++) {
      var b = game.bodies[i];
      ctx.save();
      // blood pool
      ctx.fillStyle = 'rgba(140,20,20,0.55)';
      ctx.beginPath();
      ctx.ellipse(b.x, b.y + 14, 30, 14, 0, 0, Math.PI * 2);
      ctx.fill();
      G.drawCrewmate(ctx, b.x, b.y, 20, b.color || '#888', { dir: 1, moving: false, dead: true, alpha: 0.95 });
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  main draw                                                          */
  /* ------------------------------------------------------------------ */

  render.draw = function (game, dt) {
    var ctx = render.ctx, cam = render.cam;
    if (!ctx) return;

    var target = G.cameraTarget();
    if (target) {
      cam.x = cam.x || target.x;
      cam.y = cam.y || target.y;
      var k = 1 - Math.pow(0.0016, dt);
      cam.x += (target.x - cam.x) * k;
      cam.y += (target.y - cam.y) * k;
    }

    ctx.save();
    ctx.setTransform(render.dpr, 0, 0, render.dpr, 0, 0);
    drawStarfield(ctx, cam);
    ctx.restore();

    ctx.save();
    ctx.setTransform(render.dpr, 0, 0, render.dpr, 0, 0);
    ctx.translate(cam.w / 2, cam.h / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    drawShip(ctx);
    drawStations(ctx, game);

    // emergency button
    var btn = G.EMERGENCY_BUTTON;
    ctx.save();
    ctx.translate(btn.x, btn.y);
    ctx.fillStyle = '#c0392b';
    ctx.beginPath(); ctx.arc(0, 0, 34, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e74c3c';
    ctx.beginPath(); ctx.arc(0, -3, 27, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '900 26px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('!', 0, -2);
    ctx.restore();

    // vents for impostors
    var view = game.view;
    if (view.role === 'imp') {
      for (var v = 0; v < G.VENTS.length; v++) {
        var vt = G.VENTS[v];
        ctx.save();
        ctx.translate(vt.x, vt.y);
        ctx.fillStyle = 'rgba(120,140,190,0.85)';
        G.roundRect(ctx, -16, -12, 32, 24, 5); ctx.fill();
        ctx.strokeStyle = '#2b3a5c'; ctx.lineWidth = 3;
        for (var l = -8; l <= 8; l += 8) {
          ctx.beginPath(); ctx.moveTo(l, -10); ctx.lineTo(l, 10); ctx.stroke();
        }
        ctx.restore();
      }
    }

    drawBodies(ctx, game);

    // players
    var me = G.localPlayer();
    var myRoom = me ? G.roomAtPoint(me.x, me.y) : null;
    for (var i = 0; i < game.order.length; i++) {
      var id = game.order[i];
      var p = game.players[id];
      if (!p) continue;
      if (p.inVent && !(me && me.id === p.id)) continue;
      if (!p.alive) continue;                        // corpses are separate entities

      var sameRoom = p.id === (me && me.id);
      // Ghosts see everyone, through walls — that is what makes spectating useful.
      var ghostSight = me && !me.alive;
      if (!sameRoom && !ghostSight && myRoom) {
        var theirRoom = G.roomAtPoint(p.x, p.y);
        if (!(theirRoom && theirRoom.id === myRoom.id) && !G.canSee(me.x, me.y, p.x, p.y)) {
          // seen only intermittently when the line of sight flickers
          var flick = ((Math.sin(G.nowMs() * 0.006 + i) * 0.5 + 0.5) > 0.86);
          if (!flick) continue;
        }
      }
      var isMate = view.role === 'imp' && p.role === 'imp';
      var outline = isMate ? 'rgba(255,80,80,0.85)' : null;
      G.drawCrewmate(ctx, p.x, p.y, 19, p.color, {
        dir: p.dir, moving: p.moving, outline: outline
      });

      // name tag
      ctx.save();
      ctx.font = '700 15px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      var label = p.name;
      var wpx = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(6,10,18,0.62)';
      G.roundRect(ctx, p.x - wpx / 2 - 7, p.y - 52, wpx + 14, 20, 6);
      ctx.fill();
      ctx.fillStyle = isMate ? '#ff8f88' : (p.id === (me && me.id) ? '#4fd1c5' : '#e8eefc');
      ctx.fillText(label, p.x, p.y - 34);
      ctx.restore();
    }

    // effects
    for (var e = render.effects.length - 1; e >= 0; e--) {
      var fx = render.effects[e];
      fx.t += dt;
      if (fx.t > fx.life) { render.effects.splice(e, 1); continue; }
      var a = 1 - fx.t / fx.life;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = fx.color || '#fff';
      ctx.font = '900 ' + (fx.size || 20) + 'px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(fx.text, fx.x, fx.y - fx.t * 40);
      ctx.restore();
    }

    ctx.restore();

    // ---- fog of war -------------------------------------------------
    var px = target ? target.x : cam.x, py = target ? target.y : cam.y;
    var baseR;
    if (me && !me.alive) baseR = 900;                  // ghosts see far
    else if (view.role === 'imp') baseR = 560;
    else baseR = 340;
    if (G.lightsOut) baseR = (view.role === 'imp' || (me && !me.alive)) ? baseR : 150;

    ctx.save();
    ctx.setTransform(render.dpr, 0, 0, render.dpr, 0, 0);
    var sx = cam.w / 2 + (px - cam.x) * cam.zoom;
    var sy = cam.h / 2 + (py - cam.y) * cam.zoom;
    var R = baseR * cam.zoom;
    var grad = ctx.createRadialGradient(sx, sy, R * 0.42, sx, sy, R);
    grad.addColorStop(0, 'rgba(3,5,10,0)');
    grad.addColorStop(0.72, 'rgba(3,5,10,0.55)');
    grad.addColorStop(1, 'rgba(3,5,10,0.97)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cam.w, cam.h);
    ctx.restore();

    // ---- lights-out tint -------------------------------------------
    if (G.lightsOut && view.role !== 'imp') {
      ctx.save();
      ctx.setTransform(render.dpr, 0, 0, render.dpr, 0, 0);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, cam.w, cam.h);
      ctx.restore();
    }
  };

  render.addFloat = function (x, y, text, color, size) {
    render.effects.push({ x: x, y: y, text: text, color: color, size: size, t: 0, life: 1.3 });
    if (render.effects.length > 40) render.effects.shift();
  };

  /* ------------------------------------------------------------------ */
  /*  minimap (used by the map overlay)                                  */
  /* ------------------------------------------------------------------ */

  render.drawMap = function (ctx, game, opts) {
    opts = opts || {};
    var pad = 12;
    var scale = Math.min((ctx.canvas.width - pad * 2) / G.WORLD_W, (ctx.canvas.height - pad * 2) / G.WORLD_H);
    ctx.save();
    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.translate(pad, pad);
    ctx.scale(scale, scale);

    for (var i = 0; i < G.ROOMS.length; i++) {
      var r = G.ROOMS[i];
      ctx.fillStyle = G.lighten(r.color, 0.16);
      ctx.fillRect(r.r.x, r.r.y, r.r.w, r.r.h);
      ctx.strokeStyle = 'rgba(160,200,255,0.35)';
      ctx.lineWidth = 4 / scale * 0.6;
      ctx.strokeRect(r.r.x, r.r.y, r.r.w, r.r.h);
      ctx.fillStyle = 'rgba(230,240,255,0.72)';
      ctx.font = '700 ' + Math.round(22 / scale * 0.9) + 'px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(r.name, r.cx, r.cy);
    }
    for (var w = 0; w < G.WALLS.length; w++) {
      var q = G.WALLS[w];
      ctx.fillStyle = 'rgba(40,58,95,0.9)';
      ctx.fillRect(q.x, q.y, q.w, q.h);
    }

    // stations
    var view = game.view;
    var myTasks = {};
    for (var t = 0; t < view.tasks.length; t++) myTasks[view.tasks[t].id] = view.tasks[t];
    for (var s = 0; s < G.STATIONS.length; s++) {
      var st = G.STATIONS[s];
      var mine = myTasks[st.id];
      if (!mine) continue;
      ctx.beginPath();
      ctx.arc(st.x, st.y, 16 / scale * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = mine.done ? 'rgba(82,210,115,0.85)' : '#ffd166';
      ctx.fill();
      if (!mine.done) {
        ctx.strokeStyle = 'rgba(255,209,102,0.6)';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(st.x, st.y, 26 / scale * 0.55, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // players
    for (var p = 0; p < game.order.length; p++) {
      var pl = game.players[game.order[p]];
      if (!pl) continue;
      var isMe = view.youId === pl.id;
      ctx.beginPath();
      ctx.arc(pl.x, pl.y, 18 / scale * 0.6, 0, Math.PI * 2);
      ctx.fillStyle = pl.alive ? pl.color : 'rgba(120,120,130,0.8)';
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = isMe ? '#ffffff' : 'rgba(0,0,0,0.45)';
      ctx.stroke();
    }

    if (opts.waypoint) {
      ctx.beginPath();
      ctx.arc(opts.waypoint.x, opts.waypoint.y, 20 / scale * 0.7, 0, Math.PI * 2);
      ctx.strokeStyle = '#4fd1c5';
      ctx.lineWidth = 8;
      ctx.stroke();
    }

    ctx.restore();
  };

})(window.G = window.G || {});
