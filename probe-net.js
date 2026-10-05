/* ==========================================================================
   probe-net.js — checks that PeerJS cloud signalling is reachable from here.

   This is the one thing the Node test suites cannot cover, and it is the most
   common reason "Host a game" appears to do nothing on a locked-down network.
   Node has no WebRTC, so instead of opening a real Peer we open the same
   WebSocket the PeerJS client would use and confirm the server answers.

     node probe-net.js
   ========================================================================== */
const HOST = '0.peerjs.com';
const PORT = 443;
const KEY = 'peerjs';
// PeerJS builds exactly this: (wss|ws)://host:port + "/peerjs?key=" + key
const URL = 'wss://' + HOST + ':' + PORT + '/peerjs?key=' + KEY +
  '&id=crewmate-au-v1-probe' + Math.floor(Math.random() * 1e6) +
  '&token=' + Math.random().toString(36).slice(2);

const WS = typeof WebSocket !== 'undefined' ? WebSocket : null;

console.log('Checking PeerJS cloud signalling …');
console.log('  ' + URL.replace(/token=.*/, 'token=…'));
console.log('');

if (!WS) {
  console.log('ℹ️  This Node build has no global WebSocket, so the probe cannot run.');
  console.log('   That is fine — browsers always provide one. Verify by loading the');
  console.log('   game in a browser and pressing "Host a game".');
  process.exit(0);
}

const started = Date.now();
let settled = false;

function finish(ok, message) {
  if (settled) return;
  settled = true;
  const ms = Date.now() - started;
  console.log((ok ? '✅ ' : '❌ ') + message + '  (' + ms + ' ms)');
  if (!ok) {
    console.log('');
    console.log('   The matchmaking server could not be reached. Possible causes:');
    console.log('   • no internet connection');
    console.log('   • a firewall, VPN or school proxy blocking wss://0.peerjs.com:443');
    console.log('   • unpkg/peerjs being blocked by DNS filtering');
    console.log('');
    console.log('   You can point the game at your own PeerJS server in src/net.js');
    console.log('   (see the README section on troubleshooting).');
  } else {
    console.log('');
    console.log('   Signalling works from this machine, so "Host a game" will connect.');
    console.log('   (Players still need to reach each other directly — see the README');
    console.log('    note about TURN if some mobile networks fail to join.)');
  }
  process.exit(ok ? 0 : 1);
}

let socket;
try {
  socket = new WS(URL);
} catch (e) {
  finish(false, 'could not open the socket: ' + e.message);
}

if (socket) {
  socket.onopen = function () {
    finish(true, 'signalling server accepted the WebSocket connection');
  };
  socket.onerror = function () {
    finish(false, 'the signalling server refused or dropped the connection');
  };
  socket.onclose = function (ev) {
    if (!settled) finish(false, 'the connection closed early (code ' + (ev && ev.code) + ')');
  };
}

setTimeout(function () { finish(false, 'timed out after 15s'); }, 15000);
