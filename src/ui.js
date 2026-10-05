/* ==========================================================================
   ui.js — screens, lobby, HUD, overlays and the main loop
   ========================================================================== */
(function (G) {
  'use strict';

  var ui = {};
  G.ui = ui;

  /*
   * Read the game object lazily rather than capturing it once at load time.
   * `G.game` is a single long-lived instance in the browser, but reading it
   * through a getter means the module cannot end up holding a stale reference,
   * and it keeps the module testable in isolation.
   */
  function gameRef() { return G.game; }
  var game = G.game;
  var net = G.net;

  var refs = {};        // cached DOM nodes
  var state = {
    screen: 'menu',
    lastPhase: null,
    roleTimer: null,
    voteSent: null,
    waypoint: null,
    myName: 'Player',
    touch: false,
    taskStation: null,
    killTargetInRange: false,
    reportInRange: false,
    nearStation: null,
    emergencyInRange: false,
    lastTaskSig: '',
    spectatorIndex: 0,
    /* audio / animation bookkeeping */
    lastLobbyCount: -1,
    lastVoteSecond: null,
    killWasCooling: false,
    chatCount: -1,
    frozen: false
  };

  /* ====================================================================== */
  /*  boot                                                                  */
  /* ====================================================================== */

  function cacheRefs() {
    [
      'screen-menu', 'screen-lobby', 'screen-game',
      'in-name', 'in-code', 'btn-create', 'btn-join', 'btn-join-go',
      'join-panel', 'menu-status',
      'lobby-title', 'lobby-sub', 'room-code', 'room-code-wrap', 'join-url',
      'btn-copy', 'lobby-players', 'lobby-status', 'btn-leave', 'btn-start',
      'lobby-settings', 'sel-impostors', 'sel-speed',
      'game-canvas', 'task-list', 'task-bar', 'panel-role', 'role-text',
      'btn-map', 'btn-fullscreen', 'btn-sound', 'act-use', 'act-kill', 'act-report', 'act-sabotage',
      'kill-cd', 'sab-cd', 'lights-banner', 'lights-text', 'lights-timer', 'btn-fix-lights',
      'btn-emergency', 'emergency-count', 'net-badge', 'joystick',
      'ov-role', 'role-name', 'role-desc', 'role-countdown',
      'ov-meeting', 'meeting-title', 'meeting-sub', 'vote-timer', 'vote-grid',
      'btn-skip', 'chat-log', 'chat-input', 'btn-chat-send',
      'ov-result', 'result-title', 'result-sub', 'result-body',
      'btn-rematch', 'btn-exit',
      'ov-map', 'map-canvas', 'btn-close-map',
      'ov-task', 'task-title', 'task-sub', 'task-body', 'btn-task-cancel',
      'rotate-hint'
    ].forEach(function (id) {
      refs[id] = document.getElementById(id);
    });
  }

  function $(id) { return refs[id]; }

  /**
   * Build the shareable join link.
   *
   * `location.origin` is the string "null" when the page is opened straight off
   * disk (file://), and reading the clipboard is unavailable there too — so the
   * link is derived from `location.href` instead, which is always correct.
   */
  function joinUrl(code) {
    // location.href is always present in a browser, but be defensive: a throw
    // here would break the whole lobby render.
    var href = (location && typeof location.href === 'string' && location.href) ? location.href : '';
    var base = href.split('#')[0].split('?')[0];
    if (!base) {
      var origin = (location && location.origin && location.origin !== 'null') ? location.origin : '';
      var pathname = (location && typeof location.pathname === 'string') ? location.pathname : '';
      base = origin + pathname;
    }
    return code ? base + '?room=' + code : base;
  }

  /** True when the page is not served over http(s), i.e. opened from disk. */
  function isLocalFile() {
    return location.protocol === 'file:' ||
      location.origin === 'null' || location.origin === null;
  }

  // exposed so the test suites can exercise the share-link logic directly
  ui._joinUrl = joinUrl;
  ui._isLocalFile = isLocalFile;

  /** Safe sound helper — never let audio break the game. */
  function sfx(name) {
    if (G.audio && G.audio.play) {
      try { G.audio.play(name); } catch (e) {}
    }
  }

  function setScreen(name) {
    state.screen = name;
    ['menu', 'lobby', 'game'].forEach(function (s) {
      var node = $('screen-' + s);
      if (node) node.classList.toggle('hidden', s !== name);
    });
    document.body.classList.toggle('ingame', name === 'game');
    if (name === 'game') {
      setTimeout(function () { G.render.resize(); }, 30);
    }
  }
  ui.setScreen = setScreen;

  /* ====================================================================== */
  /*  menu                                                                  */
  /* ====================================================================== */

  function menuStatus(text, kind) {
    var el = $('menu-status');
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function loadName() {
    var n = '';
    try { n = localStorage.getItem('crewmate-name') || ''; } catch (e) {}
    return n;
  }

  function saveName(n) {
    try { localStorage.setItem('crewmate-name', n); } catch (e) {}
  }

  function currentName() {
    var raw = $('in-name').value.trim() || loadName() || 'Crewmate';
    raw = G.sanitizeName(raw) || 'Crewmate';
    saveName(raw);
    state.myName = raw;
    return raw;
  }

  function profile() {
    return {
      name: currentName(),
      color: null,
      sessionId: G.sessionKey(),
      isMobile: state.touch
    };
  }

  /* ====================================================================== */
  /*  lobby                                                                 */
  /* ====================================================================== */

  function renderLobby() {
    var payload = G.lobbyState;
    if (!payload) return;

    $('lobby-players').innerHTML = '';
    payload.players.forEach(function (p) {
      var chip = G.el('div', { class: 'player-chip' }, [
        G.el('i', { class: 'dot', style: 'background:' + p.color + ';color:' + p.color }),
        G.el('span', { class: 'name', text: p.name }),
        p.host ? G.el('span', { class: 'tag', text: 'Host' }) : null,
        p.isMobile ? G.el('span', { class: 'tag', text: '📱' }) : null,
        !p.connected ? G.el('span', { class: 'tag', text: 'offline' }) : null
      ]);
      $('lobby-players').appendChild(chip);
    });

    var isHost = game.isHost;
    $('lobby-title').textContent = 'Lobby — ' + payload.players.length + ' / ' + G.MAX_PLAYERS;
    $('lobby-sub').textContent = isHost
      ? 'Waiting for players. Share the code below.'
      : 'Waiting for the host to start the game.';

    $('room-code-wrap').classList.toggle('hidden', !isHost);
    if (isHost) {
      var code = payload.code || net.code || '';
      $('room-code').textContent = code || '----';
      $('join-url').textContent = joinUrl(code);
    } else {
      $('room-code').textContent = net.code || '----';
    }

    $('lobby-settings').classList.toggle('hidden', !isHost);
    if (isHost) {
      $('sel-impostors').value = String(payload.settings.impostors);
      $('sel-speed').value = String(payload.settings.speed);
    }

    $('btn-start').classList.toggle('hidden', !isHost);
    $('btn-start').disabled = payload.players.length < 4;

    // The file:// warning matters more than the generic status, so it wins.
    var localFile = isHost && isLocalFile();
    if (localFile) {
      $('lobby-status').textContent =
        'Opened from a file, so other devices cannot reach this address. ' +
        'Upload it, or run `node serve.js` and open the network address, to play with friends.';
    } else {
      $('lobby-status').textContent = payload.players.length < 4
        ? 'Need at least 4 players (' + (4 - payload.players.length) + ' more).'
        : (isHost ? 'Ready when you are!' : '');
    }
    // exposed for the test suites only
    ui._lastLobbyWasLocalFile = localFile;
  }

  /* ====================================================================== */
  /*  game HUD                                                              */
  /* ====================================================================== */

  /** Copy the host's own private state into game.view (the host has no snapshots). */
  function syncHostView() {
    var me = game.players.host;
    if (!me) return;
    var priv = G.host.privateFor(game, 'host');
    if (!priv) return;
    var v = game.view;
    v.youId = 'host';
    v.role = priv.ro;
    v.alive = !!priv.al;
    v.killReadyAt = priv.kr;
    v.inVent = !!priv.ve;
    v.canVent = !!priv.vr;
    v.mates = priv.mates || [];
    // rebuild the task list only when it actually changed
    var sig = sigOf(priv.tk);
    if (v._taskSig !== sig) {
      v._taskSig = sig;
      v.tasks = priv.tk.map(function (t) {
        return { id: t.id, done: !!t.done, name: t.name, room: t.room, x: t.x, y: t.y, task: t.task };
      });
      state.lastTaskSig = '';
    }
    v.tasksDone = game.tasksDone;
    v.tasksTotal = game.tasksTotal;
    v.meetingsLeft = priv.mt;
    if (game.phase === 'meeting' && game.meeting) {
      v.meeting = game.meeting;
      v.votes = game.votes;
      v.chat = game.chat;
    } else {
      v.meeting = null;
      v.votes = {};
    }
    v.phase = game.phase;
    v.winner = game.winner;
    v.winReason = game.winReason;
    v.ejected = game.ejected;
  }

  function sigOf(tasks) {
    return (tasks || []).map(function (t) { return t.id + (t.done ? '1' : '0'); }).join(',');
  }

  /** Smooth remote player positions so 15 Hz snapshots look continuous. */
  function smoothPlayers(dt) {
    if (game.isHost) return;
    var k = 1 - Math.pow(0.0009, dt);
    game.order.forEach(function (id) {
      var p = game.players[id];
      if (!p) return;
      if (!p.smoothed) { p.rx = p.x; p.ry = p.y; p.smoothed = true; }
      p.rx += (p.x - p.rx) * k;
      p.ry += (p.y - p.ry) * k;
    });
  }

  function updateHud(dt) {
    game = gameRef();
    var v = game.view;
    var me = G.localPlayer();
    var now = G.nowMs();
    var wall = Date.now();

    /* --- task list --- */
    var sig = v.role + '|' + game.phase + '|' + v.tasks.map(function (t) {
      return t.id + (t.done ? '1' : '0');
    }).join(',');
    if (sig !== state.lastTaskSig) {
      state.lastTaskSig = sig;
      var list = $('task-list');
      list.innerHTML = '';
      if (v.role === 'imp') {
        list.appendChild(G.el('li', { text: 'Sabotage the crew. Do not get caught.' }));
      } else if (!v.tasks.length) {
        list.appendChild(G.el('li', { text: 'No tasks assigned.' }));
      } else {
        if (!v.alive) {
          list.appendChild(G.el('li', {
            style: 'color:#7fd4ff',
            text: '👻 You are a ghost — finish your remaining tasks to help the crew.'
          }));
        }
        v.tasks.forEach(function (t) {
          list.appendChild(G.el('li', { class: t.done ? 'done' : '' }, [
            G.el('span', { class: 'tick', text: t.done ? '✔' : '•' }),
            G.el('span', { text: t.name + ' — ' + (G.roomById[t.room] ? G.roomById[t.room].name : '') })
          ]));
        });
      }
    }
    var pct = v.tasksTotal ? (v.tasksDone / v.tasksTotal) * 100 : 0;
    $('task-bar').style.width = pct.toFixed(1) + '%';

    /* --- role panel --- */
    var showRole = v.role === 'imp' || v.tasksTotal > 0;
    $('panel-role').classList.toggle('hidden', !showRole);
    if (showRole) {
      var txt = v.role === 'imp'
        ? 'IMPOSTOR — kill the crew.'
        : 'CREWMATE — ' + v.tasksDone + '/' + v.tasksTotal + ' tasks done.';
      if (v.role === 'imp' && v.mates && v.mates.length) {
        txt += ' Teammates: ' + v.mates.map(function (id) {
          var p = game.players[id];
          return p ? p.name : id;
        }).join(', ');
      }
      $('role-text').textContent = txt;
    }

    /* --- proximity --- */
    var station = me ? G.nearestStation(game, me, G.consts.USE_RANGE) : null;
    var hasTask = false;
    if (station && me) {
      for (var i = 0; i < v.tasks.length; i++) {
        if (v.tasks[i].id === station.id && !v.tasks[i].done) { hasTask = true; break; }
      }
    }
    var target = null, bestD = G.consts.KILL_RANGE * G.consts.KILL_RANGE;
    if (me && v.role === 'imp') {
      game.order.forEach(function (id) {
        var p = game.players[id];
        if (!p || !p.alive || p.id === me.id || p.role === 'imp') return;
        var d = G.dist2(p.x, p.y, me.x, me.y);
        if (d < bestD) { bestD = d; target = p; }
      });
    }
    var body = null, bodyD = G.consts.REPORT_RANGE * G.consts.REPORT_RANGE;
    if (me && me.alive) {
      game.bodies.forEach(function (b) {
        var d = G.dist2(b.x, b.y, me.x, me.y);
        if (d < bodyD) { bodyD = d; body = b; }
      });
    }
    var btnD = me ? G.dist2(me.x, me.y, G.EMERGENCY_BUTTON.x, G.EMERGENCY_BUTTON.y) : 1e9;
    var nearButton = btnD < Math.pow(G.EMERGENCY_BUTTON.radius + 40, 2);

    /* --- buttons --- */
    // Being dead is not the end: ghosts finish the tasks they never completed,
    // which is what keeps a task victory reachable for the crew.
    var isGhost = !!me && !me.alive;
    var canAct = game.phase === 'play' && !!me && !v.inVent;
    $('act-use').hidden = !(canAct && hasTask);
    $('act-use').disabled = !canAct;
    $('act-kill').hidden = !(canAct && v.role === 'imp' && me.alive);
    var cdLeft = Math.max(0, (v.killReadyAt - wall) / 1000);
    var killReady = cdLeft <= 0 && !!target;
    $('act-kill').disabled = !killReady;
    // announce the cooldown ending once per round
    if (v.role === 'imp' && cdLeft <= 0 && state.killWasCooling) sfx('killReady');
    state.killWasCooling = v.role === 'imp' && cdLeft > 0;
    var cd = $('kill-cd');
    if (v.role === 'imp' && cdLeft > 0) {
      cd.classList.remove('hidden');
      cd.textContent = Math.ceil(cdLeft) + 's';
    } else {
      cd.classList.add('hidden');
    }
    $('act-report').hidden = !(canAct && !!body);
    $('act-report').disabled = !(canAct && !!body);

    /* --- sabotage (lights) --- */
    var sab = game.sabotage;
    var sabActive = !!(sab && sab.active);
    $('act-sabotage').hidden = !(canAct && v.role === 'imp' && game.phase === 'play');
    var sabCdLeft = 0;
    if (me && me.sabotageReadyAt) sabCdLeft = Math.max(0, (me.sabotageReadyAt - wall) / 1000);
    $('act-sabotage').disabled = !canAct || sabActive || sabCdLeft > 0;
    var sabCdEl = $('sab-cd');
    if (sabCdLeft > 0 && !sabActive) {
      sabCdEl.classList.remove('hidden');
      sabCdEl.textContent = Math.ceil(sabCdLeft) + 's';
    } else {
      sabCdEl.classList.add('hidden');
    }

    /* --- lights banner --- */
    var banner = $('lights-banner');
    if (sabActive) {
      banner.classList.remove('hidden');
      var secs = Math.max(0, (sab.endsAt - wall) / 1000);
      $('lights-timer').textContent = Math.ceil(secs);
      $('lights-text').textContent = v.role === 'imp'
        ? 'Lights sabotaged — hunt them down!'
        : 'Lights sabotaged! Get to Electrical.';
      var inElectrical = me && G.roomAtPoint(me.x, me.y) && G.roomAtPoint(me.x, me.y).id === 'electrical';
      $('btn-fix-lights').classList.toggle('hidden', !(inElectrical && me.alive && v.role === 'crew'));
    } else {
      banner.classList.add('hidden');
    }

    var emLeft = v.meetingsLeft === undefined ? 1 : v.meetingsLeft;
    $('emergency-count').textContent = emLeft > 0 ? 'ready' : 'used';
    $('btn-emergency').disabled = !(canAct && me.alive && nearButton && emLeft > 0);
    $('btn-emergency').style.opacity = nearButton ? '1' : '0.55';

    state.nearStation = hasTask ? station : null;
    state.reportInRange = !!body;
    state.emergencyInRange = nearButton;

    /* --- net badge --- */
    var badge = 'Room ' + (net.code || '----') + ' · ' + game.order.length + ' players';
    if (v.tasksTotal) badge += ' · tasks ' + v.tasksDone + '/' + v.tasksTotal;
    $('net-badge').textContent = badge + (G.lightsOut ? ' · LIGHTS OUT' : '');
  }

  /* ---------------- overlays -------------------------------------------- */

  function showRoleOverlay(msg) {
    $('ov-role').classList.remove('hidden');
    var isImp = msg.role === 'imp';
    $('role-name').textContent = isImp ? 'IMPOSTOR' : 'CREWMATE';
    $('role-name').className = 'role-name ' + (isImp ? 'imp' : 'crew');
    var desc;
    if (isImp) {
      desc = 'Kill the crew without being caught. Sabotage and use vents to move unseen.' +
        (msg.mates && msg.mates.length ? ' Your teammates: ' + msg.mates.map(function (m) { return m.name; }).join(', ') + '.' : ' You are the only impostor.');
    } else {
      desc = 'Finish your tasks, or find and eject the ' + (msg.impostorCount || 1) +
        ' impostor' + ((msg.impostorCount || 1) > 1 ? 's' : '') + ' among the ' + (msg.crewCount || 4) + ' crewmates.';
    }
    $('role-desc').textContent = desc;
    setTimeout(function () { $('ov-role').classList.add('hidden'); }, msg.revealMs || 5000);
  }

  var lastMeetingSig = '';
  function updateMeetingOverlay() {
    var v = game.view;
    var show = game.phase === 'meeting' && !!v.meeting;
    $('ov-meeting').classList.toggle('hidden', !show);
    if (!show) { lastMeetingSig = ''; return; }

    var m = v.meeting;
    var left = Math.max(0, (m.endsAt - Date.now()) / 1000);
    $('vote-timer').textContent = Math.ceil(left);

    // countdown ticks in the last ten seconds
    var whole = Math.ceil(left);
    if (whole !== state.lastVoteSecond) {
      state.lastVoteSecond = whole;
      if (whole <= 10 && whole > 0) sfx('tick');
    }
    $('meeting-title').textContent = m.kind === 'body' ? 'Dead body reported!' : 'Emergency Meeting';
    $('meeting-sub').textContent = m.text || '';

    var sig = game.order.join(',') + '|' + JSON.stringify(v.votes) + '|' + game.phase;
    if (sig !== lastMeetingSig) {
      lastMeetingSig = sig;
      var grid = $('vote-grid');
      grid.innerHTML = '';
      game.order.forEach(function (id) {
        var p = game.players[id];
        if (!p) return;
        var voters = [];
        Object.keys(v.votes || {}).forEach(function (vid) {
          if (v.votes[vid] === id) {
            var voter = game.players[vid];
            voters.push(voter ? voter.color : '#888');
          }
        });
        var card = G.el('button', {
          class: 'vote-card' + (state.voteSent === id ? ' selected' : ''),
          onclick: function () { sendVote(id); }
        }, [
          G.el('img', { class: 'avatar', src: G.crewmateDataUrl(p.color, 40), alt: '' }),
          G.el('span', { class: 'vname', text: p.name + (p.id === v.youId ? ' (you)' : '') }),
          G.el('span', { class: 'voters' }, voters.map(function (col) {
            return G.el('i', { style: 'background:' + col + ';color:' + col });
          }))
        ]);
        grid.appendChild(card);
      });
    }
    $('btn-skip').disabled = !!state.voteSent;
    $('btn-skip').textContent = state.voteSent === 'skip' ? 'Skipped' : 'Skip vote';
    renderChat();
  }

  function renderChat() {
    var v = game.view;
    var log = $('chat-log');
    var msgs = v.chat || [];
    if (state.chatCount === msgs.length) return;
    var grew = state.chatCount !== undefined && state.chatCount >= 0 && msgs.length > state.chatCount;
    state.chatCount = msgs.length;
    log.innerHTML = '';
    msgs.forEach(function (m) {
      if (m.sys) {
        log.appendChild(G.el('div', { class: 'msg sys', text: m.text }));
      } else {
        log.appendChild(G.el('div', { class: 'msg' }, [
          G.el('b', { text: m.name + ':', style: 'color:' + (m.color || '#fff') }),
          ' ' + m.text
        ]));
      }
    });
    log.scrollTop = log.scrollHeight;
    if (grew && msgs.length && !msgs[msgs.length - 1].sys) sfx('chat');
  }

  var lastResultSig = '';
  function updateResultOverlay() {
    var v = game.view;
    var show = game.phase === 'ended';
    $('ov-result').classList.toggle('hidden', !show);
    if (!show) { lastResultSig = ''; return; }
    var sig = (v.winner || '') + (v.winReason || '');
    if (sig === lastResultSig) return;
    lastResultSig = sig;

    var iWon = (v.role === 'imp' && v.winner === 'imp') || (v.role === 'crew' && v.winner === 'crew');
    $('result-title').textContent = v.winner === 'crew'
      ? (v.role === 'crew' ? 'CREWMATES WIN' : 'CREWMATES WIN')
      : 'IMPOSTORS WIN';
    $('result-title').style.color = v.winner === 'crew' ? '#7fd4ff' : '#ff6b6b';
    $('result-sub').textContent = (v.winReason || '') + (iWon ? '  —  you won!' : '  —  you lost.');

    var body = $('result-body');
    body.innerHTML = '';
    var reveal = v.reveal || game.view.reveal || null;
    if (!reveal) {
      // build a reveal from the public state
      reveal = game.order.map(function (id) {
        var p = game.players[id];
        return { name: p.name, color: p.color, role: p.role, alive: p.alive };
      });
    }
    reveal.forEach(function (r) {
      var row = G.el('div', { class: 'player-chip' }, [
        G.el('img', { class: 'avatar', src: G.crewmateDataUrl(r.color, 36, !r.alive), style: 'width:26px;height:26px', alt: '' }),
        G.el('span', { class: 'name', text: r.name }),
        G.el('span', { class: 'badge', text: r.role === 'imp' ? 'impostor' : 'crewmate', style: 'color:' + (r.role === 'imp' ? '#ff6b6b' : '#7fd4ff') }),
        !r.alive ? G.el('span', { class: 'tag', text: 'dead' }) : null
      ]);
      body.appendChild(row);
    });
    $('btn-rematch').classList.toggle('hidden', !game.isHost);
  }

  /* ====================================================================== */
  /*  actions                                                               */
  /* ====================================================================== */

  /** Opening a task screen stops you moving, like in the real game. */
  function freezeMovement(frozen) {
    state.frozen = !!frozen;
    if (frozen) {
      G.input.x = 0;
      G.input.y = 0;
      if (game.isHost && game.players.host) {
        game.players.host.inx = 0;
        game.players.host.iny = 0;
      } else {
        net.send({ t: 'input', x: 0, y: 0 });
      }
    }
  }

  function actUse() {
    if (game.phase !== 'play') return;
    var v = game.view;
    var me = G.localPlayer();
    if (!me || !me.alive || v.inVent) return;
    if (G.tasks.isOpen()) return;
    var st = G.nearestStation(game, me, G.consts.USE_RANGE);
    if (!st) return;
    var mine = null;
    for (var i = 0; i < v.tasks.length; i++) {
      if (v.tasks[i].id === st.id && !v.tasks[i].done) { mine = v.tasks[i]; break; }
    }
    if (!mine) { sfx('denied'); return; }
    sfx('click');
    state.taskStation = st;
    freezeMovement(true);
    G.tasks.open(st, function () {
      state.taskStation = null;
      freezeMovement(false);
      if (game.isHost) G.host.doTask(game, net, game.players.host, st.id);
      else net.send({ t: 'task', stationId: st.id });
    }, function () {
      state.taskStation = null;
      freezeMovement(false);
    });
  }

  function actKill() {
    if (game.phase !== 'play') return;
    if (game.view.role === 'imp') sfx('kill');
    if (game.isHost) G.host.tryKill(game, net, game.players.host);
    else net.send({ t: 'kill' });
  }

  function actReport() {
    if (game.phase !== 'play') return;
    var me = G.localPlayer();
    if (!me) return;
    var best = null, bd = G.consts.REPORT_RANGE * G.consts.REPORT_RANGE;
    game.bodies.forEach(function (b) {
      var d = G.dist2(b.x, b.y, me.x, me.y);
      if (d < bd) { bd = d; best = b; }
    });
    if (!best) { sfx('denied'); return; }
    sfx('meeting');
    if (game.isHost) G.host.tryReport(game, net, me, best.id);
    else net.send({ t: 'report', bodyId: best.id });
  }

  function actEmergency() {
    if (game.phase !== 'play') return;
    sfx('meeting');
    if (game.isHost) G.host.tryEmergency(game, net, game.players.host);
    else net.send({ t: 'emergency' });
  }

  function actVent() {
    if (game.phase !== 'play') return;
    if (game.view.role !== 'imp') return;
    sfx('vent');
    if (game.isHost) G.host.tryVent(game, net, game.players.host);
    else net.send({ t: 'vent' });
  }

  function actSabotage() {
    if (game.phase !== 'play') return;
    if (game.view.role !== 'imp') return;
    sfx('click');
    if (game.isHost) G.host.trySabotage(game, net, game.players.host, 'lights');
    else net.send({ t: 'sabotage', kind: 'lights' });
  }

  function actFixLights() {
    if (game.phase !== 'play') return;
    sfx('click');
    if (game.isHost) G.host.tryFixLights(game, net, game.players.host);
    else net.send({ t: 'fix-lights' });
  }

  function sendVote(target) {
    if (game.phase !== 'meeting') return;
    if (state.voteSent) return;
    if (game.isHost) G.host.doVote(game, net, game.players.host, target);
    else net.send({ t: 'vote', target: target });
    state.voteSent = target;
    updateMeetingOverlay();
  }

  function sendChat() {
    var input = $('chat-input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (game.isHost) G.host.doChat(game, net, game.players.host, text);
    else net.send({ t: 'chat', text: text });
  }

  function toggleMap(force) {
    var ov = $('ov-map');
    var show = force === undefined ? ov.classList.contains('hidden') : force;
    ov.classList.toggle('hidden', !show);
    if (show) drawMapOverlay();
  }

  function drawMapOverlay() {
    var c = $('map-canvas');
    if (!c) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var cssW = c.clientWidth || 600;
    var cssH = cssW * 0.6;
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    c.style.height = cssH + 'px';
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    G.render.drawMap(ctx, game, { waypoint: state.waypoint });
  }

  function fullscreenToggle() {
    if (G.isFullscreen()) G.exitFullscreen();
    else G.requestFullscreen();
  }

  /* ====================================================================== */
  /*  main loop                                                             */
  /* ====================================================================== */

  var lastFrame = 0;
  var snapAcc = 0;
  var running = false;

  function frame(ts) {
    if (!running) return;
    game = gameRef();
    requestAnimationFrame(frame);
    var now = ts || G.nowMs();
    var dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0.016;
    lastFrame = now;

    if (state.screen !== 'game') return;

    if (game.isHost) {
      game.time += dt;
      G.host.tick(game, net, dt);
      syncHostView();
      snapAcc += dt;
      if (snapAcc >= 1 / G.consts.SNAPSHOT_HZ) {
        snapAcc = 0;
        G.host.broadcastSnapshot(game, net);
      }
    } else {
      game.time += dt;
      smoothPlayers(dt);
    }

    // push the joystick / keyboard vector to the simulation
    if (game.isHost) {
      var me = game.players.host;
      if (me) {
        me.inx = state.frozen ? 0 : G.input.x;
        me.iny = state.frozen ? 0 : G.input.y;
      }
    } else {
      sendInputThrottled(dt);
    }

    G.render.draw(game, dt);
    updateHud(dt);

    if (game.phase !== state.lastPhase) {
      onPhaseChange(state.lastPhase, game.phase);
      state.lastPhase = game.phase;
    }
    if (game.phase === 'meeting') updateMeetingOverlay();
    if (game.phase === 'ended') updateResultOverlay();
    if (game.phase === 'play' || game.phase === 'reveal') {
      $('ov-meeting').classList.add('hidden');
      $('ov-result').classList.add('hidden');
    }
  }

  var inputAcc = 0;
  function sendInputThrottled(dt) {
    inputAcc += dt;
    if (inputAcc < 1 / 20) return;
    inputAcc = 0;
    net.send({ t: 'input', x: state.frozen ? 0 : G.input.x, y: state.frozen ? 0 : G.input.y });
  }

  function onPhaseChange(from, to) {
    if (to === 'meeting' || to === 'lobby' || to === 'ended') {
      state.frozen = false;
    }
    if (to === 'meeting') {
      sfx('meeting');
      state.lastVoteSecond = null;
      state.voteSent = null;
      lastMeetingSig = '';
      state.chatCount = -1;
      toggleMap(false);
      if (G.tasks.isOpen()) G.tasks.close(true);
    }
    if (to === 'play' && from === 'meeting') {
      state.voteSent = null;
      lastMeetingSig = '';
    }
    if (to === 'ended') {
      if (G.tasks.isOpen()) G.tasks.close(true);
      toggleMap(false);
      var v = game.view;
      var iWon = (v.role === 'imp' && v.winner === 'imp') || (v.role === 'crew' && v.winner === 'crew');
      sfx(iWon ? 'win' : 'lose');
    }
    if (to === 'lobby') {
      G.lobbyState = null;
      state.lastLobbyCount = -1;
    }
  }

  /* ====================================================================== */
  /*  wiring up                                                             */
  /* ====================================================================== */

  function bindMenu() {
    $('btn-create').addEventListener('click', function () {
      currentName();
      menuStatus('Creating room…', 'wait');
      $('btn-create').disabled = true;
      G.requestFullscreen();
      net.host(null, profile(), function (err, code) {
        $('btn-create').disabled = false;
        if (err) {
          menuStatus(friendlyError(err), 'err');
          return;
        }
        G.host.init(game, net);
        game.phase = 'lobby';
        game.view.youId = 'host';
        // the host is the first player
        var p = G.host.makePlayer(game, 'host', state.myName, state.touch);
        p.sessionId = G.sessionKey();
        p.host = true;
        game.players.host = p;
        game.order.push('host');
        menuStatus('');
        G.host.pushLobby(game, net);
        setScreen('lobby');
      });
    });

    $('btn-join').addEventListener('click', function () {
      $('join-panel').classList.toggle('hidden');
      $('in-code').focus();
    });

    $('in-code').addEventListener('input', function () {
      this.value = this.value.replace(/\D/g, '').slice(0, 4);
    });

    $('in-code').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('btn-join-go').click();
    });

    $('btn-join-go').addEventListener('click', function () {
      var code = $('in-code').value.trim();
      if (!/^\d{4}$/.test(code)) { menuStatus('Enter the 4-digit room code.', 'err'); return; }
      joinRoom(code);
    });
  }

  function friendlyError(err) {
    var msg = (err && (err.message || err.type)) || 'Unknown error';
    if (/peer-unavailable/i.test(msg)) return 'No room with that code.';
    if (/browser is not supported|is not supported/i.test(msg)) return 'This browser cannot do WebRTC. Try Chrome, Edge, Firefox or Safari.';
    if (/network|timeout|socket/i.test(msg)) return 'Network problem reaching the matchmaking server. Check your internet.';
    return msg;
  }

  function joinRoom(code) {
    currentName();
    menuStatus('Connecting to room ' + code + '…', 'wait');
    $('btn-join-go').disabled = true;
    G.requestFullscreen();
    net.join(code, profile(), function (err) {
      $('btn-join-go').disabled = false;
      if (err) { menuStatus(friendlyError(err), 'err'); return; }
      G.client.init(game, net);
      menuStatus('');
      setScreen('lobby');
      $('lobby-status').textContent = 'Joined room ' + code + '. Waiting for the host…';
    });
  }

  function bindLobby() {
    $('btn-leave').addEventListener('click', function () {
      net.destroy();
      location.reload();
    });

    $('btn-copy').addEventListener('click', function () {
      copyText(joinUrl(net.code || ''), this);
    });

    $('btn-start').addEventListener('click', function () {
      if (!game.isHost) return;
      G.host.startGame(game, net, {
        impostors: parseInt($('sel-impostors').value, 10),
        speed: parseFloat($('sel-speed').value)
      });
    });

    $('sel-impostors').addEventListener('change', pushSettings);
    $('sel-speed').addEventListener('change', pushSettings);
  }

  function pushSettings() {
    if (!game.isHost) return;
    game.settings.impostors = parseInt($('sel-impostors').value, 10);
    game.settings.speed = parseFloat($('sel-speed').value);
    G.host.pushLobby(game, net);
  }

  function copyText(text, button) {
    function done() {
      if (!button) return;
      var old = button.textContent;
      button.textContent = 'Copied!';
      setTimeout(function () { button.textContent = old; }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(ta);
  }

  function bindGame() {
    $('btn-map').addEventListener('click', function () { toggleMap(); });
    $('btn-close-map').addEventListener('click', function () { toggleMap(false); });
    $('btn-fullscreen').addEventListener('click', fullscreenToggle);
    $('btn-sound').addEventListener('click', function () {
      var muted = G.audio ? G.audio.toggleMute() : true;
      this.textContent = muted ? '🔇' : '🔊';
      G.toast(muted ? 'Sound off' : 'Sound on', null, 1200);
    });
    $('act-use').addEventListener('click', actUse);
    $('act-kill').addEventListener('click', actKill);
    $('act-report').addEventListener('click', actReport);
    $('act-sabotage').addEventListener('click', actSabotage);
    $('btn-fix-lights').addEventListener('click', actFixLights);
    $('btn-emergency').addEventListener('click', actEmergency);
    $('btn-skip').addEventListener('click', function () { sendVote('skip'); });
    $('btn-chat-send').addEventListener('click', sendChat);
    $('chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
      e.stopPropagation();
    });
    $('btn-task-cancel').addEventListener('click', function () { G.tasks.close(true); });
    $('btn-rematch').addEventListener('click', function () {
      if (game.isHost) G.host.rematch(game, net);
      else net.send({ t: 'rematch' });
    });
    $('btn-exit').addEventListener('click', function () { location.reload(); });

    $('map-canvas').addEventListener('click', function (e) {
      var rect = this.getBoundingClientRect();
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      var cw = this.width / dpr, ch = this.height / dpr;
      var pad = 12;
      var scale = Math.min((cw - pad * 2) / G.WORLD_W, (ch - pad * 2) / G.WORLD_H);
      var wx = (e.clientX - rect.left - pad) / scale;
      var wy = (e.clientY - rect.top - pad) / scale;
      if (wx < 0 || wy < 0 || wx > G.WORLD_W || wy > G.WORLD_H) return;
      state.waypoint = { x: wx, y: wy };
      drawMapOverlay();
      G.toast('Waypoint set.');
    });

    // input action hooks
    G.input.actions.use = actUse;
    G.input.actions.kill = actKill;
    G.input.actions.report = actReport;
    G.input.actions.meeting = actEmergency;
    G.input.actions.vent = actVent;
    G.input.actions.map = function () { toggleMap(); };
    G.input.actions.sendChat = sendChat;
    G.input.actions.escape = function () {
      if (G.tasks.isOpen()) { G.tasks.close(true); return; }
      if (!$('ov-map').classList.contains('hidden')) { toggleMap(false); return; }
    };
  }

  /* ====================================================================== */
  /*  events                                                                */
  /* ====================================================================== */

  function bindEvents() {
    G.on('lobby-changed', function () {
      if (state.screen === 'lobby') renderLobby();
      var n = (G.lobbyState && G.lobbyState.players) ? G.lobbyState.players.length : 0;
      if (state.lastLobbyCount >= 0 && n > state.lastLobbyCount) sfx('join');
      state.lastLobbyCount = n;
    });

    G.on('screen', function (name) { setScreen(name); });

    G.on('welcome', function () { setScreen('lobby'); });

    G.on('event', function (msg) {
      if (msg.kind === 'role') {
        game.view.role = msg.role;
        game.view.tasks = (msg.tasks || []).map(function (t) {
          return { id: t.id, done: false, name: t.name, room: t.room, x: t.x, y: t.y, task: t.task };
        });
        game.view.mates = msg.mates || [];
        state.lastTaskSig = '';
        showRoleOverlay(msg);
      }
    });

    G.on('role-revealed', function (msg) { showRoleOverlay(msg); });

    G.on('round-started', function () {
      setScreen('game');
      state.lastPhase = null;
      state.waypoint = null;
      lastMeetingSig = '';
      lastResultSig = '';
      state.chatCount = -1;
      state.lastTaskSig = '';
    });

    G.on('snapshot', function (snap) {
      if (state.screen !== 'game') setScreen('game');
    });

    G.on('snapshot-applied', function () {
      if (state.screen !== 'game' && (game.phase === 'play' || game.phase === 'reveal' || game.phase === 'meeting')) {
        setScreen('game');
      }
    });

    G.on('host-gone', function () {
      G.toast('The host disconnected.', 'err');
    });

    G.on('kicked', function () { setTimeout(function () { location.reload(); }, 2200); });

    G.on('net-error', function (err) { G.toast(friendlyError(err), 'err'); });

    G.on('signaling-lost', function () { G.toast('Reconnecting to the matchmaking server…'); });

    G.on('neterror', function (err) { console.warn('net', err); });

    G.on('task-result', function (msg) {
      if (msg.ok) {
        sfx('taskDone');
        G.toast('Task complete!', 'ok', 1500);
        state.lastTaskSig = '';
      } else if (msg.reason === 'not-yours') {
        sfx('denied');
        G.toast('That task is not yours.', 'err', 1600);
      }
    });

    G.on('kill-result', function (msg) {
      if (msg.ok) G.toast('Kill!', 'ok', 1200);
      else if (msg.reason === 'cooldown') { sfx('denied'); G.toast('Kill is still on cooldown.', 'err', 1400); }
      else if (msg.reason === 'no-target') { sfx('denied'); G.toast('Nobody in range.', 'err', 1400); }
    });

    G.on('emergency-result', function (msg) {
      if (msg.ok) return;
      sfx('denied');
      if (msg.reason === 'used') G.toast('You already used your emergency meeting.', 'err');
      else if (msg.reason === 'far') G.toast('You must stand at the button in the Cafeteria.', 'err');
    });

    G.on('task-complete', function (stationId) {
      var me = G.localPlayer();
      var st = G.stationById[stationId];
      if (me && st) G.render.addFloat(st.x, st.y, '✔', '#52d273', 30);
    });

    G.on('kill', function () {
      var me = G.localPlayer();
      if (me) G.render.addFloat(me.x, me.y, '💀', '#ff6b6b', 30);
    });

    G.on('sabotage', function (msg) {
      G.lightsOut = true;
      sfx('sabotage');
      G.toast(msg.by ? (msg.by + ' sabotaged the lights!') : 'The lights were sabotaged!', 'err', 3200);
    });

    G.on('sabotage-ended', function () {
      G.lightsOut = false;
      sfx('repair');
      G.toast('The lights are back on.', 'ok', 1800);
    });

    G.on('sabotage-result', function (msg) {
      if (msg.ok) G.toast('Lights sabotaged!', 'ok', 1500);
      else {
        sfx('denied');
        if (msg.reason === 'active') G.toast('A sabotage is already active.', 'err', 1600);
        else if (msg.reason === 'cooldown') G.toast('Sabotage is still recharging.', 'err', 1600);
      }
    });

    G.on('fix-result', function (msg) {
      if (msg.ok) G.toast('Lights fixed!', 'ok', 1600);
      else if (msg.reason === 'far') { sfx('denied'); G.toast('You must fix the lights from Electrical.', 'err', 1800); }
    });
  }

  /* ====================================================================== */
  /*  start                                                                 */
  /* ====================================================================== */

  ui.start = function () {
    cacheRefs();
    state.touch = G.isMobileDevice();

    $('in-name').value = loadName();
    $('btn-fullscreen').classList.toggle('hidden', !G.isMobileDevice());
    if (G.audio) {
      $('btn-sound').textContent = G.audio.muted ? '🔇' : '🔊';
    }

    if (state.touch) {
      $('in-name').value = loadName() || 'Player';
      $('in-name').readOnly = false;
      G.input.enableTouch(true);
    }

    // deep link: ?room=1234
    var params = new URLSearchParams(location.search);
    var preCode = params.get('room');
    if (preCode && /^\d{4}$/.test(preCode)) {
      $('join-panel').classList.remove('hidden');
      $('in-code').value = preCode;
    }

    G.render.init($('game-canvas'));
    bindMenu();
    bindLobby();
    bindGame();
    bindEvents();

    if (!G.PeerAvailable) {
      menuStatus('Could not load the networking library (peerjs). Check your internet connection and reload.', 'err');
      $('btn-create').disabled = true;
      $('btn-join-go').disabled = true;
    }

    var hint = document.getElementById('rotate-hint');
    if (hint) hint.classList.toggle('hidden', !state.touch);

    setScreen('menu');
    running = true;
    requestAnimationFrame(frame);

    G.emit('app-ready');
  };

  /* keep the HUD honest about the joystick on touch devices */
  G.on('app-ready', function () {
    if (state.touch) document.body.classList.add('touch');
  });

})(window.G = window.G || {});
