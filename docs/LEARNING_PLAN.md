# Learning Plan: P2P File Sharing (WebRTC)

Send files straight from one browser to another. The server only helps the two
peers find each other; the file bytes never go through it.

```
 Browser A  ──(offer / answer / ICE via Socket.IO)──  Node server  ──  Browser B
     │                                                                    │
     └──────────────── RTCDataChannel (file chunks, direct) ──────────────┘
```

---

## 1. What you need to learn

Learn these roughly in order. Don't read everything up front: learn each one
just before the milestone that needs it.

### Foundations (you probably know some of this)
- **JS async**: Promises, `async/await`, event handlers (`onX` vs `addEventListener`)
- **Node + Express**: serving a `public/` folder with `express.static`
- **Socket.IO basics**: `io.on("connection")`, `socket.emit`, `socket.on`, rooms (`socket.join`, `socket.to(room).emit`)

### WebRTC core concepts
- **Why a signaling server is needed**: WebRTC has no built-in way for peers to find each other
- **`RTCPeerConnection`**: the main object
- **SDP offer/answer**: `createOffer`, `createAnswer`, `setLocalDescription`, `setRemoteDescription`
- **ICE candidates**: `onicecandidate`, `addIceCandidate`; what STUN and TURN servers are
- **Connection states**: `connectionState`, `iceConnectionState`, how to debug them
- **`RTCDataChannel`**: `createDataChannel` (caller side) vs `ondatachannel` (receiver side)

### File handling in the browser
- `<input type="file">`, the `File` / `Blob` objects
- `Blob.slice()` and `arrayBuffer()` to read a file in chunks
- `ArrayBuffer`, and how to send binary data over a data channel
- **Backpressure**: `bufferedAmount`, `bufferedAmountLowThreshold`, `onbufferedamountlow`
- Putting chunks back together: `new Blob(chunks)`, then `URL.createObjectURL` to download

### Debugging tools
- `chrome://webrtc-internals` (use it a lot)
- Two browser tabs, or one normal window plus one incognito window

**Good resources:** MDN "WebRTC API", MDN "Using WebRTC data channels",
webrtc.org "Getting started", and the WebRTC samples repo (`webrtc.github.io/samples`).
Read the samples. Don't copy them.

---

## 2. Plan: milestones

Each milestone should **work on its own** before you start the next one. Commit after each.

### M0: Local loopback (no server)
Create **two** `RTCPeerConnection`s on the same page and connect them to each
other by hand (pass the offer, answer and ICE candidates directly in code).
Send `"hello"` over a data channel.
> Goal: understand the offer/answer/ICE dance with no networking getting in the way.

### M1: Signaling server
- `server.js`: Express serves `public/`, and Socket.IO is attached to the same HTTP server
- Rooms: a user joins a room ID; the server relays `offer`, `answer` and `ice-candidate` messages to the other peer in that room
- The server **never looks at** the payload. It only forwards it.
> Goal: two tabs log "peer joined" for each other.

### M2: Real peer connection over signaling
- Decide who is the **caller** (for example, the second person to join) and who is the **callee**
- Caller: `createDataChannel` → `createOffer` → send it
- Callee: receive offer → `createAnswer` → send it; use `ondatachannel` to get the channel
- Exchange ICE candidates both ways
- Add a STUN server: `{ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }`
> Goal: send a text chat message between two tabs.

### M3: Send a small file
- Send metadata first as JSON: `{ type: "meta", name, size, mimeType }`
- Then send the whole file as one `ArrayBuffer` (only works for small files)
- The receiver builds a Blob and shows a download link
> Goal: send a 100 KB image.

### M4: Chunking + backpressure (the hard part)
- Split the file into chunks of about 16 KB
- Only send while `bufferedAmount` is below a threshold; otherwise wait for `onbufferedamountlow`
- The receiver counts the bytes it has received, and finishes when `received === size`
> Goal: send a 500 MB file without the tab freezing or crashing.

### M5: UX
- Progress bars on both sides, plus transfer speed
- A shareable link like `/?room=abc123`
- Connection status shown in the UI
- Sending several files one after another

### M6: Stretch goals
- Test across two different networks (phone hotspot); learn why TURN is sometimes needed
- Pause/resume, cancel
- Check file integrity with a hash (`crypto.subtle.digest`)
- Drag-and-drop
- Deploy it (it needs HTTPS for anything other than localhost)

### Future checkpoint: room waiting queue

When a room is full, put new arrivals in a queue instead of turning them away.
When someone leaves, the next person in the queue joins automatically.

- Keep `queues = new Map()` (roomId → array of sockets) on the server, outside the connection handler
- Room full → `push` to the queue, emit `"queued"` with the person's position
- A member leaves → `shift` the next socket off the queue, `join` it, and send the usual `joined` / `peer-joined`; update everyone's position
- Pull the join logic into a reusable `admit(socket, roomId)` function
- Edge case: someone *in the queue* disconnects → remove them (track it with `socket.data.queuedFor`)
- WebRTC: the remaining peer must close its old `RTCPeerConnection` and create a new one for the new peer

### Future checkpoint: connection cleanup + send button state

Right now the send button stays enabled after the peer leaves. When the other tab
closes, `peer-left` arrives instantly over the socket, but WebRTC notices slowly
(`disconnected` after ~5 s, `failed` after ~30 s), and the channel's `onclose` may never fire.

- `setChatEnabled(enabled)`: the only place that toggles `sendBtn.disabled` / `input.disabled`
- `closeConnection(reason)`: disable the chat, set the status, close and null out `dataChannel`, `peerConnection`, `targetPeerId` (safe to call more than once)
- Call `setChatEnabled(true)` in `channel.onopen`
- Call `closeConnection(...)` from `socket.on("peer-left")`, `channel.onclose`, and `onconnectionstatechange` when the state is `"failed"` (for `"disconnected"`, only show "reconnecting...")
- Note: calling `peerConnection.close()` yourself may not fire the channel's `onclose`
- CSS: style `.send-btn:disabled` / `.chat-input:disabled`, because the custom `.send-btn` background hides the browser's disabled look
- Test: alone → disabled; peer joins → enabled; peer closes tab → disabled immediately; new peer joins → enabled again

---

## 3. Suggested file structure

```
server.js          # Express + Socket.IO signaling
public/
  index.html       # UI
  style.css
  app.js           # (later split into:)
  signaling.js     #   socket wrapper
  peer.js          #   RTCPeerConnection + data channel setup
  transfer.js      #   chunking, send/receive logic
```

## 4. Run

```
npm install
npm run dev      # http://localhost:3000
```

---

## Progress log
- [x] M0 Loopback
- [x] M1 Signaling server
- [x] M2 Peer connection + text
- [x] M3 Small file
- [ ] M4 Chunking + backpressure
- [ ] M5 UX
- [ ] M6 Stretch
- [ ] Future: room waiting queue
- [ ] Future: connection cleanup + send button state
