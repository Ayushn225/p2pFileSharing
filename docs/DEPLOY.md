# Deploying and testing

A step-by-step guide: what to do before you deploy, how to deploy on a free host, how to add TURN,
and how to test sending a file from your phone to your laptop.

---

## 1. Before you deploy: checklist

Already done in the code (as of this commit):

- [x] Server reads its port from `PORT`, serves files with `path.join(__dirname, "public")`
- [x] Signals (offer / answer / ICE) are only relayed to the other person in the same room, and malformed input can't crash the server
- [x] File announcements are validated, files over 500 MB are refused, file names are cleaned
- [x] Random, unguessable room IDs ("Create / Join Room" with an empty room ID, or the Generate button)
- [x] ICE candidate queue (early candidates are no longer dropped), clearer "couldn't connect" message
- [x] TURN is configurable with environment variables, `/ice-config` and `/healthz` endpoints
- [x] `engines` in `package.json`, smoke test script (`npm run smoke`)

Still for you to do:

- [ ] **Run it locally one last time** in two Chrome tabs: chat, send a small and a large file, refresh, leave.
- [ ] **`npm run dev`, then in another terminal `npm run smoke -- http://localhost:3000`**: every line should say PASS.
- [ ] **Commit and push** to GitHub (the host deploys from the repository, not from your laptop).
      `.gitignore` already excludes `node_modules` and `.env`.
- [ ] **Decide about TURN** (section 3). You can deploy first and add it afterwards if the phone test fails.
- [ ] Have a **phone with mobile data** and the laptop ready for the test in section 5.

---

## 2. Deploy on Render (free)

Your server keeps long-lived WebSocket connections, so it needs a host that runs a normal Node process.
**Vercel, Netlify and GitHub Pages will not work.** Render, Railway, Koyeb and similar do. Free tiers change, so check
the current terms.

1. Create an account at render.com and connect your GitHub account.
2. **New -> Web Service**, select the repository.
3. Settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
4. (Optional now, see section 3) Environment variables: `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.
   Do **not** set `PORT`: Render sets it and the server already reads it.
5. Create the service. When the build finishes you get `https://<name>.onrender.com`.
6. Every `git push` redeploys automatically.

What to expect on a free instance:

- It goes to sleep when idle, so the first visit after a quiet period can take about a minute to load.
- A redeploy or restart drops live connections and forgets rooms (they live in memory). That is fine for a prototype.
- HTTPS is automatic, which also makes "Copy Link" work.

After the first deploy, run the smoke test (section 4).

---

## 3. TURN (needed on strict networks)

STUN lets most devices find each other. Some networks (strict firewalls, many mobile carriers) block direct connections,
and then **TURN**, a relay server, is the only way to connect. The data stays end-to-end encrypted, but it travels through
the relay, so a free relay has a bandwidth quota.

1. Create an account with a hosted TURN service that has a free tier (check current terms) and copy its
   URLs, username and credential.
2. On your host (Render: **Environment** tab) set:

   | Variable | Example |
   | --- | --- |
   | `TURN_URLS` | `turn:relay.example.com:80,turn:relay.example.com:443?transport=tcp,turns:relay.example.com:443?transport=tcp` |
   | `TURN_USERNAME` | `your-username` |
   | `TURN_CREDENTIAL` | `your-credential` |

3. Redeploy. Open `https://<your-app>/ice-config`: you should see a second entry with your `turn:` URLs.
   (The page is public; TURN credentials are visible to anyone who opens it. That is how browser TURN works, so use a
   free-tier account you can rotate if it is abused.)
4. **Prove it works:** open the room link on both devices with `&relay=1` added, for example
   `https://<your-app>/?room=abc123&relay=1`. That forces every connection through TURN. If both devices still connect,
   TURN works. If they never connect, check the credentials and URLs.

---

## 4. Smoke test (automatic, checks the server)

```bash
npm run smoke -- https://<your-app>.onrender.com
```

It checks:

