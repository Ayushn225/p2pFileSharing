# Changes

What changed, why, and the numbers we measured. Newest first.

## 4. Benchmark after step 3 (measured 2026-11-06)

Same setup as the baseline below (real app, two separate Chrome 156 processes, Apple M1 with 8 GB, ICE = host/UDP, 1 ms RTT,
**loopback, not network speed**). Memory = growth of the renderer process over its baseline of about 120-190 MB.
Run with `node bench2.js <mode> <MB>` (a scratch script, not in the repo yet). "fsa" used a mocked `showSaveFilePicker` that returns
a real OPFS `FileSystemFileHandle` (a native save dialog cannot be automated).

| Receive mode | File | Time | Speed | Sender memory | Receiver memory |
| --- | --- | --- | --- | --- | --- |
| memory (fallback) | 100 MB | 4.7 s | 21.2 MB/s | +74 MB | **+215 MB** |
| browser storage (OPFS) | 100 MB | 4.6 s | 21.5 MB/s | +70 MB | **+25 MB** |
| save dialog (FSA) | 100 MB | 4.6 s | 21.7 MB/s | +70 MB | **+37 MB** |
| memory (fallback) | 400 MB | 22.3 s | 18.0 MB/s | +79 MB | **+425 MB** |
| browser storage (OPFS) | 400 MB | 19.8 s | 20.2 MB/s | +54 MB | **+58 MB** |
| save dialog (FSA) | 400 MB | 24.1 s | 16.6 MB/s | +81 MB | **+71 MB** |
| browser storage (OPFS) | **1 GB** | 51.0 s | 20.1 MB/s | +89 MB | **+38 MB** |
| save dialog (FSA) | **1 GB** | 46.7 s | 21.9 MB/s | +50 MB | **+34 MB** |

- **Receiver memory is now flat** when the file is streamed to disk: +25 to +71 MB for 100 MB to 400 MB, and +34 to +38 MB for 1 GB,
  against +215 / +425 MB in memory mode (which cannot take 1 GB at all). Before step 3 the receiver needed +165 MB (100 MB) and +537 MB (400 MB).
- **Speed did not change** (about 17-22 MB/s in every mode and before): hashing on both sides (about 140 MB/s) and writing to disk are not the
  bottleneck; the ceiling is Chrome's SCTP on loopback with 16 KB messages (64 KB / 256 KB messages gave 24 / 26 MB/s, see the baseline notes).
- **Backpressure holds at 1 GB:** the sender's `bufferedAmount` peaked at 8.0 MB (sampled inside the page every 20 ms).
- **Integrity:** for 50 MB and 100 MB files in all three modes the saved file was read back and hashed with the browser's own
  `crypto.subtle` and matched Node's SHA-256 of the data.
- Not measured yet: **cross-network speed** (needs the home Wi-Fi to phone-hotspot test), and Firefox / Safari.

## 3. Receiver streams large files to disk (accept first, quota, checksum before close)

**What:**
- **Accept first.** The sender sends a `file-offer` and waits. The receiver sees *Accept / Decline*; only after Accept does the sender send chunks.
  The sender waits for the receiver's answer for up to 5 minutes, then withdraws the offer (`file-cancel`), and waits for the ack before the next file.
- **Where the file goes**, chosen automatically per browser: (1) **File System Access API**: Accept opens the save dialog
  (`showSaveFilePicker`) and chunks are written straight to the chosen file; (2) **OPFS**: written to a private file in browser storage and
  offered as a normal download; (3) **memory**: the old behaviour, now limited to 500 MB. Chunks are written in 1 MiB batches.
- **Quota check** (OPFS only): `navigator.storage.estimate()`; the offer is refused up front if `size + max(64 MB, 5%)` does not fit. A file saved
  with the save dialog is not subject to this: the browser does not report free space on the user's disk, so a full disk shows up as a write error.
- **File names** are sanitized (control and bidi characters, zero-width characters, `/ \ : * ? " < > |`, leading dots, trailing dots and spaces,
  Windows device names such as `CON` / `NUL`, 120 characters with the extension kept). OPFS files get our own random name, never the sender's.
- **Size enforcement** while receiving: offers are checked (10 GB limit, 500 MB in memory mode, chunk size/count), a chunk bigger than announced,
  more chunks than announced or more bytes than announced stops the transfer, and if the disk falls 64 MB behind the network it is stopped
  instead of filling memory. Every stop **aborts** the file: nothing partial is left behind.
- **Hash check before close.** The sender hashes each chunk while sending (one pass over the file) and puts the SHA-256 in `file-end`. The receiver
  compares it with its own running hash **before** closing the file. The file only appears on disk at `close()`, so a mismatch calls `abort()` and
  nothing is committed.

**Why:** the receiver held the whole file in memory (about 1.3-1.6x its size), which is why the limit was 500 MB and a 1 GB file was impossible.
Accept-first is also what makes the save dialog possible (it needs a click) and gives the receiver control over what lands on their disk.
`crypto.subtle.digest` needs the whole input at once, so an incremental SHA-256 (`public/sha256.js`) hashes chunk by chunk.

