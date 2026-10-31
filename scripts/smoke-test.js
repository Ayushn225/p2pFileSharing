#!/usr/bin/env node
/*
 * Smoke test for a running server (local or deployed).
 *
 *   npm run smoke -- https://your-app.onrender.com
 *   npm run smoke -- http://localhost:3000
 *
 * It checks the HTTP side (page, /healthz, /ice-config) and the signalling side with three raw
 * Socket.IO clients: two people join a room, exchange an offer / answer / ICE candidate, a third
 * person is turned away, and an outsider cannot inject signals.
 *
 * It does NOT test WebRTC itself (that needs two real browsers): for that, follow the
 * "Phone -> laptop test" in docs/DEPLOY.md.
 */
const crypto = require("crypto");

let WebSocket;
try {
  WebSocket = require("ws");      // installed together with socket.io
} catch (e) {
  console.error('Missing the "ws" package. Run "npm install" first.');
  process.exit(2);
}

const base = (process.argv[2] || "http://localhost:3000").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("Usage: node scripts/smoke-test.js <http(s)://host[:port]>");
  process.exit(2);
}
const wsBase = base.replace(/^http/, "ws");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(condition, message, hint) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${message}`);
  } else {
    failed++;
    console.log(`  FAIL  ${message}${hint ? `\n          -> ${hint}` : ""}`);
  }
}

// Free hosts put idle apps to sleep: the first request can take a minute.
async function waitUntilAwake() {
  const started = Date.now();
  let announced = false;
  while (Date.now() - started < 120000) {
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(15000) });
      if (res.ok) return true;
    } catch (e) { /* not up yet */ }
    if (!announced) { console.log("  ... waiting for the server to wake up (can take up to a minute on free hosts)"); announced = true; }
    await wait(3000);
  }
  return false;
}

// Minimal Socket.IO v4 client over a raw WebSocket (no extra dependency).
function connectClient(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/socket.io/?EIO=4&transport=websocket`);
    const client = {
      label, ws, id: null, events: [],
      emit(event, ...args) { ws.send("42" + JSON.stringify([event, ...args])); },
      got(event) { return client.events.filter((e) => e.event === event); },
      close() { try { ws.close(); } catch (e) { /* ignore */ } },
    };
    const timer = setTimeout(() => reject(new Error(`${label}: no Socket.IO handshake within 20s`)), 20000);
    ws.on("error", (e) => { clearTimeout(timer); reject(new Error(`${label}: ${e.message}`)); });
    ws.on("message", (raw) => {
      const msg = raw.toString();
      if (msg.startsWith("0")) ws.send("40");                 // engine open -> connect to namespace "/"
      else if (msg === "2") ws.send("3");                     // ping -> pong
      else if (msg.startsWith("40")) {
        client.id = JSON.parse(msg.slice(2)).sid;
        clearTimeout(timer);
        resolve(client);
      } else if (msg.startsWith("42")) {
        const [event, data] = JSON.parse(msg.slice(2));
        client.events.push({ event, data });
      }
    });
  });
}

async function main() {
  console.log(`\nSmoke test against ${base}\n`);

  // ---- 1. HTTP ----
  console.log("HTTP");
  const awake = await waitUntilAwake();
  check(awake, "server answers /healthz", "is the URL right, and is the service running?");
  if (!awake) return finish();

  const page = await fetch(base + "/");
  const html = await page.text();
  check(page.ok && html.includes("<title>"), "main page loads (HTTP " + page.status + ")");

  let ice = null;
  try { ice = await (await fetch(`${base}/ice-config`)).json(); } catch (e) { /* reported below */ }
  check(ice && Array.isArray(ice.iceServers) && ice.iceServers.length > 0, "/ice-config returns ICE servers");
  const hasTurn = !!(ice && ice.iceServers.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u))));
  console.log(`  INFO  TURN relay: ${hasTurn ? "configured" : "NOT configured (STUN only: some networks will not connect)"}`);
  if (!base.startsWith("https://") && !/localhost|127\.0\.0\.1/.test(base)) {
    console.log("  WARN  not HTTPS: Copy link and some browser features need a secure origin");
  }

  // ---- 2. Signalling ----
  console.log("\nSignalling");
  const room = "smoke" + crypto.randomBytes(5).toString("hex");
  let A, B, C, D;
  try {
    [A, B, C, D] = await Promise.all(["A", "B", "C", "D"].map(connectClient));
  } catch (e) {
    check(false, "WebSocket connection to the server", e.message + " (does the host allow WebSockets?)");
    return finish();
  }
  check(true, "4 WebSocket clients connected");

  A.emit("join", { roomId: room, name: "Alice" });
  await wait(300);
  B.emit("join", { roomId: room, name: "Bob" });
  await wait(500);
  check(A.got("joined").some((e) => e.data.count === 1), "first person gets 'waiting' (count 1)");
  const joinedB = B.got("joined").find((e) => e.data.count === 2);
  check(joinedB && joinedB.data.targetPeerId === A.id, "second person is paired with the first");
  check(A.got("peer-joined").some((e) => e.data.targetPeerId === B.id && e.data.peerName === "Bob"), "first person is told who joined");

  B.emit("webrtc-offer", { targetPeerId: A.id, sdp: { type: "offer", sdp: "x" } });
  await wait(300);
  check(A.got("webrtc-offer").some((e) => e.data.senderId === B.id), "offer is relayed B -> A");
  A.emit("webrtc-answer", { targetPeerId: B.id, sdp: { type: "answer", sdp: "y" } });
  await wait(300);
  check(B.got("webrtc-answer").length === 1, "answer is relayed A -> B");
  A.emit("webrtc-ice", { targetPeerId: B.id, candidate: { candidate: "c" } });
  await wait(300);
  check(B.got("webrtc-ice").length === 1, "ICE candidate is relayed A -> B");

  C.emit("join", { roomId: room, name: "Carol" });
  await wait(400);
  check(C.got("room-full").length === 1, "a third person is turned away ('room full')");

  const before = A.events.length + B.events.length;
  D.emit("webrtc-offer", { targetPeerId: A.id, sdp: { evil: true } });     // D is in no room
  D.emit("webrtc-ice", { targetPeerId: B.id, candidate: { evil: true } });
  await wait(400);
  check(A.events.length + B.events.length === before, "an outsider cannot inject signals into the room");

  D.emit("webrtc-ice");                                                    // malformed on purpose
  await wait(300);
  const health = await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false);
  check(health, "server survives a malformed message");

  [A, B, C, D].forEach((c) => c.close());
  return finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed === 0) {
    console.log("Signalling works. Now do the real test with two devices: see 'Phone -> laptop test' in docs/DEPLOY.md");
    console.log(`  1. laptop:  open ${base}`);
    console.log("  2. phone (mobile data, Wi-Fi off): open the same link, same room, then send a file both ways\n");
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("Smoke test crashed:", e); process.exit(2); });