- the page loads, `/healthz` answers, `/ice-config` returns ICE servers (and tells you whether TURN is configured)
- two clients can join a room, are paired, and an offer / answer / ICE candidate is relayed between them
- a third person is turned away ("room full")
- an outsider cannot inject signals, and a malformed message does not crash the server

On a free host it waits up to two minutes for the server to wake up. It does **not** test WebRTC itself (that needs two
real browsers), which is what the next section is for.

---

## 5. Phone -> laptop test (manual)

Goal: prove that a file really travels from your phone to your laptop (and back) over the deployed site.

**Setup**

- Laptop: Chrome, on Wi-Fi.
- Phone: Chrome or Safari. For the real "different networks" test, turn **Wi-Fi off** on the phone so it uses mobile data.
- The deployed URL, `https://<your-app>.onrender.com`. If the host was asleep, open it once and wait for it to load.

**Steps**

1. **Laptop:** open the URL, enter the name `Laptop`, leave the room ID **empty**, click *Create / Join Room*.
   Expect: the address bar shows `?room=xxxxxxxxxxxx` and the status says "waiting for other...".
2. Click **Copy Link** and send the link to your phone (message, notes, email).
3. **Phone:** open the link, enter the name `Phone`, click *Create / Join Room*.
   Expect on both devices, within about 10 seconds: a green "... joined" message, status **connected**, and the send button
   becomes active.
4. **Chat both ways:** send "hi" from each device and see it arrive.
5. **Phone -> laptop (the main test):** on the phone tap the paperclip, choose a photo (a few MB), press send.
   Expect:
   - phone: the bubble goes *Waiting to send...* -> *Sending... 42%* -> **✓ Delivered**
   - laptop: *Receiving... 42%* -> **✓ Received**, a thumbnail, and a **Download** link
   - download it on the laptop, open it and check that it is the same photo and the same size
6. **Laptop -> phone:** send a PDF or image from the laptop. On an iPhone the Download link may open a viewer instead of
   saving; use the share button there to save it.
7. **Bigger file:** send a 50-100 MB file (a video). Watch both progress bars move smoothly; it should finish with
   Delivered / Received.
8. **Several files:** select three files at once. The second and third show *Waiting...* until their turn.
9. **Break things on purpose:**
   - close the laptop tab during a transfer: the phone shows **⚠️ Connection lost**, nothing hangs
   - refresh the laptop tab: the chat comes back, files show "No longer available", and you can reconnect
   - press **Leave Room** on one device: the other shows "<name> left"
10. **TURN check (only if you configured it):** repeat steps 1-5 with `&relay=1` added to the link on both devices.

**You pass if:** steps 3-5 work with the phone on mobile data. If steps 3-5 work only with the phone on the same Wi-Fi as
the laptop, you need TURN (section 3).

| Result | Laptop | Phone |
| --- | --- | --- |
| Joined + "connected" | | |
| Chat both ways | | |
| Phone -> laptop file | | |
| Laptop -> phone file | | |
| 50-100 MB file | | |
| With `&relay=1` | | |

---

## 6. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| First load is very slow, or a 502 | The free instance is waking up. Wait about a minute and refresh. |
| Page loads but stays on "connecting to server..." | Check the browser console for socket errors; make sure you use the `https://` URL. |
| Status goes to "failed", message says "Couldn't connect" | The two devices can't find a direct path. Try another network or browser, or configure TURN (section 3). |
| Works on the same Wi-Fi, not on mobile data | You need TURN. |
| Two Firefox tabs on one machine fail, Chrome works | Firefox hides local addresses. Test with Chrome or two devices. |
| "Room is full" immediately after a refresh | The old connection hasn't timed out yet; wait a few seconds and try again. |
| `npm run smoke` says the server does not answer | Wrong URL, the service is not running, or the build failed: check the host's logs. |
| Smoke test passes but the phone test fails | The server is fine; the problem is the network path (TURN) or the phone browser. |
