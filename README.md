# Crewmate — an Among Us style multiplayer browser game

A free, from-scratch social deduction game that runs in the browser. One player
hosts on a computer, everyone else joins from their phone by typing a 4-digit
room code. There is no game server: players connect **directly to each other**
over WebRTC.

* **One HTML file.** `dist/game.html` is completely self-contained — markup,
  styles, the PeerJS networking library and all game code are inlined. No build
  step is needed to *run* it, and there is no CDN dependency.
* **Phone and desktop are the same file.** The game detects a touch device and
  switches to a virtual joystick plus on-screen action buttons, and asks for
  fullscreen and landscape.
* **Full game loop:** Crewmate/Impostor roles, free movement around an
  8-room ship, 26 task stations with 7 different minigames, kills, dead bodies,
  body reports, emergency meetings, discussion chat, voting and ejection,
  lights sabotage, vents, ghosts, and proper win/lose conditions.
* **Safe against bad peers.** Every value in an incoming packet is sanitised,
  and the message pump is guarded, so a buggy phone or someone poking at the
  host with devtools cannot corrupt a match or stall it.
* **Sound with no asset files.** Every effect is synthesised from oscillators
  via the Web Audio API, so the single file stays a single file. There is a
  mute button in the HUD and the preference is remembered.

---

## Table of contents

