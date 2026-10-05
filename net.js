/* ==========================================================================
   net.js — networking over WebRTC (PeerJS)
   ---------------------------------------------------------------------------
   The host owns an authoritative Peer and every player opens a DataConnection
   to it. A 4-digit room code maps to the deterministic peer id `crw-<code>`.

   Host  : sends 'welcome', 'lobby', 'snapshot', 'event'
   Client: sends 'join', 'input', 'action', 'task'

   Routing uses an explicit `to` field. Clients address packets to
   'host' or to a player id; the host relays them.
   ========================================================================== */
(function (G) {
  'use strict';

  var ID_PREFIX = 'crewmate-au-v1-';

  function peerIdFor(code) { return ID_PREFIX + code; }

  function randomCode() {
    // avoid leading zero so it always renders as 4 digits, and skip codes
    // that are easy to mis-hear over a phone.
    var c;
    do {
      c = String(1000 + Math.floor(Math.random() * 9000));
    } while (/^(\d)\1{3}$/.test(c));
    return c;
  }

  /* ------------------------------------------------------------------ */

  function Net() {
    this.role = null;          // 'host' | 'client'
    this.peer = null;
    this.code = null;
    this.conns = {};           // host only: playerId -> DataConnection
    this.conn = null;          // client only
    this.playerId = null;
    this.hostId = 'host';
    this.connected = false;
    this.handlers = {};
    this._closed = false;
    this._reconnectTimer = null;
  }

  Net.prototype.on = function (type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
    return this;
  };

  Net.prototype.emit = function (type, payload) {
    var list = this.handlers[type];
    if (!list) return;
    for (var i = 0; i < list.length; i++) list[i](payload);
  };

  Net.prototype._fail = function (err) {
    if (this._closed) return;
    this.emit('error', err instanceof Error ? err : new Error(String(err)));
  };

  /* ---------------- host ------------------------------------------------ */

  Net.prototype.host = function (desiredCode, profile, cb) {
    var self = this;
    this.role = 'host';
    this.playerId = 'host';

    var attempt = 0;
    var code = desiredCode || randomCode();

    function tryCode() {
      if (self._closed) return;
      var peer;
      try {
        peer = new Peer(peerIdFor(code), {
          debug: 0,
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:global.stun.twilio.com:3478' }
            ]
          }
        });
      } catch (e) { self._fail(e); return; }

      self.peer = peer;
      self.code = code;

      var settled = false;

      peer.on('open', function () {
        if (settled) return;
        settled = true;
        self.connected = true;
        cb(null, code);
      });

      peer.on('connection', function (conn) { self._accept(conn, profile); });

      peer.on('error', function (err) {
        var type = err && err.type;
        if (!settled && (type === 'unavailable-id' || type === 'invalid-id')) {
          // room code already taken — pick another one
          try { peer.destroy(); } catch (e) {}
          attempt++;
          if (attempt > 12) { self._fail(new Error('Could not find a free room code.')); return; }
          code = randomCode();
          setTimeout(tryCode, 60);
          return;
        }
        if (type === 'peer-unavailable') return;   // a client vanished; not fatal
        if (!settled) { settled = true; self._fail(err); return; }
        self.emit('neterror', err);
      });

      peer.on('disconnected', function () {
        if (self._closed) return;
        self.emit('signaling-lost');
        try { peer.reconnect(); } catch (e) {}
      });
    }

    tryCode();
  };

  Net.prototype._accept = function (conn, profile) {
    var self = this;
    conn.on('data', function (msg) {
      if (!msg || typeof msg !== 'object') return;
      msg.from = conn._playerId || null;
      if (msg.t === 'join') {
        self.emit('join', {
          conn: conn,
          name: msg.name,
          color: msg.color,
          sessionId: msg.sessionId,
          isMobile: msg.isMobile
        });
        return;
      }
      if (!conn._playerId) return;                 // must join first
      self.emit('message', msg, conn);
    });
    conn.on('close', function () {
      if (conn._playerId) self.emit('leave', conn._playerId);
    });
    conn.on('error', function () { /* handled by close */ });
  };

  /** Register a connection as belonging to a player id. */
  Net.prototype.bindConn = function (playerId, conn) {
    conn._playerId = playerId;
    this.conns[playerId] = conn;
  };

  Net.prototype.unbindConn = function (playerId) {
    delete this.conns[playerId];
  };

  Net.prototype.sendTo = function (playerId, msg) {
    var c = playerId === 'host' ? null : this.conns[playerId];
    if (!c || !c.open) return false;
    try { c.send(msg); return true; } catch (e) { return false; }
  };

  /** Host helper: broadcast to everyone, optionally skipping one player. */
  Net.prototype.broadcast = function (msg, skipId) {
    for (var id in this.conns) {
      if (id === skipId) continue;
      this.sendTo(id, msg);
    }
  };

  /** Host helper: send to a set of player ids. */
  Net.prototype.sendToMany = function (ids, msg) {
    for (var i = 0; i < ids.length; i++) if (ids[i] !== 'host') this.sendTo(ids[i], msg);
  };

  Net.prototype.clientCount = function () {
    var n = 0;
    for (var id in this.conns) if (this.conns[id].open) n++;
    return n;
  };

  Net.prototype.kick = function (playerId, reason) {
    var c = this.conns[playerId];
    if (c) {
      try { c.send({ t: 'kicked', reason: reason || 'Removed from the game' }); } catch (e) {}
      setTimeout(function () { try { c.close(); } catch (e) {} }, 250);
    }
    delete this.conns[playerId];
  };

  /* ---------------- client --------------------------------------------- */

  Net.prototype.join = function (code, profile, cb) {
    var self = this;
    this.role = 'client';
    this.code = code;
    this.hostId = 'host';

    var peer;
    try {
      peer = new Peer({
        debug: 0,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      });
    } catch (e) { this._fail(e); return; }

    this.peer = peer;
    var settled = false;
    var timeout = setTimeout(function () {
      if (settled) return;
      settled = true;
      self._fail(new Error('Could not reach that room. Check the code and your internet connection.'));
      self.destroy();
    }, 20000);

    function done(err, data) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cb(err, data);
    }

    peer.on('open', function () {
      if (self._closed) return;
      var conn = peer.connect(peerIdFor(code), { reliable: true, serialization: 'json' });
      self.conn = conn;

      conn.on('open', function () {
        self.connected = true;
        conn.send({
          t: 'join',
          name: profile.name,
          color: profile.color,
          sessionId: profile.sessionId,
          isMobile: profile.isMobile
        });
        done(null, { code: code });
      });

      conn.on('data', function (msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'welcome') {
          self.playerId = msg.playerId;
          self.emit('welcome', msg);
          return;
        }
        if (msg.t === 'kicked') {
          self.emit('kicked', msg.reason || 'Removed from the game');
          return;
        }
        self.emit('message', msg);
      });

      conn.on('close', function () {
        if (self._closingByUs) return;
        self.connected = false;
        self.emit('hostgone');
      });

      conn.on('error', function (err) { self.emit('neterror', err); });
    });

    peer.on('error', function (err) {
      var type = err && err.type;
      if (type === 'peer-unavailable') {
        done(new Error('No room found with that code. Ask the host to check it.'));
        self.destroy();
        return;
      }
      if (!settled) { done(err); self.destroy(); return; }
      self.emit('neterror', err);
    });
  };

  /** Client helper: address a packet (defaults to the host). */
  Net.prototype.send = function (msg, to) {
    if (this.role === 'host') {           // host sending to itself is a no-op
      if (to && to !== 'host') this.sendTo(to, msg);
      return;
    }
    msg.to = to || 'host';
    msg.from = this.playerId;
    if (this.conn && this.conn.open) {
      try { this.conn.send(msg); } catch (e) { /* dropped */ }
    }
  };

  Net.prototype.destroy = function () {
    this._closed = true;
    this._closingByUs = true;
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.conns = {};
    this.conn = null;
    this.connected = false;
  };

  /* ------------------------------------------------------------------ */

  G.Net = Net;
  G.net = new Net();
  G.peerIdFor = peerIdFor;
  G.randomCode = randomCode;
  G.PeerAvailable = (typeof Peer !== 'undefined');

})(window.G = window.G || {});
