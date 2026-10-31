# P2P File Sharing in the Browser

Send files directly from one browser to another using **WebRTC**. A small
Node.js server introduces the two peers. After that, data flows peer to peer
and never touches the server.

> 🚧 **Work in progress.** Two browsers can join a room, chat, and send files of any
> size over a direct WebRTC data channel (chunked, with backpressure). A progress bar
> and a public deployment are next.

## How it works

```
 Browser A  ──(offer / answer / ICE via Socket.IO)──  Node server  ──  Browser B
     │                                                                    │
     └────────────────── RTCDataChannel (direct, encrypted) ──────────────┘
```

1. Both users enter a name and the same room ID in the lobby (the link becomes `/?room=abc`). A room holds at most 2 people.
2. The **signaling server** (Express + Socket.IO) tells the waiting peer that someone joined.
3. The waiting peer (the **caller**) creates a data channel and an SDP **offer**. The newcomer (the **callee**) replies with an **answer**.
4. Both peers exchange **ICE candidates** (network addresses, found with a STUN server) through the server.
5. Once ICE finds a working path, the **RTCDataChannel** opens and the peers talk directly.

The server only relays a few KB of signaling messages. It never sees the data being sent.

## Tech stack

- **Frontend:** plain JavaScript, WebRTC (`RTCPeerConnection`, `RTCDataChannel`)
- **Backend:** Node.js, Express, Socket.IO (signaling only)
- **NAT traversal:** Google public STUN server

## Getting started

```bash
git clone https://github.com/Ayushn225/p2pFileSharing.git
cd p2pFileSharing
npm install
npm run dev
```

Open `http://localhost:3000` in **two** browser tabs, enter a different name in each and
the same room ID. When the status shows "connected" you can chat and attach files.
(Use two different names while testing in one browser: chat history is saved per room and name.)

## Project structure

```
server.js            Express static server + Socket.IO signaling (rooms, offer/answer/ICE relay)
public/
  index.html         Lobby + chat views
  lobby.js           Lobby form, name/room validation, `?room=` handling
  signaling.js       Socket.IO client: rooms, offer/answer/ICE exchange
  peer.js            Peer connection, data channel, chunked file transfer, send queue
  ui.js              All DOM code: chat bubbles, system messages, file badge, views
  storage.js         Chat history saved per room in localStorage
  app.js             Early experiment: two peers connected in a single tab (loopback)
docs/
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
- [ ] Transfer progress bar
- [ ] Deployment (HTTPS, free host) and a TURN server for strict networks
- [ ] Refresh-safe seat reservation (no "left / joined" flicker on refresh)
- [ ] Stretch: transfer speed, pause/resume, integrity hash, drag-and-drop
- [ ] Waiting queue for full rooms

## Debugging tips

- `chrome://webrtc-internals` shows every peer connection, its candidates and state.
- If a connection stays at `connecting` → `failed`, try turning off your VPN or firewall.

## License

ISC