1. [Play it now](#play-it-now)
2. [How to play](#how-to-play)
3. [Deploy to GitHub Pages](#deploy-to-github-pages)
4. [Project layout](#project-layout)
5. [Developing](#developing)
6. [Tests](#tests)
7. [How the networking works](#how-the-networking-works)
8. [Tuning the game](#tuning-the-game)
9. [Troubleshooting](#troubleshooting)
10. [Credits and legal](#credits-and-legal)

---

## Play it now

### Locally (test on two devices on the same Wi-Fi)

```bash
node serve.js
```

Then open the printed URL. Use `http://127.0.0.1:8899/dist/game.html` on this
computer and `http://<your-lan-ip>:8899/dist/game.html` on your phone.

> Opening `dist/game.html` straight off the disk (`file://`) also works in most
> browsers because everything is inlined, but serving it over HTTP is more
> reliable — camera, fullscreen and clipboard APIs behave better.

### Hosting

1. One person opens the page and clicks **Host a game**. A 4-digit room code
   appears.
2. Everyone else opens the same URL, clicks **Join a game** and types the code.
3. The host presses **Start game**. Four players minimum.

A direct deep link also works: `...game.html?room=1234` pre-fills the code, so
the host can just share that link.

---

## How to play

### Roles

| Role | Goal |
| --- | --- |
| **Crewmate** | Finish every assigned task, or find and eject all impostors. |
| **Impostor** | Kill the crew without being caught. Wins when impostors equal or outnumber the crew. |

The number of impostors is configurable (1–3) in the lobby. It is automatically
capped so impostors can never be a majority from the start.

### Controls

| Action | Desktop | Phone |
| --- | --- | --- |
| Move | `W A S D` or arrow keys | Drag anywhere on the joystick (bottom-left) |
| Use / do task | `E` | ⚙️ **Use** button |
| Kill (impostor) | `Q` | 🔪 **Kill** button |
| Report body | `R` | 🚨 **Report** button |
| Sabotage lights (impostor) | — | 💡 **Lights** button |
| Emergency meeting | `Space` | 📢 **Meeting** button (stand on the button in the Cafeteria) |
| Map | `M` | 🗺️ button (top-right) |
| Fullscreen | ⛶ button | ⛶ button |

### Tasks

Standing near one of your task stations shows the **Use** button. There are
seven kinds of minigame, chosen per task type:

* **Fix Wiring** — connect each coloured wire to its match.
* **Swipe Card** — drag the card across the reader in one smooth motion.
* **Download Data** — watch three progress bars fill.
* **Hold tasks** (Fuel Engines, Upload, Empty Garbage, MedBay Scan, Inspect
  Sample, Divert Power, Align Engine Output, Clean O2 Filter) — hold the button
  until the ring is full.
* **Clear Asteroids** — tap 10 asteroids.
* **Calibrate Distributor** — repeat a growing colour sequence.
* **Prime Shields / Unlock Manifolds** — press every button.

Opening a task screen stops you moving, so you are never dragged away mid-task.

### Meetings

Report a body or hit the emergency button to start a 45-second meeting. Everyone
is teleported to the Cafeteria and can chat. Vote for a player or skip; the
most-voted player is ejected (a tie ejects nobody). A meeting resolves as soon
as every *living* connected player has voted, or when the timer runs out.

### Ghosts

Dying does not end your involvement. A dead Crewmate becomes a ghost:

* you keep your task list and **can still complete your remaining tasks** —
  this is what keeps the crew's "all tasks done" victory reachable after a
  teammate dies, and without it a match could deadlock forever;
* you move freely, passing straight through walls, and see everyone (ghosts
  get a much wider field of view), so you can watch the impostor work;
* you still get one vote when a meeting is called, but you cannot report
  bodies, call meetings, or be killed again.

Ghosts see the map, the impostors and the bodies. Use it.

### Sabotage

The impostor can kill the lights. Crew vision shrinks to a small circle until
someone reaches **Electrical** and fixes them; otherwise the lights come back on
by themselves after 22 seconds.

---

## Deploy to GitHub Pages

The game is a static file, so GitHub Pages hosts it for free over HTTPS — which
also means **zero port-forwarding and no server to maintain**.

### With the GitHub website (no tools needed)

This is the easiest route, and it needs nothing installed.

1. Run `node build.js --pages` then `node pack.js`.
2. Create a new **public** repository, e.g. `crewmate`.
3. Open the new folder `release/Crewmate/` and drag **everything inside it**
   (not the folder itself) into the GitHub upload page, then commit.
4. In the repo go to **Settings → Pages**.
5. Under *Build and deployment* set **Source = Deploy from a branch**,
   **Branch = main**, **Folder = / (root)**, and press **Save**.
6. Wait a minute or two. The game is live at
   `https://<your-name>.github.io/crewmate/`.

`index.html` sits at the root of that folder and *is* the game, so the short URL
above works immediately. `dist/game.html` is the same file, kept because the
name says what it is.

### With git on the command line

```bash
git init
git add .
git commit -m "Crewmate: Among Us style multiplayer browser game"
git branch -M main
git remote add origin https://github.com/<your-name>/crewmate.git
git push -u origin main
```

Then point Pages at the repository root. The layout it expects:

```
crewmate/
├── index.html        the game — this is what Pages serves
├── dist/game.html    the same file under its descriptive name
├── src/              the sources
├── README.md
└── ...
```

### One-command release

```bash
node build.js --pages     # builds dist/game.html and a root index.html
node pack.js              # assembles release/Crewmate/
node zip.js               # optional: zips it to release/Crewmate.zip
```

`release/Crewmate/` is a self-contained copy of the whole project, ready to
upload. `index.html` at its root is the game, so GitHub Pages serves it at
`https://<your-name>.github.io/<repo>/`. `zip.js` writes the archive with
Node's own zlib, so it works even on a machine with no archiver installed.

### Automatic deployment (optional, but nice)

The repository ships `.github/workflows/deploy.yml`. Once the repository is on
GitHub with Pages set to **GitHub Actions**, every push to `main` will:

1. rebuild `dist/game.html` from source,
2. run every test suite, and
3. **only publish if they all pass** — a broken commit can never go live.

It also fails the build if the committed `index.html` is out of date, so the
deployed file always matches the sources. You can still run a deploy by hand
from the **Actions** tab (*Run workflow*).

After the first successful run you never need to upload files manually again —
`git push` is enough.

### Why HTTPS matters

WebRTC and fullscreen both require a secure context. `https://` (which GitHub
Pages gives you) and `http://localhost` work; a plain `http://` LAN address
mostly works for testing but is not guaranteed on iOS Safari.

---

## Project layout

```
.
├── dist/
│   ├── game.html          the single-file game — this is the deliverable
│   └── dev.html           same page but loading src/*.js separately (debug)
├── src/
│   ├── index.head.html    document head (meta tags, opens <style>)
│   ├── style.css          all styling, responsive + safe-area aware
│   ├── index.body.html    the markup: menu, lobby, HUD, overlays
│   ├── vendor.js          PeerJS, inlined (generated)
│   ├── utils.js           DOM helpers, event bus, toasts, fullscreen, avatars
│   ├── world.js           map grid, generated walls, stations, spawns, collision
│   ├── net.js             PeerJS host/client transport
│   ├── game.js            authoritative host simulation + client view
│   ├── tasks.js           the seven task minigames
├── render.js              canvas renderer (ship, players, fog of war, minimap)
├── input.js               keyboard, virtual joystick, touch gestures
├── audio.js               procedural sound effects (Web Audio, no assets)
├── ui.js                  screens, lobby, HUD, overlays, main loop
│   └── main.js            boot
├── vendor/peerjs.min.js   the vendored library the bundle is built from
├── build.js               inlines everything into dist/game.html
├── build-vendor.js        regenerates src/vendor.js from vendor/
├── serve.js               tiny static server for local testing
├── validate-map.js        map geometry, collision consistency, reachability
├── test-game.js           headless simulation tests (119 assertions)
├── test-runtime.js        boots the real UI against a fake DOM (100 assertions)
│   ├── test-html.js       static checks on the built bundle
│   ├── test-mobile.js     touch-control layout audit across device sizes
│   ├── test-deploy.js     is the built file safe to publish?
│   ├── test-loopback.js   real host <-> client transport test
│   ├── test-stress.js     randomized full matches with pathfinding bots
│   ├── test-game-shim.js  shared Node shim used by the tests
│   ├── test-bots.js       pathfinding bot used by the match simulations
│   ├── probe-net.js       checks PeerJS matchmaking reachability
│   ├── pack.js            assembles release/Crewmate/ for upload
│   ├── zip.js             writes release/Crewmate.zip with Node's zlib
│   ├── verify-zip.js      proves the zip matches the release folder
│   └── release/Crewmate/  the folder to drag into GitHub (generated)
├── .github/workflows/deploy.yml   tests + publishes Pages on every push
```

### The map is generated, not hand-drawn

`src/world.js` authors the ship as a small character grid:

```js
var LAYOUT = [
  '.rw',
  'mcn',
  'elx'
];
```

Rooms sit on the even cells of a 6×6 block grid; the odd rows and columns become
corridors, and **every wall is derived from the grid**. That makes it impossible
for a room to overlap a wall or for a corridor to line up incorrectly. Adding a
room means changing one character.

After generating the walls, a reconciliation pass removes both failure modes of
grid-authored maps — enclosed slivers that look like floor but cannot be entered,
and visible wall edges that do not match where a circle actually collides. It
does that with a distance field (see the tests section) rather than by hand, so
`validate-map.js` can prove the result holds.

---

## Developing

Requires Node.js (any recent version — no dependencies are installed).

```bash
node build.js --dev      # builds dist/game.html and dist/dev.html
node serve.js            # http://127.0.0.1:8899/  (see the index page)
```

`dist/dev.html` loads the individual `src/*.js` files, so you can edit and just
refresh the browser. Run `node build.js` again when you want the single file.

> If you use `dev.html`, remember that `game.html` is what you deploy. Always
> rebuild before pushing.

---

## Tests

```bash
node validate-map.js     # map geometry, collision consistency, reachability
node test-game.js        # 127 headless assertions driving real matches
node test-runtime.js     # 112 assertions booting the real UI against a fake DOM
node test-html.js        # static checks on the built bundle
node test-mobile.js      # touch-control layout across 15 phone/tablet sizes
node test-deploy.js      # is the built file safe to publish?
node test-loopback.js    # 51 assertions: a real host and client over the wire
node test-fuzz.js        # 250 hostile packets from a malicious peer
node test-stress.js 50   # 50 randomized full matches with pathfinding bots
node probe-net.js        # is the PeerJS matchmaking server reachable from here?
```

Or all of them at once with `npm test`.

`test-game.js` is the interesting one. It loads the real game modules into Node
with a small DOM shim and a fake transport, then drives complete matches through
the actual `host.tick()` loop — kills, reports, meetings, votes, task wins,
sabotage, vents, ghosts and rematches. Time is injected through `game.clock`, so
a five-minute match runs instantly and deterministically.

`test-loopback.js` goes the furthest: it wires a **real host `Net` to a real
client `Net`** through an in-process transport that does a genuine JSON round
trip on every packet. So the whole chain runs — `sendTo` → serialise → the
client's `Net` → `game.client` → `applySnapshot` → the UI's `render.draw`. This
is the suite that caught `pushLobby` never actually sending the lobby to
clients, which would have left every phone stuck on "waiting for the host" with
no player list.

`test-runtime.js` boots the real `ui.start()`, runs actual animation frames
through the menu, lobby, role reveal, play, meeting and result phases, opens
every task minigame, and asserts the HUD, ghost notice, map, sabotage banner,
share link and sound set all behave. It catches wiring mistakes that pure logic
tests cannot.

`test-fuzz.js` plays the part of a hostile peer. It fires 250 deliberately
malformed packets at every host handler — `NaN` and infinite inputs, objects
with a throwing `toString`, ids pointing at players who do not exist, 200 KB
payloads, deeply nested objects — then checks that nothing threw, that the host
loop still runs, that no position or counter became `NaN`, that nobody left the
world, and that illegal actions were refused. This is what caught the crash where
a crafted object escaped a message handler.

`test-mobile.js` parses the stylesheet, resolves the CSS (including `calc()`,
`var()` and the media queries), and computes the on-screen position of the
joystick, the emergency button and the action buttons at 15 real device sizes.
It fails if any two overlap, if a control is too small to tap, if a safe-area
inset is ignored, or if the z-order would let an overlay swallow joystick
touches. This is what caught the joystick sitting under the emergency button.

`test-stress.js` plays random matches to completion with bots that pathfind
around the ship, then asserts that no player ever ends inside a wall, out of
bounds, or walled in, and that every match actually resolves. This is the test
that caught the deadlock fixed by adding ghosts.

### Collision is exact, and that is enforced

`validate-map.js` does not merely check that rooms look right. It asserts the
invariant that makes movement trustworthy:

* every cell the ship shows as open floor is a cell a player-sized circle can
  actually stand on (no invisible walls);
* every position a player can stand in is walkable (no floor you fall through);
* every room has a doorway a player can physically fit through.

These hold because the map is not hand-drawn. `src/world.js` computes a
*Manhattan distance field* from the visible walls and keeps a cell only if its
distance exceeds the player radius, then flood-fills from the Cafeteria so
unreachable slivers become solid rock. `G.hitsWall` reads that same field, so
collision and the rendered ship cannot drift apart.

---

## How the networking works

```
   host (PC)                         phone
  ┌──────────┐   WebRTC data        ┌──────────┐
  │  Peer    │◄──── channel ───────►│  Peer    │
  │   id:    │                      │          │
  │ "crewmate-au-v1-1234"           └──────────┘
  └──────────┘
        ▲
        │  only the initial handshake goes through
        │  the free PeerJS signalling server
```

* The room code maps to a deterministic peer id, `crewmate-au-v1-<code>`, so a
  client can connect without a directory service.
* The **host is authoritative**: it owns positions, roles, tasks, kills and
  votes. Clients send only their input vector (20 Hz) and occasional actions,
  and render whatever snapshots arrive (15 Hz).
* Remote positions are interpolated, so 15 Hz looks smooth.
* Public STUN servers are used for NAT traversal. No TURN server is configured,
  which means a small number of restrictive mobile networks may fail to connect
  — see below.

### Packet types

| Direction | Type | Purpose |
| --- | --- | --- |
| client → host | `join` | name, session id, mobile flag |
| client → host | `input` | movement vector |
| client → host | `task`, `kill`, `report`, `emergency`, `vent`, `sabotage`, `fix-lights` | actions |
| client → host | `vote`, `chat` | meeting interaction |
| host → client | `welcome` | your player id |
| host → client | `lobby` | player list and settings |
| host → client | `snapshot` | world state + your private role/tasks |
| host → client | `event` | role reveal, results, sabotage, game end |
| host → client | `kicked` | refused entry (room full / already started) |

Reconnection works by session id: a player who reloads reclaims their old slot
instead of appearing twice.

---

## Tuning the game

Most balance values live at the top of `src/game.js` and are readable through
`G.consts`, so you can tweak them from the console while testing:

```js
G.consts.KILL_COOLDOWN = 15;      // seconds between kills
G.consts.MEETING_TIME = 30;       // discussion seconds
G.consts.ROLE_REVEAL_TIME = 3;    // role card duration
G.consts.USE_RANGE = 120;         // how close you must be to a task
G.consts.EMERGENCY_MEETINGS = 2;  // meetings per player
```

Lobby settings (impostor count and player speed) are chosen by the host in the
UI and stored in `game.settings`.

Map layout lives in `src/world.js` (`LAYOUT`, `ROOM_DEFS`, `S`), and task
balance in `TASK_DEFS` / `STATIONS`.

---

## Troubleshooting

**"No room found with that code."**
The host's page must stay open — the host *is* the server. Check the code, and
make sure both devices have internet for the initial handshake.

**Players connect but the game is laggy.**
Snapshots are 15 Hz by design. If the host machine is slow, lower
`G.consts.SNAPSHOT_HZ` — this sends less data but interpolates more.

**A phone on mobile data cannot join.**
Public STUN is enough on most networks, but carrier-grade NAT sometimes needs a
TURN relay. Add one to the `iceServers` lists in `src/net.js`:

```js
config: {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:your-turn-host:3478', username: 'user', credential: 'pass' }
  ]
}
```

**Fullscreen does not happen on iPhone.**
iOS Safari only allows fullscreen from a user gesture, and it does not support
`requestFullscreen` on arbitrary elements in every version. The game requests it
on the first tap and falls back gracefully; adding it to the home screen
(*Share → Add to Home Screen*) gives a fully immersive launch.

**The joystick does not appear.**
Touch mode needs a coarse pointer. On a touchscreen laptop the game may treat
you as desktop, which is usually what you want — use the keyboard there.

**I opened the file directly and my friend cannot join.**
A `file://` address only exists on your own machine, so the lobby says so
instead of showing a shareable link. Serve it (`node serve.js`, then use your
network address) or deploy it to GitHub Pages — then the link works for everyone.

---

## Credits and legal

* Code, map, art and sound design: written from scratch for this project. All
  visuals are drawn procedurally on a canvas; no image or audio assets are
  included.
* [PeerJS](https://github.com/peers/peerjs) (MIT) is bundled for the WebRTC
  signalling handshake.

**Not affiliated with Innersloth.** "Among Us" is a trademark of Innersloth LLC.
This is an original educational project inspired by the *social deduction*
genre; it uses no Among Us assets, code, audio or artwork, and it is not
endorsed by or connected to Innersloth. Please do not present it as an official
Among Us product.

MIT licensed — see [LICENSE](LICENSE).
