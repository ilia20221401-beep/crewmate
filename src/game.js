/* ==========================================================================
   game.js — game state, host simulation and client view
   ---------------------------------------------------------------------------
   The HOST runs the authoritative simulation. Clients only send their input
   vector (plus the occasional action) and render whatever snapshots arrive.
   ========================================================================== */
(function (G) {
  'use strict';

  var COLORS = [
    '#c51111', '#132ed1', '#117f2d', '#ed54ba', '#ef7d0d',
    '#f5f557', '#3f474e', '#d6e0f0', '#6b2fbb', '#71491e',
    '#38fedc', '#50ef39'
  ];
  G.COLORS = COLORS;

  var MAX_PLAYERS = 10;
  var TICK_HZ = 60;
  var SNAPSHOT_HZ = 15;
  var USE_RANGE = 96;          // how close you must stand to a task station
  var KILL_RANGE = 84;
  var REPORT_RANGE = 110;
  var VENT_RANGE = 70;
  var MEETING_TIME = 45;
  var ROLE_REVEAL_TIME = 5;
  var EMERGENCY_MEETINGS = 1;
  var KILL_COOLDOWN = 25;

  /** Read a tuning constant, preferring G.consts so it can be tweaked live. */
  function K(name) {
    var c = G.consts;
    if (c && c[name] !== undefined) return c[name];
    switch (name) {
      case 'USE_RANGE': return USE_RANGE;
      case 'KILL_RANGE': return KILL_RANGE;
      case 'REPORT_RANGE': return REPORT_RANGE;
      case 'VENT_RANGE': return VENT_RANGE;
      case 'MEETING_TIME': return MEETING_TIME;
      case 'ROLE_REVEAL_TIME': return ROLE_REVEAL_TIME;
      case 'EMERGENCY_MEETINGS': return EMERGENCY_MEETINGS;
      case 'KILL_COOLDOWN': return KILL_COOLDOWN;
      case 'MAX_PLAYERS': return MAX_PLAYERS;
      default: return undefined;
    }
  }

  G.MAX_PLAYERS = MAX_PLAYERS;

  /* ====================================================================== */
  /*  Game                                                                  */
  /* ====================================================================== */

  function Game() {
    this.isHost = false;
    this.phase = 'menu';         // menu | lobby | reveal | play | meeting | ended
    this.settings = {
      impostors: 1,
      speed: 1,
      killCooldown: KILL_COOLDOWN,
      confirmEjects: true
    };
    this.players = {};           // id -> player
    this.order = [];             // stable player id order
    this.bodies = [];            // {id, x, y, color, name, room}
    this.log = [];               // recent events for the kill feed
    this.time = 0;
    this.phaseEnds = 0;          // absolute ms timestamp for timed phases
    this.meeting = null;
    this.winner = null;
    this.winReason = '';
    this.ejected = null;
    this.tasksDone = 0;
    this.tasksTotal = 0;

    this.view = {                // what the LOCAL player knows (synced from host)
      youId: null, role: 'crew', tasks: [], alive: true,
      killReadyAt: 0, canVent: false, inVent: false,
      taskProgress: {}, playerTaskCount: {}, votes: {}, chat: [],
      meeting: null, phase: 'menu', phaseEnds: 0,
      tasksDone: 0, tasksTotal: 0, winner: null, winReason: '', ejected: null
    };
    this.chat = [];
    this.votes = {};
  }

  G.Game = Game;
  G.game = new Game();
  G.consts = {
    USE_RANGE: USE_RANGE, KILL_RANGE: KILL_RANGE, REPORT_RANGE: REPORT_RANGE,
    VENT_RANGE: VENT_RANGE, MEETING_TIME: MEETING_TIME,
    ROLE_REVEAL_TIME: ROLE_REVEAL_TIME, EMERGENCY_MEETINGS: EMERGENCY_MEETINGS,
    KILL_COOLDOWN: KILL_COOLDOWN, TICK_HZ: TICK_HZ, SNAPSHOT_HZ: SNAPSHOT_HZ,
    MAX_PLAYERS: MAX_PLAYERS
  };

  /* ---------------- helpers -------------------------------------------- */

  var uidCounter = 0;
  function uid(prefix) { uidCounter++; return prefix + uidCounter.toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
  G.uid = uid;

  /**
   * Time source. `game.clock` (milliseconds) overrides the wall clock so the
   * simulation can be driven deterministically — used by the test harness and
   * available for replays. Production always uses Date.now().
   */
  function now() {
    var g = G.game;
    if (g && typeof g.clock === 'number') return g.clock;
    return Date.now();
  }
  G.now = now;
  G.clock = function (g) { return (g && typeof g.clock === 'number') ? g.clock : Date.now(); };

  function livingPlayers(game) {
    return game.order.map(function (id) { return game.players[id]; })
      .filter(function (p) { return p && p.alive; });
  }
  function impostors(game) {
    return game.order.map(function (id) { return game.players[id]; })
      .filter(function (p) { return p && p.role === 'imp'; });
  }
  function livingImpostors(game) {
    return impostors(game).filter(function (p) { return p.alive; });
  }
  function livingCrew(game) {
    return livingPlayers(game).filter(function (p) { return p.role === 'crew'; });
  }
  Game.prototype.living = function () { return livingPlayers(this); };

  /** Pick one task station per crewmate so the whole crew shares the work. */
  function assignTasks(game) {
    var crew = game.order.map(function (id) { return game.players[id]; })
      .filter(function (p) { return p && p.role === 'crew'; });
    var pool = G.STATIONS.map(function (s) { return s.id; });

    // shuffle
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }

    var perPlayer = Math.max(3, Math.min(5, Math.floor(pool.length / Math.max(1, crew.length))));
    var cursor = 0;
    crew.forEach(function (p) {
      p.tasks = [];
      for (var k = 0; k < perPlayer; k++) {
        p.tasks.push({ id: pool[cursor % pool.length], done: false });
        cursor++;
      }
    });
    recomputeTaskTotals(game);
  }

  function recomputeTaskTotals(game) {
    var total = 0, done = 0;
    game.order.forEach(function (id) {
      var p = game.players[id];
      if (!p || p.role !== 'crew') return;
      (p.tasks || []).forEach(function (t) { total++; if (t.done) done++; });
    });
    game.tasksTotal = total;
    game.tasksDone = done;
  }

  /* ====================================================================== */
  /*  HOST                                                                  */
  /* ====================================================================== */

  var host = {};
  G.host = host;

  host.init = function (game, net) {
    game.isHost = true;
    game.phase = 'menu';
    game.view.youId = 'host';
    host._snapAcc = 0;

    // Always point the handlers at the current game object. Registering the
    // listeners only once keeps a re-opened room from double-handling packets.
    net._crewmateGame = game;
    if (net._crewmateHostBound) return;
    net._crewmateHostBound = true;

    net.on('join', function (info) { host.onJoin(net._crewmateGame, net, info); });
    net.on('leave', function (playerId) { host.onLeave(net._crewmateGame, net, playerId); });
    net.on('message', function (msg, conn) { host.onMessage(net._crewmateGame, net, msg, conn); });
  };

  host.onJoin = function (game, net, info) {
    // reconnect by session id
    var existing = null;
    game.order.forEach(function (id) {
      if (game.players[id].sessionId === info.sessionId) existing = id;
    });

    if (info.isMobile === undefined) info.isMobile = false;

    if (existing) {
      var p = game.players[existing];
      p.connected = true;
      p.name = sanitizeName(info.name) || p.name;
      p.isMobile = info.isMobile;
      net.bindConn(existing, info.conn);
      net.sendTo(existing, { t: 'welcome', playerId: existing, code: net.code, resumed: true });
      host.pushLobby(game, net);
      host.broadcastSnapshot(game, net);
      return;
    }

    if (game.phase !== 'lobby' && game.phase !== 'menu') {
      net.sendTo(info.conn._playerId || '', {});
      try {
        info.conn.send({ t: 'kicked', reason: 'The game already started. Wait for the next round.' });
      } catch (e) {}
      setTimeout(function () { try { info.conn.close(); } catch (e) {} }, 200);
      return;
    }
    if (game.order.length >= K('MAX_PLAYERS')) {
      try { info.conn.send({ t: 'kicked', reason: 'This room is full (10 players).' }); } catch (e) {}
      setTimeout(function () { try { info.conn.close(); } catch (e) {} }, 200);
      return;
    }

    var id = uid('p_');
    var p = host.makePlayer(game, id, info.name, info.isMobile);
    p.sessionId = info.sessionId;
    p.connected = true;
    game.players[id] = p;
    game.order.push(id);
    net.bindConn(id, info.conn);

    net.sendTo(id, { t: 'welcome', playerId: id, code: net.code });
    host.pushLobby(game, net);
    G.emit('lobby-changed');
  };

  host.makePlayer = function (game, id, name, isMobile) {
    var used = game.order.map(function (x) { return game.players[x].color; });
    var color = COLORS[0];
    for (var i = 0; i < COLORS.length; i++) {
      if (used.indexOf(COLORS[i]) < 0) { color = COLORS[i]; break; }
    }
    var spawn = G.SPAWNS[game.order.length % G.SPAWNS.length];
    return {
      id: id, name: sanitizeName(name) || 'Crewmate', color: color,
      isMobile: !!isMobile, host: game.order.length === 0,
      x: spawn.x, y: spawn.y, vx: 0, vy: 0, dir: 1, moving: false,
      alive: true, role: 'crew', tasks: [], connected: true,
      killReadyAt: 0, inVent: false, meetingsLeft: EMERGENCY_MEETINGS,
      usedEmergency: false, lastMove: now()
    };
  };

  host.onLeave = function (game, net, playerId) {
    var p = game.players[playerId];
    if (!p) return;
    p.connected = false;
    if (game.phase === 'lobby' || game.phase === 'menu' || game.phase === 'ended') {
      delete game.players[playerId];
      game.order = game.order.filter(function (i) { return i !== playerId; });
      if (game.order.length && !game.order.some(function (i) { return game.players[i] && game.players[i].host; })) {
        game.players[game.order[0]].host = true;
      }
    }
    host.pushLobby(game, net);
    G.emit('lobby-changed');
    if (game.phase === 'play') host.checkWin(game, net);
  };

  host.onMessage = function (game, net, msg, conn) {
    var id = msg.from;
    var p = game.players[id];
    if (!p) return;

    /*
     * Last-resort guard. Every value in `msg` came off the network, so a peer
     * can put anything in it. Individual handlers sanitise what they use, but a
     * single unforeseen payload must never be able to break the message pump
     * and stall the whole match — the packet is dropped instead.
     */
    try {
      host.dispatch(game, net, p, msg);
    } catch (err) {
      if (window.console && console.warn) {
        console.warn('[crewmate] dropped a bad packet', msg && msg.t, err && err.message);
      }
    }
  };

  host.dispatch = function (game, net, p, msg) {
    var id = p.id;

    switch (msg.t) {
      case 'input':
        p.inx = clamp(msg.x, -1, 1);
        p.iny = clamp(msg.y, -1, 1);
        p.lastInput = now();
        break;
      case 'start':
        if (game.settings.hostId === id || p.host) host.startGame(game, net, msg.settings);
        break;
      case 'task':
        host.doTask(game, net, p, msg.stationId);
        break;
      case 'kill':
        host.tryKill(game, net, p);
        break;
      case 'report':
        host.tryReport(game, net, p, msg.bodyId);
        break;
      case 'emergency':
        host.tryEmergency(game, net, p);
        break;
      case 'vent':
        host.tryVent(game, net, p, msg.ventId);
        break;
      case 'sabotage':
        host.trySabotage(game, net, p, msg.kind);
        break;
      case 'fix-lights':
        host.tryFixLights(game, net, p);
        break;
      case 'vote':
        host.doVote(game, net, p, msg.target);
        break;
      case 'chat':
        host.doChat(game, net, p, msg.text);
        break;
      case 'settings':
        if (p.host) {
          if (msg.settings) {
            if (msg.settings.impostors) game.settings.impostors = clamp(msg.settings.impostors, 1, 3);
            if (msg.settings.speed) game.settings.speed = clamp(msg.settings.speed, 0.6, 1.6);
          }
          host.pushLobby(game, net);
        }
        break;
      case 'rematch':
        if (p.host) host.rematch(game, net);
        break;
      case 'ping':
        net.sendTo(id, { t: 'pong', ts: msg.ts });
        break;
    }
  };

  function clamp(v, lo, hi) { v = Number(v); if (isNaN(v)) return 0; return v < lo ? lo : (v > hi ? hi : v); }
  G.clamp = clamp;

  /**
   * Coerce anything a peer sends into a plain string.
   *
   * `String(x)` runs a hostile object's own `toString`, which can throw or do
   * arbitrary work, so the conversion is guarded. Everything arriving from the
   * network goes through here before it is stored or displayed.
   */
  function safeString(v) {
    if (typeof v === 'string') return v;
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return String(v); } catch (e) { return ''; }
  }
  G.safeString = safeString;

  /** A station id must be a short, plain string, not an object or an array. */
  function safeId(v) {
    if (typeof v === 'string') return v.slice(0, 64);
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }
  G.safeId = safeId;

  function sanitizeName(n) {
    if (typeof n !== 'string') return '';
    return n.replace(/[<>&"']/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
  }
  G.sanitizeName = sanitizeName;

  /* ---------------- lobby ------------------------------------------------- */

  host.pushLobby = function (game, net) {
    var players = game.order.map(function (id) {
      var p = game.players[id];
      return { id: id, name: p.name, color: p.color, host: !!p.host, connected: p.connected, isMobile: p.isMobile };
    });
    var payload = {
      t: 'lobby',
      code: net.code,
      players: players,
      settings: { impostors: game.settings.impostors, speed: game.settings.speed },
      canStart: players.length >= 4,
      phase: game.phase
    };
    G.lobbyState = payload;
    // The host's own lobby screen reads G.lobbyState, but every client needs the
    // payload too — without this they sit on "waiting for the host" with no
    // player list at all.
    game.order.forEach(function (id) {
      if (id === 'host') return;               // the host is not a remote peer
      net.sendTo(id, payload);
    });
    G.emit('lobby-changed');
  };

  /* ---------------- starting a round ------------------------------------ */

  host.startGame = function (game, net, settings) {
    if (game.order.length < 4) { G.toast('Need at least 4 players.', 'err'); return; }
    if (settings) {
      if (settings.impostors) game.settings.impostors = clamp(settings.impostors, 1, 3);
      if (settings.speed) game.settings.speed = clamp(settings.speed, 0.6, 1.6);
    }

    var n = game.order.length;
    var impCount = Math.min(game.settings.impostors, Math.max(1, Math.floor((n - 1) / 2)));

    // reset players
    game.order.forEach(function (id, i) {
      var p = game.players[id];
      var spawn = G.SPAWNS[i % G.SPAWNS.length];
      p.x = spawn.x; p.y = spawn.y; p.vx = 0; p.vy = 0;
      p.alive = true; p.role = 'crew'; p.tasks = []; p.inVent = false;
      p.meetingsLeft = K('EMERGENCY_MEETINGS'); p.usedEmergency = false;
      p.killReadyAt = 0; p.dir = 1; p.moving = false;
    });

    // pick impostors
    var ids = game.order.slice();
    for (var i = ids.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    }
    for (var k = 0; k < impCount; k++) game.players[ids[k]].role = 'imp';

    assignTasks(game);
    game.bodies = [];
    game.log = [];
    game.chat = [];
    game.votes = {};
    game.meeting = null;
    game.winner = null;
    game.winReason = '';
    game.ejected = null;
    game.tasksDone = 0;

    // kill cooldown starts when the round starts
    var ready = now() + K('KILL_COOLDOWN') * 1000;
    impostors(game).forEach(function (p) { p.killReadyAt = ready; });

    game.phase = 'reveal';
    game.phaseEnds = now() + K('ROLE_REVEAL_TIME') * 1000;

    // private role packets
    game.order.forEach(function (id) {
      var p = game.players[id];
      var mates = impostors(game).filter(function (m) { return m.id !== id; })
        .map(function (m) { return { id: m.id, name: m.name, color: m.color }; });
      net.sendTo(id, {
        t: 'event', kind: 'role',
        role: p.role, mates: p.role === 'imp' ? mates : [],
        tasks: p.tasks.map(function (t) {
          var s = G.stationById[t.id];
          return { id: t.id, name: s.name, room: s.room, x: s.x, y: s.y, task: s.task };
        }),
        impostorCount: impCount,
        crewCount: n - impCount,
        revealMs: K('ROLE_REVEAL_TIME') * 1000
      });
    });
    // the host is a player too: give it its own role packet
    if (game.players.host) {
      var hp = game.players.host;
      G.emit('event', {
        kind: 'role', role: hp.role,
        mates: hp.role === 'imp' ? impostors(game).filter(function (m) { return m.id !== 'host'; })
          .map(function (m) { return { id: m.id, name: m.name, color: m.color }; }) : [],
        tasks: hp.tasks.map(function (t) {
          var s = G.stationById[t.id];
          return { id: t.id, name: s.name, room: s.room, x: s.x, y: s.y, task: s.task };
        }),
        impostorCount: impCount, crewCount: n - impCount,
        revealMs: K('ROLE_REVEAL_TIME') * 1000
      });
    }
    G.emit('round-started');
  };

  host.rematch = function (game, net) {
    if (game.phase !== 'ended') return;
    game.phase = 'lobby';
    game.bodies = [];
    game.chat = [];
    game.votes = {};
    game.meeting = null;
    game.winner = null;
    game.order.forEach(function (id, i) {
      var p = game.players[id];
      var spawn = G.SPAWNS[i % G.SPAWNS.length];
      p.x = spawn.x; p.y = spawn.y; p.vx = 0; p.vy = 0;
      p.alive = true; p.tasks = []; p.inVent = false;
      p.meetingsLeft = K('EMERGENCY_MEETINGS');
    });
    host.pushLobby(game, net);
    G.emit('lobby-changed');
  };

  /* ---------------- simulation ------------------------------------------ */

  host.tick = function (game, net, dt) {
    if (game.phase === 'reveal') {
      if (now() >= game.phaseEnds) {
        game.phase = 'play';
        host.addLog(game, 'Tasks have been assigned.');
      }
      return;
    }
    if (game.phase === 'meeting') {
      host.tickMeeting(game, net);
      return;
    }
    if (game.phase !== 'play') return;

    if (game.sabotage && game.sabotage.active && now() >= game.sabotage.endsAt) {
      host.clearSabotage(game, net, null);
    }

    var speed = 210 * game.settings.speed;
    var t = now();

    game.order.forEach(function (id) {
      var p = game.players[id];
      if (!p.alive) {
        // Ghosts drift freely: they pass through walls and finish the tasks they
        // never completed, which is what keeps the crew's task win achievable
        // after a teammate dies.
        if (p.inVent) { p.moving = false; return; }
        var gx = p.inx || 0, gy = p.iny || 0;
        var glen = Math.sqrt(gx * gx + gy * gy);
        if (glen > 0.02) {
          if (glen > 1) { gx /= glen; gy /= glen; }
          var gspeed = speed * 1.25;
          p.x = clamp(p.x + gx * gspeed * dt, 8, G.WORLD_W - 8);
          p.y = clamp(p.y + gy * gspeed * dt, 8, G.WORLD_H - 8);
          p.moving = true;
          if (Math.abs(gx) > 0.08) p.dir = gx > 0 ? 1 : -1;
        } else {
          p.moving = false;
        }
        return;
      }
      if (p.inVent) { p.moving = false; return; }
      if (p.inMeeting) return;

      var ix = p.inx || 0, iy = p.iny || 0;
      var len = Math.sqrt(ix * ix + iy * iy);
      if (len > 0.02) {
        if (len > 1) { ix /= len; iy /= len; }
        var res = G.moveCircle(p.x, p.y, ix * speed * dt, iy * speed * dt, G.PLAYER_RADIUS);
        p.x = res.x; p.y = res.y;
        p.moving = true;
        if (Math.abs(ix) > 0.08) p.dir = ix > 0 ? 1 : -1;
      } else {
        p.moving = false;
      }
    });
  };

  host.tickMeeting = function (game, net) {
    var m = game.meeting;
    if (!m) return;
    var left = Math.max(0, (m.endsAt - now()) / 1000);
    m.timeLeft = left;

    // The meeting resolves as soon as every *living* connected player has
    // voted. Dead players may still vote, but they never hold it up.
    var waiting = 0;
    for (var i = 0; i < game.order.length; i++) {
      var id = game.order[i];
      var p = game.players[id];
      if (!p || !p.connected || !p.alive) continue;
      if (game.votes[id] === undefined) waiting++;
    }

    if (left <= 0 || waiting === 0) host.resolveMeeting(game, net);
  };

  host.addLog = function (game, text, color) {
    game.log.push({ text: text, color: color || null, at: now() });
    if (game.log.length > 8) game.log.shift();
    G.emit('log', game.log);
  };

  /* ---------------- actions --------------------------------------------- */

  function nearestStation(game, p, range) {
    var best = null, bestD = range * range;
    var mine = {};
    (p.tasks || []).forEach(function (t) { mine[t.id] = t; });
    G.STATIONS.forEach(function (s) {
      var d = (s.x - p.x) * (s.x - p.x) + (s.y - p.y) * (s.y - p.y);
      if (d < bestD) { bestD = d; best = s; }
    });
    return best;
  }
  G.nearestStation = nearestStation;

  host.doTask = function (game, net, p, stationId) {
    if (game.phase !== 'play' || p.inVent) return;
    stationId = safeId(stationId);
    // Living players and ghosts can both finish tasks. Ghosts are how the crew
    // can still reach the "all tasks done" victory after a teammate dies.
    var s = G.stationById[stationId];
    if (!s) return;
    var d2 = (s.x - p.x) * (s.x - p.x) + (s.y - p.y) * (s.y - p.y);
    if (d2 > K('USE_RANGE') * K('USE_RANGE')) return;

    // "download" tasks first unlock an upload station elsewhere
    var task = null;
    for (var i = 0; i < (p.tasks || []).length; i++) {
      if (p.tasks[i].id === stationId && !p.tasks[i].done) { task = p.tasks[i]; break; }
    }
    if (!task) {
      // a crewmate may legitimately finish a task that a teammate also has
      net.sendTo(p.id, { t: 'event', kind: 'task-result', ok: false, reason: 'not-yours', stationId: stationId });
      return;
    }
    task.done = true;
    recomputeTaskTotals(game);
    net.sendTo(p.id, { t: 'event', kind: 'task-result', ok: true, stationId: stationId });
    G.emit('task-complete', stationId);

    // announcement so other players notice progress
    host.addLog(game, p.name + ' completed a task.');

    if (game.tasksTotal > 0 && game.tasksDone >= game.tasksTotal) {
      host.endGame(game, net, 'crew', 'All tasks were completed.');
    }
  };

  host.tryKill = function (game, net, p) {
    if (game.phase !== 'play' || p.role !== 'imp' || !p.alive) return;
    if (now() < p.killReadyAt) {
      net.sendTo(p.id, { t: 'event', kind: 'kill-result', ok: false, reason: 'cooldown' });
      return;
    }
    var victim = null, bestD = K('KILL_RANGE') * K('KILL_RANGE');
    game.order.forEach(function (id) {
      var o = game.players[id];
      if (!o.alive || o.id === p.id || o.role === 'imp') return;
      var d = (o.x - p.x) * (o.x - p.x) + (o.y - p.y) * (o.y - p.y);
      if (d < bestD) { bestD = d; victim = o; }
    });
    if (!victim) {
      net.sendTo(p.id, { t: 'event', kind: 'kill-result', ok: false, reason: 'no-target' });
      return;
    }

    victim.alive = false;
    victim.vx = victim.vy = 0;
    p.killReadyAt = now() + K('KILL_COOLDOWN') * 1000;
    game.bodies.push({
      id: uid('b_'), playerId: victim.id, name: victim.name, color: victim.color,
      x: victim.x, y: victim.y, at: now(),
      room: G.roomAtPoint(victim.x, victim.y) ? G.roomAtPoint(victim.x, victim.y).name : 'the corridor'
    });
    net.sendTo(p.id, { t: 'event', kind: 'kill-result', ok: true, cooldown: K('KILL_COOLDOWN') * 1000 });
    G.emit('kill');
    host.checkWin(game, net);
  };

  host.tryReport = function (game, net, p, bodyId) {
    if (game.phase !== 'play' || !p.alive) return;
    var body = null;
    for (var i = 0; i < game.bodies.length; i++) {
      var b = game.bodies[i];
      if (bodyId && b.id !== bodyId) continue;
      var d = (b.x - p.x) * (b.x - p.x) + (b.y - p.y) * (b.y - p.y);
      if (d <= K('REPORT_RANGE') * K('REPORT_RANGE')) { body = b; break; }
    }
    if (!body) return;
    host.startMeeting(game, net, p, 'body', body);
  };

  host.tryEmergency = function (game, net, p) {
    if (game.phase !== 'play' || !p.alive) return;
    var btn = G.EMERGENCY_BUTTON;
    var d = (btn.x - p.x) * (btn.x - p.x) + (btn.y - p.y) * (btn.y - p.y);
    if (d > (btn.radius + 40) * (btn.radius + 40)) {
      net.sendTo(p.id, { t: 'event', kind: 'emergency-result', ok: false, reason: 'far' });
      return;
    }
    if (p.usedEmergency || p.meetingsLeft <= 0) {
      net.sendTo(p.id, { t: 'event', kind: 'emergency-result', ok: false, reason: 'used' });
      return;
    }
    p.usedEmergency = true;
    p.meetingsLeft = 0;
    host.startMeeting(game, net, p, 'emergency', null);
  };

  host.tryVent = function (game, net, p) {
    if (game.phase !== 'play' || p.role !== 'imp' || !p.alive) return;
    if (p.inVent) {                              // exit at current position
      p.inVent = false;
      net.sendTo(p.id, { t: 'event', kind: 'vent', inVent: false });
      return;
    }
    var best = null, bestD = K('VENT_RANGE') * K('VENT_RANGE');
    G.VENTS.forEach(function (v) {
      var d = (v.x - p.x) * (v.x - p.x) + (v.y - p.y) * (v.y - p.y);
      if (d < bestD) { bestD = d; best = v; }
    });
    if (!best) { net.sendTo(p.id, { t: 'event', kind: 'vent', ok: false }); return; }
    p.x = best.x; p.y = best.y; p.inVent = true;
    net.sendTo(p.id, { t: 'event', kind: 'vent', inVent: true, ventId: best.id });
  };

  /* ---------------- sabotage -------------------------------------------- */

  var SABOTAGE_DURATION = 22;      // seconds until lights repair themselves

  host.trySabotage = function (game, net, p, kind) {
    if (game.phase !== 'play' || !p.alive || p.role !== 'imp') return;
    kind = safeString(kind) || 'lights';
    if (kind !== 'lights') return;
    if (game.sabotage && game.sabotage.active) {
      net.sendTo(p.id, { t: 'event', kind: 'sabotage-result', ok: false, reason: 'active' });
      return;
    }
    if (p.sabotageReadyAt && now() < p.sabotageReadyAt) {
      net.sendTo(p.id, { t: 'event', kind: 'sabotage-result', ok: false, reason: 'cooldown' });
      return;
    }
    game.sabotage = {
      kind: 'lights',
      active: true,
      by: p.id,
      endsAt: now() + SABOTAGE_DURATION * 1000
    };
    p.sabotageReadyAt = now() + (SABOTAGE_DURATION + 20) * 1000;
    G.lightsOut = true;
    host.addLog(game, 'The lights have been sabotaged!', '#f2b544');
    host.broadcastEvent(game, net, {
      kind: 'sabotage', sabotage: 'lights',
      endsAt: game.sabotage.endsAt, by: p.name
    });
    net.sendTo(p.id, { t: 'event', kind: 'sabotage-result', ok: true });
  };

  host.tryFixLights = function (game, net, p) {
    if (game.phase !== 'play' || !p.alive) return;
    if (!game.sabotage || !game.sabotage.active) return;
    var room = G.roomById.electrical;
    var d = Math.hypot(p.x - room.cx, p.y - room.cy);
    if (d > room.r.w * 0.6) {
      net.sendTo(p.id, { t: 'event', kind: 'fix-result', ok: false, reason: 'far' });
      return;
    }
    host.clearSabotage(game, net, p.name);
    net.sendTo(p.id, { t: 'event', kind: 'fix-result', ok: true });
  };

  host.clearSabotage = function (game, net, byName) {
    if (!game.sabotage) return;
    game.sabotage.active = false;
    game.sabotage = null;
    G.lightsOut = false;
    host.addLog(game, byName ? (byName + ' restored the lights.') : 'The lights came back on.',
      '#7fd4ff');
    host.broadcastEvent(game, net, { kind: 'sabotage-ended' });
  };

  /* ---------------- meetings -------------------------------------------- */

  host.startMeeting = function (game, net, caller, kind, body) {
    if (game.phase !== 'play') return;
    game.phase = 'meeting';
    game.votes = {};
    var text;
    if (kind === 'body') {
      text = body.name + ' was found dead in ' + body.room + '.';
    } else {
      text = caller.name + ' called an emergency meeting.';
    }
    game.meeting = {
      kind: kind,
      caller: caller.id,
      callerName: caller.name,
      body: body ? { name: body.name, color: body.color, room: body.room, playerId: body.playerId } : null,
      text: text,
      endsAt: now() + K('MEETING_TIME') * 1000,
      timeLeft: MEETING_TIME
    };
    game.chat = [{ sys: true, text: text }];
    game.bodies = [];
    G.emit('meeting', game.meeting);

    game.order.forEach(function (id) {
      var p = game.players[id];
      p.inx = p.iny = 0;
      p.inVent = false;
    });
  };

  host.doVote = function (game, net, p, target) {
    if (game.phase !== 'meeting' || !p) return;
    if (game.votes[p.id] !== undefined) return;
    if (target !== 'skip' && !game.players[target]) return;
    game.votes[p.id] = target;
    G.emit('vote', { voter: p.id, target: target });

    var waiting = 0;
    for (var i = 0; i < game.order.length; i++) {
      var id = game.order[i];
      var q = game.players[id];
      if (!q || !q.connected || !q.alive) continue;
      if (game.votes[id] === undefined) waiting++;
    }
    if (waiting === 0) host.resolveMeeting(game, net);
  };

  host.doChat = function (game, net, p, text) {
    if (game.phase !== 'meeting') return;
    text = safeString(text).replace(/[<>&]/g, '').trim().slice(0, 120);
    if (!text) return;
    var msg = { name: p.name, color: p.color, text: text, at: now() };
    game.chat.push(msg);
    if (game.chat.length > 60) game.chat.shift();
    G.emit('chat', msg);
  };

  host.resolveMeeting = function (game, net) {
    var m = game.meeting;
    if (!m) return;

    var tally = {};
    var voters = {};
    game.order.forEach(function (id) {
      var v = game.votes[id];
      if (v === undefined) return;
      tally[v] = (tally[v] || 0) + 1;
      (voters[v] = voters[v] || []).push(game.players[id] ? { id: id, name: game.players[id].name, color: game.players[id].color } : { id: id });
    });

    var best = null, bestCount = 0, tie = false;
    Object.keys(tally).forEach(function (k) {
      if (tally[k] > bestCount) { bestCount = tally[k]; best = k; tie = false; }
      else if (tally[k] === bestCount && best !== null) tie = true;
    });

    var ejected = null;
    if (best && best !== 'skip' && !tie && bestCount > 0) {
      var victim = game.players[best];
      if (victim) {
        victim.alive = false;
        ejected = {
          id: victim.id, name: victim.name, color: victim.color,
          role: victim.role, wasImpostor: victim.role === 'imp', votes: bestCount
        };
      }
    }

    game.meeting = null;
    game.votes = {};
    game.ejected = ejected;

    if (ejected) {
      host.addLog(game, ejected.name + ' was ejected. ' +
        (ejected.wasImpostor ? 'They were an impostor.' : 'They were not an impostor.'),
        ejected.wasImpostor ? '#7fd4ff' : '#ff8f88');
    } else {
      host.addLog(game, tie ? 'The vote was tied. Nobody was ejected.' : 'Nobody was ejected.');
    }

    G.emit('meeting-resolved', ejected);
    host.broadcastEvent(game, net, { kind: 'ejected', ejected: ejected });

    if (!host.checkWin(game, net)) {
      game.phase = 'play';
      game.meeting = null;
      // impostor cooldown restarts after a meeting
      impostors(game).forEach(function (p) {
        if (p.alive) p.killReadyAt = Math.max(p.killReadyAt, now() + 10000);
      });
      if (ejected) G.emit('resume-after-eject', ejected);
      else G.emit('resume-after-eject', null);
    }
  };

  /* ---------------- win conditions -------------------------------------- */

  host.checkWin = function (game, net) {
    if (game.phase === 'ended') return true;
    var alive = livingPlayers(game);
    var imps = alive.filter(function (p) { return p.role === 'imp'; });
    var crew = alive.filter(function (p) { return p.role === 'crew'; });

    if (imps.length === 0) return host.endGame(game, net, 'crew', 'All impostors were ejected.');
    if (imps.length >= crew.length) return host.endGame(game, net, 'imp', 'The impostors outnumber the crew.');
    if (game.tasksTotal > 0 && game.tasksDone >= game.tasksTotal) {
      return host.endGame(game, net, 'crew', 'All tasks were completed.');
    }
    return false;
  };

  host.endGame = function (game, net, winner, reason) {
    game.phase = 'ended';
    game.winner = winner;
    game.winReason = reason;
    game.phaseEnds = now();
    var reveal = game.order.map(function (id) {
      var p = game.players[id];
      return { id: id, name: p.name, color: p.color, role: p.role, alive: p.alive, tasks: (p.tasks || []).filter(function (t) { return t.done; }).length, taskCount: (p.tasks || []).length };
    });
    host.broadcastEvent(game, net, { kind: 'end', winner: winner, reason: reason, reveal: reveal });
    G.emit('game-ended', { winner: winner, reason: reason, reveal: reveal });
    return true;
  };

  host.broadcastEvent = function (game, net, payload) {
    payload.t = 'event';
    net.broadcast(payload);
    G.emit('host-event', payload);
  };

  /* ---------------- snapshots ------------------------------------------- */

  host.broadcastSnapshot = function (game, net) {
    if (game.phase === 'menu') return;

    var players = game.order.map(function (id) {
      var p = game.players[id];
      return {
        i: id, n: p.name, c: p.color, x: Math.round(p.x), y: Math.round(p.y),
        a: p.alive ? 1 : 0, m: p.moving ? 1 : 0, d: p.dir, v: p.inVent ? 1 : 0,
        o: p.connected ? 1 : 0, h: p.host ? 1 : 0, r: p.role
      };
    });

    var base = {
      t: 'snapshot',
      ph: game.phase,
      tm: Math.round(game.time),
      pl: players,
      bd: game.bodies.map(function (b) {
        return { i: b.id, x: Math.round(b.x), y: Math.round(b.y), c: b.color, n: b.name };
      }),
      td: game.tasksDone,
      tt: game.tasksTotal,
      lg: game.log.slice(-5)
    };
    if (game.phase === 'meeting' && game.meeting) {
      base.mt = {
        text: game.meeting.text, endsAt: game.meeting.endsAt,
        kind: game.meeting.kind, body: game.meeting.body,
        callerName: game.meeting.callerName
      };
      base.mt_votes = game.votes;
      base.mt_chat = game.chat.slice(-40);
    }
    if (game.phase === 'reveal') base.re = game.phaseEnds;
    if (game.phase === 'ended') {
      base.wn = game.winner; base.wr = game.winReason; base.eg = game.ejected;
    }

    var imps = impostors(game).map(function (q) { return q.id; });

    game.order.forEach(function (id) {
      var p = game.players[id];
      var mine = (p.tasks || []).map(function (t) {
        var s = G.stationById[t.id];
        return { id: t.id, done: t.done ? 1 : 0, name: s.name, room: s.room, x: s.x, y: s.y, task: s.task };
      });
      var packet = {
        t: 'snapshot', ph: game.phase, tm: base.tm, pl: players, bd: base.bd,
        td: base.td, tt: base.tt, lg: base.lg,
        priv: {
          yo: p.id, ro: p.role, al: p.alive ? 1 : 0,
          kr: Math.round(Math.max(0, p.killReadyAt)),
          ve: p.inVent ? 1 : 0, vr: p.role === 'imp',
          tk: mine, mt: p.meetingsLeft || 0,
          mates: p.role === 'imp' ? imps : []
        }
      };
      if (base.mt) { packet.mt = base.mt; packet.pv = base.mt_votes; packet.ch = base.mt_chat; }
      if (base.re) packet.re = base.re;
      if (game.phase === 'ended') { packet.wn = base.wn; packet.wr = base.wr; packet.eg = base.eg; }
      net.sendTo(id, packet);
    });

    // the host's own local view is filled in by the UI loop from game state
    G.hostSnapshot = base;
    G.emit('snapshot', base);
  };

  /** Publish the host's own private view without copying it into game.players. */
  host.privateFor = function (game, id) {
    var p = game.players[id];
    if (!p) return null;
    return {
      yo: p.id, ro: p.role, al: p.alive ? 1 : 0,
      kr: Math.round(Math.max(0, p.killReadyAt)),
      ve: p.inVent ? 1 : 0, vr: p.role === 'imp',
      mt: p.meetingsLeft || 0,
      mates: p.role === 'imp' ? impostors(game).map(function (q) { return q.id; }) : [],
      tk: (p.tasks || []).map(function (t) {
        var s = G.stationById[t.id];
        return { id: t.id, done: t.done, name: s.name, room: s.room, x: s.x, y: s.y, task: s.task };
      })
    };
  };

  /* ====================================================================== */
  /*  CLIENT                                                                */
  /* ====================================================================== */

  var client = {};
  G.client = client;

  client.init = function (game, net) {
    game.isHost = false;
    net.on('welcome', function (msg) {
      game.view.youId = msg.playerId;
      game.phase = 'lobby';
      game.view.phase = 'lobby';
      G.emit('welcome', msg);
      G.emit('screen', 'lobby');
    });
    net.on('message', function (msg) { client.onMessage(game, net, msg); });
    net.on('hostgone', function () {
      G.toast('Lost connection to the host.', 'err');
      G.emit('host-gone');
    });
    net.on('kicked', function (reason) {
      G.toast(reason, 'err');
      G.emit('kicked', reason);
    });
    net.on('error', function (err) { G.emit('net-error', err); });
  };

  client.onMessage = function (game, net, msg) {
    switch (msg.t) {
      case 'lobby':
        G.lobbyState = msg;
        G.emit('lobby-changed');
        break;
      case 'snapshot':
        client.applySnapshot(game, msg);
        break;
      case 'event':
        G.emit('event', msg);
        client.onEvent(game, msg);
        break;
      case 'pong':
        G.emit('pong', msg);
        break;
    }
  };

  client.applySnapshot = function (game, s) {
    game.phase = s.ph;
    game.view.phase = s.ph;
    game.time = s.tm;
    game.players = {};
    game.order = [];
    s.pl.forEach(function (o) {
      game.order.push(o.i);
      game.players[o.i] = {
        id: o.i, name: o.n, color: o.c, x: o.x, y: o.y,
        alive: !!o.a, moving: !!o.m, dir: o.d, inVent: !!o.v,
        connected: !!o.o, host: !!o.h, role: o.r,
        smoothed: false
      };
    });
    game.bodies = s.bd.map(function (b) {
      return { id: b.i, x: b.x, y: b.y, color: b.c, name: b.n };
    });

    var v = game.view;
    if (s.priv) {
      v.youId = s.priv.yo;
      v.role = s.priv.ro;
      v.alive = !!s.priv.al;
      v.killReadyAt = s.priv.kr;
      v.inVent = !!s.priv.ve;
      v.canVent = !!s.priv.vr;
      v.meetingsLeft = s.priv.mt;
      v.mates = s.priv.mates || [];
      v.tasks = (s.priv.tk || []).map(function (t) {
        return { id: t.id, done: !!t.done, name: t.name, room: t.room, x: t.x, y: t.y, task: t.task };
      });
      /*
       * Also keep the client's own player object carrying its tasks. The UI
       * reads the list from `view`, but anything that walks the player table
       * (the map overlay, future features) should not find the local player
       * with no tasks at all. Only the local player is populated, so no other
       * player's secrets are involved.
       */
      var mine = game.players[v.youId];
      if (mine) {
        mine.tasks = v.tasks.map(function (t) {
          return { id: t.id, done: t.done };
        });
      }
    }
    if (s.ph === 'meeting') {
      v.meeting = s.mt ? {
        text: s.mt.text, endsAt: s.mt.endsAt, kind: s.mt.kind,
        body: s.mt.body, callerName: s.mt.callerName
      } : null;
      v.votes = s.pv || {};
      v.chat = s.ch || [];
    } else {
      v.meeting = null;
      v.votes = {};
      v.chat = [];
    }
    v.tasksDone = s.td || 0;
    v.tasksTotal = s.tt || 0;
    v.log = s.lg || [];
    if (s.ph === 'ended') { v.winner = s.wn; v.winReason = s.wr; v.ejected = s.eg; }
    if (s.ph === 'reveal') v.revealEndsAt = s.re;

    // Safety net: if the private 'role' event was lost, the snapshot still
    // carries everything needed to show the reveal screen.
    if (s.ph === 'reveal' && !v.roleKnown && s.priv) {
      client.applyRole(game, {
        role: s.priv.ro,
        mates: s.priv.mates || [],
        tasks: s.priv.tk || [],
        impostorCount: (s.pl || []).filter(function (o) { return o.r === 'imp'; }).length,
        crewCount: (s.pl || []).filter(function (o) { return o.r === 'crew'; }).length,
        revealMs: Math.max(1200, (s.re || 0) - now())
      });
    }
    if (s.ph === 'play' && !s.mt) v.roleKnown = v.roleKnown;

    G.emit('snapshot-applied');
  };

  /** Store the local player's secret role and announce it to the UI. */
  client.applyRole = function (game, msg) {
    var v = game.view;
    v.role = msg.role;
    v.mates = msg.mates || [];
    v.tasks = (msg.tasks || []).map(function (t) {
      return { id: t.id, done: !!t.done, name: t.name, room: t.room, x: t.x, y: t.y, task: t.task };
    });
    v.impostorCount = msg.impostorCount;
    v.crewCount = msg.crewCount;
    v.roleKnown = true;
    G.emit('role-revealed', msg);
  };

  client.onEvent = function (game, msg) {
    switch (msg.kind) {
      case 'role':
        client.applyRole(game, msg);
        break;
      case 'sabotage':
        G.emit('sabotage', msg);
        break;
      case 'sabotage-result':
        G.emit('sabotage-result', msg);
        break;
      case 'sabotage-ended':
        G.lightsOut = false;
        G.emit('sabotage-ended');
        break;
      case 'fix-result':
        G.emit('fix-result', msg);
        break;
      case 'task-result':
        G.emit('task-result', msg);
        break;
      case 'kill-result':
        G.emit('kill-result', msg);
        break;
      case 'vent':
        G.emit('vent-result', msg);
        break;
      case 'end':
        game.view.winner = msg.winner;
        game.view.winReason = msg.reason;
        game.view.reveal = msg.reveal;
        G.emit('game-ended', msg);
        break;
      case 'ejected':
        G.emit('ejected', msg.ejected);
        break;
    }
  };

  /* ====================================================================== */
  /*  shared helpers                                                        */
  /* ====================================================================== */

  G.localPlayer = function () {
    var g = G.game;
    var id = g.isHost ? g.view.youId || 'host' : g.view.youId;
    if (!id && g.isHost) id = 'host';
    return g.players[id] || null;
  };

  /** The player the camera follows: the local player, or a living one when dead. */
  G.cameraTarget = function () {
    var g = G.game;
    var me = G.localPlayer();
    if (me && me.alive) return me;
    var living = g.order.map(function (id) { return g.players[id]; })
      .filter(function (p) { return p && p.alive; });
    if (!living.length) return me;
    return living[Math.floor(now() * 0.0004) % living.length];
  };

})(window.G = window.G || {});
