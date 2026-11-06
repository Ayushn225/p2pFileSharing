# Changes

What changed, why, and the numbers we measured. Newest first.

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

## Not done yet (on hold)

- Receiver streams chunks to disk so its memory stays flat, then lift the 500 MB cap for that path.
- Re-run the 100 MB / 1 GB benchmark on the final code.