**Honest limits:** the hash travels over the same channel as the data, so it detects corruption and bugs, not a malicious sender (DTLS already
authenticates every packet). The save dialog path was tested with a mocked picker returning a real OPFS handle. Firefox and Safari were not
tested (the app falls back to memory where OPFS `createWritable` is missing). A peer running old cached JavaScript cannot exchange files with
a new one (different protocol): a refresh fixes it. Browser-storage files wait until you leave, refresh or clear the chat.

**Check:**
- 913 SHA-256 checks against Node's `crypto` (standard vectors, every length around the block boundaries, random chunkings).
- 135 fake-browser checks with fake File System Access / OPFS handles that record every write, commit and abort: all three modes byte-for-byte,
  accept / decline / dialog cancelled / timeout / busy, quota maths, every size-enforcement case in every mode, a wrong checksum
  (`close()` never called, nothing committed), one flipped byte in transit, 22 file-name cases, connection loss mid-file, a slow disk.
- 8 checks in real Chrome with several tabs for the Web Locks cleanup: an open tab's files survive other tabs' cleanup, a closed tab's files are removed.
- Real Chrome, all three modes, 50 MB and 100 MB with an independent SHA-256 of the saved file.

## Baseline (measured 2026-11-06, before the changes below)

Setup: the real app, unmodified, in two separate Chrome 156 processes on one Apple M1 laptop (8 GB RAM).
ICE chose host-to-host UDP with a 1 ms round trip, so this is **loopback speed, not network speed**.
Memory is the growth of the renderer process (RSS) over its baseline of about 135-165 MB.

| File | Time | Speed | Max send queue | Sender memory | Receiver memory |
| --- | --- | --- | --- | --- | --- |
| 100 MB | 8.7 s | 11.5 MB/s | 8.0 MB | +65 MB | +165 MB |
| 400 MB | 17.9 s / 21.1 s (two runs) | 22.3 / 19.0 MB/s | 8.0 MB | +70 MB | +537 MB |

- Backpressure works: the sender's `bufferedAmount` never went above the 8 MB high-water mark.
- Sender memory is flat (about +65-70 MB for both sizes). **Receiver memory is not**: it grows about 1.3-1.6x the file
  size, because every chunk is kept in an array and then turned into a Blob. That is why the cap is 500 MB.
- 1 GB was not run: it would need about 1.3 GB or more on the receiver, which this 8 GB machine cannot do reliably.
- Chunk size barely matters (400 MB): 16 KB gave 19-22 MB/s, 64 KB 24 MB/s, 256 KB 26 MB/s (within run-to-run noise).
  16 KB stays: it is the message size every browser is guaranteed to accept.
- Reading a file in 16 KB slices alone runs at 70-86 MB/s, so reading the file is not the bottleneck.

## 2. Transfer stats on every file bubble

**What:** each file bubble now shows a live speed while sending/receiving ("Sending... 42% · 7.9 MB/s") and, when it is
done, a summary line: `50.0 MB in 2.6 s · 19.5 MB/s · 3,200 chunks of 16 KB`. The same summary is logged to the console as
`[transfer] ...` (useful for benchmarks).

**Why:** the resume claimed "real-time progress and speed tracking", but only progress existed. Benchmark numbers need
a duration and a speed measured by the app itself.

**How:** `ui.js` keeps about 2 seconds of `[time, bytes]` samples per transfer and averages over that window; the text is
redrawn at most 4 times a second. The stopwatch starts when the transfer starts (sender: when the file's turn comes; receiver:
when `file-meta` arrives) and stops at the delivery confirmation (sender) or at `file-end` (receiver). The sender's bytes are
`handed to the channel - still in bufferedAmount`, i.e. what is really on the wire. MB means 1024*1024 bytes.

**Check:** 55 fake-browser checks (including the speed maths with a controlled clock) and a 50 MB run in two real Chrome
processes: live text `Sending... 10% · 16.7 MB/s` / `Receiving... 21% · 18.2 MB/s`, final line identical on both sides.

## 1. Chunk metadata in `file-meta`

**What:** the header now carries `chunkSize` and `chunkCount` (next to name, size and type). The receiver checks them:
`chunkSize` must be 1-256 KB, `chunkCount` must equal `ceil(size / chunkSize)`, and while receiving it rejects a chunk bigger
than `chunkSize` or more chunks than `chunkCount`. At `file-end` both the byte total and the chunk count must match.

**Why:** the receiver now knows exactly what to expect, so progress is exact and a peer can no longer make it hold millions
of tiny chunks (each chunk object costs memory beyond its bytes). It also gives the benchmark a real chunk count.

**Compatibility:** a peer running old cached JavaScript (no chunk fields) is rejected with "Invalid chunk size"; a refresh fixes it.

**Check:** sizes 0 B, 1 B, 16384 B, 16385 B, 100001 B, 300 KB all announce the right count and arrive intact; 10 malformed
announcements and 5 chunk-attack cases are rejected without console spam.

## Not done yet

- Cross-network benchmark (home Wi-Fi to phone hotspot) and the TURN decision that depends on it.
- Firefox / Safari testing of the OPFS path.
- Credit-based flow control (today a slow disk is handled by stopping the transfer at a 64 MB backlog).
