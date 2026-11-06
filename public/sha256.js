// Incremental SHA-256 (FIPS 180-4).
//
// crypto.subtle.digest() needs the whole input at once, which would put a whole large file back into
// memory. So the file is hashed chunk by chunk here, on both sides, while it is sent / received:
//
//   const h = new Sha256();  h.update(chunk1);  h.update(chunk2);  h.digestHex();   // 64 hex characters

const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

class Sha256 {
    constructor(){
        this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
        this.block = new Uint8Array(64);    // bytes that do not fill a whole 64-byte block yet
        this.blockLen = 0;
        this.length = 0;                    // total number of bytes hashed so far
        this.w = new Uint32Array(64);
        this.finished = false;
    }

    // data: ArrayBuffer or any typed array / DataView
    update(data){
        if(this.finished) throw new Error("Sha256: already finished");
        const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
        const len = bytes.length;
        let pos = 0;
        this.length += len;

        if(this.blockLen > 0){                              // top up a half-filled block first
            const take = Math.min(64 - this.blockLen, len);
            this.block.set(bytes.subarray(0, take), this.blockLen);
            this.blockLen += take;
            pos = take;
            if(this.blockLen === 64){
                this._compress(this.block, 0);
                this.blockLen = 0;
            }
        }
        while(len - pos >= 64){                             // whole blocks straight from the input
            this._compress(bytes, pos);
            pos += 64;
        }
        if(pos < len){                                      // keep the tail for the next call
            this.block.set(bytes.subarray(pos), 0);
            this.blockLen = len - pos;
        }
        return this;
    }

    _compress(buf, off){
        const w = this.w, h = this.h;
        for(let i = 0; i < 16; i++){
            const j = off + i * 4;
            w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
        }
        for(let i = 16; i < 64; i++){
            const w15 = w[i - 15], w2 = w[i - 2];
            const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
            const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;          // stored in a Uint32Array: wraps modulo 2^32
        }

        let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for(let i = 0; i < 64; i++){
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) | 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) | 0;
            hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }

    // Finishes the hash (it cannot be updated afterwards) and returns it as 64 lowercase hex characters.
    digestHex(){
        if(!this.finished){
            const bits = this.length * 8;                   // exact for any file below 2^50 bytes
            const padLen = (this.blockLen < 56 ? 56 : 120) - this.blockLen;
            const pad = new Uint8Array(padLen + 8);
            pad[0] = 0x80;                                  // a single 1 bit, then zeros...
            const view = new DataView(pad.buffer);
            view.setUint32(padLen, Math.floor(bits / 4294967296));      // ...then the length in bits, 64-bit big-endian
            view.setUint32(padLen + 4, bits >>> 0);
            this.update(pad);
            this.finished = true;
        }
        return Array.from(this.h, (x) => x.toString(16).padStart(8, "0")).join("");
    }
}
