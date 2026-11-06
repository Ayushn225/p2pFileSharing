# P2P File Sharing in the Browser

Send files directly from one browser to another using **WebRTC**. A small
Node.js server introduces the two peers. After that, data flows peer to peer
and never touches the server.

> **Status:** working prototype, deployed and tested: a phone and a laptop can join a room and
> send files to each other over a direct, encrypted WebRTC data channel (the receiver accepts each file,
> large files stream to disk, and a SHA-256 checksum is verified before the file is saved). See [Known limitations](#known-limitations).
>
> **Live demo:** https://p2pfilesharing.onrender.com
> (free hosting: the first visit after a quiet period can take about a minute while the server wakes up)

## Features

- Rooms for two people, with a shareable link (`/?room=...`) and an unguessable random room ID generator
- Text chat and file transfer over a direct WebRTC data channel (nothing but signaling goes through the server)
- Large files: sent in 16 KB chunks with backpressure, several files queued one after another
- Per-file progress bars on both sides, "Delivered" confirmation from the receiver, image previews
- Chat history that survives a refresh (stored in your own browser, per room)
- Joined / left / reconnecting messages, Leave button
- Optional TURN relay for networks that block direct connections (configured with environment variables)

## How it works

```
 Browser A  ──(offer / answer / ICE via Socket.IO)──  Node server  ──  Browser B
     │                                                                    │
     └────────────────── RTCDataChannel (direct, encrypted) ──────────────┘
```

1. Both users enter a name and the same room ID in the lobby (the link becomes `/?room=abc`). Leaving the room ID empty creates a new random room. A room holds at most 2 people.
2. The **signaling server** (Express + Socket.IO) tells the waiting peer that someone joined, and only relays offers, answers and ICE candidates between the two people in the same room.
3. The waiting peer (the **caller**) creates a data channel and an SDP **offer**. The newcomer (the **callee**) replies with an **answer**.
4. Both peers exchange **ICE candidates** (network addresses, found with STUN) through the server.
5. Once ICE finds a working path, the **RTCDataChannel** opens and the peers talk directly. If no direct path exists, a **TURN** relay (when configured) carries the encrypted traffic instead.

The server only relays a few KB of signaling messages. It never sees the data being sent.

## Tech stack

- **Frontend:** plain JavaScript, WebRTC (`RTCPeerConnection`, `RTCDataChannel`)
- **Backend:** Node.js (>= 18), Express, Socket.IO (signaling only)
- **NAT traversal:** Google public STUN server, plus an optional TURN server

## Getting started

```bash
git clone https://github.com/Ayushn225/p2pFileSharing.git
cd p2pFileSharing
npm install
npm run dev
```

Open `http://localhost:3000` in **two** browser tabs, enter a different name in each and
the same room ID (or leave it empty in the first tab, then use "Copy Link" and open the link in the second).
When the status shows "connected" you can chat and attach files.
(Use two different names while testing in one browser: chat history is saved per room and name.)

## Configuration

Everything works without configuration. Set these environment variables on your host to change behaviour:

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (hosts set this automatically; default `3000`) |
| `TURN_URLS` | Comma separated TURN URLs, e.g. `turn:host:3478,turns:host:443?transport=tcp` |
| `TURN_USERNAME` | TURN username |
| `TURN_CREDENTIAL` | TURN password / credential |

TURN is only used when all three `TURN_*` variables are set. The browser fetches the ICE settings from `/ice-config`
before joining a room, so credentials never live in the repository. They are visible to visitors of the site (that is
how TURN works), so use a free-tier account you can rotate.

Handy URL switch: add `&relay=1` to the room link on **both** devices to force all traffic through TURN. If that
connects, your TURN server works.

## Deploying and testing

Step-by-step instructions (pre-deploy checklist, Render setup, TURN, and a phone -> laptop test) are in
**[docs/DEPLOY.md](docs/DEPLOY.md)**.

After deploying, check the server from your terminal:

```bash
npm run smoke -- https://your-app.onrender.com
```

It tests the page, `/healthz`, `/ice-config` and the signaling flow (join, relay, room full, outsider blocked).
WebRTC itself needs two real devices: see "Phone -> laptop test" in the deploy guide.

## Project structure

```
server.js            Express static server + Socket.IO signaling (rooms, offer/answer/ICE relay, /ice-config, /healthz)
public/
  index.html         Lobby + chat views
  lobby.js           Lobby form, name/room validation, random room ID, `?room=` handling
  signaling.js       Socket.IO client: rooms, offer/answer/ICE exchange, ICE candidate queue
  peer.js            Peer connection, data channel, chunked file transfer, send queue, input validation
  ui.js              All DOM code: chat bubbles, file bubbles with progress, system messages, views
  storage.js         Chat history saved per room in localStorage
  app.js             Early experiment: two peers connected in a single tab (loopback)
scripts/
  smoke-test.js      Checks a running server (local or deployed)
docs/
  DEPLOY.md          Pre-deploy checklist, deployment, TURN, phone -> laptop test
  LEARNING_PLAN.md   Concepts to learn and the detailed milestone plan
```

## Roadmap

- [x] Loopback: two peers in one tab
- [x] Signaling server with 2-person rooms
- [x] Peer connection across two tabs, text over a data channel
- [x] Text chat over the data channel
- [x] Send a small file (metadata + single buffer, image preview, download link)
- [x] Chunking + backpressure for large files
- [x] Sequential send queue (several files at once)
- [x] Connection cleanup (stale-event guards, safe reconnects)
- [x] Lobby, names, shareable room link, Leave button
- [x] System messages (joined / left / reconnecting) and chat history that survives a refresh
- [x] Transfer progress bar with delivery confirmation
- [x] Hardening: signal relay limited to the same room, input validation, random room IDs
- [x] Optional TURN support, ICE candidate queue, smoke test
- [x] Deployed on a free host (HTTPS) and tested phone <-> laptop
- [ ] TURN relay for strict networks (supported in the code, but the live demo has none configured yet)
- [ ] Refresh-safe seat reservation (no "left / joined" flicker on refresh)
- [ ] Mobile layout polish
- [x] Receiver accepts first; large files stream to disk (File System Access API, OPFS fallback); SHA-256 checked before saving
- [ ] Stretch: pause/resume, drag-and-drop
- [ ] Waiting queue for full rooms

## Known limitations

- A **page refresh** shows "left" and then "joined" (a WebRTC connection cannot survive a refresh; seat reservation is planned).
- Files are limited to **10 GB**. Browsers without File System Access or OPFS support fall back to keeping the file in memory and can only receive files up to **500 MB**.
- Received files are not kept by the app: after a refresh the chat history shows them as "No longer available". In browsers that use browser storage (OPFS), a file waits there until you leave, refresh or clear the chat, so download it first.
- Two people per room, and the same person in two tabs counts as two people.
- Without a TURN server, some networks (strict firewalls, some mobile carriers) cannot connect. The live demo currently uses STUN only.
- **Firefox:** in testing, two Firefox tabs on the *same machine* failed to connect ("ICE failed") while Chrome worked.
  The likely cause is how Firefox handles local network addresses, not the app, and a TURN relay avoids it. Connecting Firefox
  to another device has not been verified yet. For local testing use Chrome or two devices; you can also try setting
  `media.peerconnection.ice.obfuscate_host_addresses` to `false` in `about:config` (pref names can change between versions).
- The mobile layout has not been polished yet.

## Debugging tips

- `chrome://webrtc-internals` (Chrome) and `about:webrtc` (Firefox) show every peer connection, its candidates and state.
- If a connection stays at `connecting` and then `failed`, turn off any VPN, try another network, or configure TURN.
- `npm run dev` only restarts the server when `server.js` changes, so editing files in `public/` just needs a browser refresh.

## License

ISC
