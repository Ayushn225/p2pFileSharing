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

### M4.5: Connection cleanup (prerequisite for M5.1)

See "Future checkpoint: connection cleanup + send button state" below for the details.

- `closeConnection(reason)`: null the globals first, then close the old channel and connection; safe to call more than once
- Call it on `peer-left`, `channel.onclose`, and `connectionState === "failed"` (for `"disconnected"`, only show "reconnecting...")
- Never tear down on the socket's own `disconnect`: an established WebRTC connection survives a signaling server restart
- Stale-event guard: each handler checks `pc !== peerConnection` / `channel !== dataChannel` and ignores old connections
- `sendFile` fails fast if the channel isn't open; queued files show errors instead of hanging
- Wrap `addIceCandidate` in try/catch (late candidates for an old connection)

### M5.1: Lobby, names, leave, refresh-safe rooms

A WebRTC connection **cannot** survive a page refresh. The goal is to make a refresh *look*
seamless: save the chat locally, reconnect automatically, and hold the seat for a moment.

Behaviour:
- No `?roomId` in the URL → lobby: create a room (short random ID, `history.replaceState`) or join one by ID; enter a name; copy-link button
- Alone → "waiting"; peer present → connect and chat
- Explicit **Leave room** button with a custom confirm dialog → leaver's local history for that room is cleared, the other side immediately sees a centered "Alice left" bubble
- The person who stays keeps their whole history; a new joiner starts with a **blank** chat (history is per-browser, never sent to newcomers)
- Refresh → the same person reconnects within the grace period; the other side sees "reconnecting..." instead of "left"; chat history is restored from local storage
- `beforeunload` as a safety net (generic browser dialog; custom text isn't allowed and it can't tell refresh from close)

Steps:
1. **Lobby page** + name field (name kept in `localStorage`)
2. **Names + system bubbles**: after the channel opens, send `{ type: "hello", name }`; `addSystemMessage` in ui.js for "X joined" / "X left" / "X reconnected"
   - Centered divider style (`── Alice left ──`) so old and new conversations are clearly separated in the chat body
   - Generated locally from socket/connection events, never sent over the channel
   - "Reconnecting…" also goes in the chat body, but **update that same bubble** to "Alice reconnected" or "Alice left" instead of adding a new one each time (a flaky network shouldn't flood the chat)
3. **Leave button**: confirm → `socket.emit("leave")` → server notifies the room immediately (no grace period) → clear this room's stored history → back to the lobby
4. **Persist chat**: append each message to `localStorage` under the room ID; render it on page load
5. **Refresh reconnect + seat reservation**:
   - `clientId = crypto.randomUUID()` in `sessionStorage` (survives refresh, cleared on tab close); send it with `join`
   - Server keeps its own `Map` of seats per room (`clientId`, socket id, reserved timer)
   - Socket disconnect (no explicit leave) → keep the seat reserved for `RECONNECT_GRACE_MS` (5 s) and start a timer
   - Join with the **same** `clientId` → reclaim the seat, cancel the timer, tell the other peer "reconnected", renegotiate
   - Join with a **different** `clientId` while a seat is reserved → `"room-busy"` ("try again in a few seconds")
   - Timer expires → free the seat, emit `peer-left`
   - Room-size check counts connected **and** reserved seats
6. *(Optional)* **Persist received files** in IndexedDB (localStorage is too small and string-only), with a per-file size cap; over the cap show "file expired, ask them to resend"
7. "Clear history" option (privacy on shared computers)

Decisions (kept simple on purpose):
- Reconnect slower than the 5 s grace period → treated as left + joined again. Acceptable.
- Seat reservations live in server memory: **soft state**. A server restart forgets them; that only degrades the experience (left/joined instead of "reconnected"), it doesn't break anything, and established WebRTC connections keep working.
- Same person in two tabs → counted as two people (each tab has its own `sessionStorage` `clientId`). Revisit later: research the BroadcastChannel API / tab leader election.

### M5.2: Progress bar

See "Future checkpoint: file transfer progress bar" below.

### M5.3: Speed

- Measure MB/s with `performance.now()` around `sendFile`
- Remove any per-chunk work (logs, DOM updates)
- Dynamic chunk size: `Math.min(peerConnection.sctp.maxMessageSize, 64 * 1024)`
- Separate `"chat"` and `"file"` data channels so chat never waits behind up to 8 MB of queued chunks (callee tells them apart by `event.channel.label`)
- Compare numbers before and after each change; test across two machines

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

### Future checkpoint: file transfer progress bar

Show live progress on both sides while a file is being sent or received.

- Create the file bubble when the transfer **starts** (sender: in `sendFile`; receiver: on `file-meta`), with a `<progress max="100">` inside
- Give each transfer an id (e.g. a counter or `crypto.randomUUID()`) so `updateProgress(id, percent)` finds the right bubble; send the id in `file-meta`
- Sender percent: `offset / file.size`; receiver percent: `receivedBytes / fileMetaData.size`
- Only touch the DOM when the whole-number percent changes (a 500 MB file is ~32,000 chunks)
- On finish: receiver swaps the bar for the download link; sender shows "✓ sent"; on error, mark the bubble failed
- Keep the split: peer.js calls UI functions (`createTransferBubble`, `updateProgress`, `finishTransfer`), and ui.js owns the DOM
- Bonus: show transfer speed (MB/s) and time left next to the bar

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
- [ ] M4.5 Connection cleanup
- [ ] M5.1 Lobby, names, leave, refresh-safe rooms
- [ ] M5.2 Progress bar
- [ ] M5.3 Speed
- [ ] M6 Stretch
- [ ] Future: room waiting queue
- [ ] Future: connection cleanup + send button state
- [ ] Future: file transfer progress bar
