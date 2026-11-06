// Where a received file goes while it arrives.
//
//   "fsa"    File System Access API (Chrome / Edge on desktop): the user picks a place with showSaveFilePicker()
//            and chunks are written straight there. Memory stays flat. The file only appears at close().
//   "opfs"   Origin Private File System (all current browsers that support createWritable): chunks are written
//            to a private file on disk, and at the end it is offered as a normal download. Memory stays flat.
//   "memory" Fallback: every chunk is kept in RAM and turned into a Blob. Needs a size limit.
//
// Every sink has the same shape:
//   write(arrayBuffer)    hand over a chunk (never throws for slow disks, see `backlog`)
//   backlog               bytes accepted but not written yet (the receiver gives up if this grows too large)
//   commit()              finish the file -> { file | blob | savedAs }   (only after the checksum matched)
//   abort()               throw everything away, leave nothing behind

const MAX_MEMORY_FILE_SIZE = 500 * 1024 * 1024;           // the in-memory fallback keeps the whole file in RAM
const MAX_DISK_FILE_SIZE = 10 * 1024 * 1024 * 1024;       // sanity limit when the file is streamed to disk
const WRITE_BATCH = 1024 * 1024;                          // small chunks are collected into 1 MiB writes

class ReceiveCancelled extends Error {}                   // the user closed the save dialog
class ReceiveRefused extends Error {}                     // we can't take this file (quota, too big for memory, ...)

// ---- file names ---------------------------------------------------------------------------------------
// A name comes from the other person: it ends up on screen, in the "download" attribute and as the
// suggested name in the save dialog, so it must be harmless everywhere.
// Characters that must never survive in a name, listed as code point ranges (written as numbers so the
// source file contains no invisible characters): control characters, bidi overrides ("evil<RLO>gnp.exe"),
// zero-width characters, line separators and the BOM.
const INVISIBLE_NAME_CHARS = new RegExp("[" + [
    [0x0000, 0x001f], [0x007f, 0x009f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff],
].map(([from, to]) => String.fromCharCode(from) + "-" + String.fromCharCode(to)).join("") + "]", "g");

function sanitizeFileName(name){
    let n = String(name)
        .normalize("NFC")
        .replace(INVISIBLE_NAME_CHARS, "")
        .replace(/[\/\\:*?"<>|]/g, "_")                  // path separators and characters Windows forbids
        .replace(/^\.+/, "")                               // no hidden files, no ".."
        .replace(/[. ]+$/, "")                             // Windows silently drops trailing dots and spaces
        .trim();

    // reserved device names on Windows, with or without an extension
    if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = "_" + n;

    if(n.length > 120){                                    // keep it short, but keep the extension
        const dot = n.lastIndexOf(".");
        const ext = (dot > 0 && n.length - dot <= 16) ? n.slice(dot) : "";
        n = n.slice(0, 120 - ext.length) + ext;
    }
    return n || "file";
}

// ---- quota --------------------------------------------------------------------------------------------
// Only meaningful for browser storage (OPFS). A file saved with the save dialog lives on the user's disk,
// and the browser does not tell us how much space is left there: a full disk shows up as a write error.
async function checkQuota(size){
    try{
        if(!navigator.storage || !navigator.storage.estimate) return { ok: true, unknown: true };
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        if(!quota) return { ok: true, unknown: true };
        const free = Math.max(0, quota - usage);
        const needed = size + Math.max(64 * 1048576, Math.round(size * 0.05));   // headroom: the browser writes a temporary copy
        return { ok: free >= needed, free, needed };
    }catch(e){
        return { ok: true, unknown: true };
    }
}

// Why this browser can't take a file of this size in this mode, or null when it can.
async function refusalReason(mode, size){
    if(mode === "opfs"){
        const quota = await checkQuota(size);
        if(!quota.ok){
            return `Not enough free browser storage (needs ${getFormattedSize(quota.needed)}, free ${getFormattedSize(quota.free)})`;
        }
    }
    if(mode === "memory" && size > MAX_MEMORY_FILE_SIZE){
        return `This browser can only receive files up to ${getFormattedSize(MAX_MEMORY_FILE_SIZE)} (use Chrome or Edge for larger files)`;
    }
    return null;
}

// A line for the Accept bubble: where will the file go?
function describeReceiveMode(mode){
    if(mode === "fsa") return "You choose where to save it.";
    if(mode === "opfs") return "Kept in browser storage until you download it, leave or refresh.";
    return `Kept in memory (this browser can take files up to ${getFormattedSize(MAX_MEMORY_FILE_SIZE)}).`;
}

function detectReceiveMode(){
    if(typeof window.showSaveFilePicker === "function") return "fsa";
    if(navigator.storage && navigator.storage.getDirectory
        && typeof FileSystemFileHandle !== "undefined" && FileSystemFileHandle.prototype.createWritable) return "opfs";
    return "memory";
}

// ---- the sinks ----------------------------------------------------------------------------------------
class MemorySink {
    constructor(mimeType){
        this.kind = "memory";
        this.type = mimeType;
        this.chunks = [];
        this.backlog = 0;                                   // everything is in RAM already
    }
    write(buffer){ this.chunks.push(buffer); }
    async commit(){
        const blob = new Blob(this.chunks, { type: this.type });
        this.chunks = [];
        return { blob };
    }
    async abort(){ this.chunks = []; }
}

// FSA and OPFS handles have the same API (createWritable), so one class serves both.
class WritableSink {
    constructor(kind, handle, removeEntry){
        this.kind = kind;
        this.handle = handle;
        this.removeEntry = removeEntry || null;             // OPFS: deletes the private file again
        this.writable = null;
        this.batch = new Uint8Array(WRITE_BATCH);
        this.used = 0;                                      // bytes sitting in the current batch
        this.queued = 0;                                    // bytes handed to the writable, not finished yet
        this.chain = Promise.resolve();                     // writes happen strictly one after another
        this.failed = null;
    }

    async open(){
        this.writable = await this.handle.createWritable();
    }

    get backlog(){ return this.used + this.queued; }

    write(buffer){
        const bytes = new Uint8Array(buffer);
        let off = 0;
        while(off < bytes.length){
            const n = Math.min(bytes.length - off, this.batch.length - this.used);
            this.batch.set(bytes.subarray(off, off + n), this.used);
            this.used += n;
            off += n;
            if(this.used === this.batch.length) this._flushBatch();
        }
    }

    _flushBatch(){
        if(this.used === 0) return;
        const block = this.batch.slice(0, this.used);       // a copy: the batch buffer is reused straight away
        this.used = 0;
        this.queued += block.byteLength;
        this.chain = this.chain.then(async () => {
            if(this.failed) return;
            try{
                await this.writable.write(block);
            }catch(e){
                this.failed = e;
            }finally{
                this.queued -= block.byteLength;
            }
        });
    }

    // Everything is written and closed: only now does the file exist (FSA/OPFS swap the temporary copy in at close()).
    async commit(){
        this._flushBatch();
        await this.chain;
        if(this.failed) throw this.failed;
        await this.writable.close();
        if(this.kind === "opfs") return { file: await this.handle.getFile() };
        return { savedAs: this.handle.name };
    }

    async abort(){
        this.used = 0;
        this.failed = this.failed || new Error("aborted");    // writes still waiting in the queue are skipped, not performed
        try{ await this.chain; }catch(e){ /* ignore */ }
        try{ if(this.writable) await this.writable.abort(); }catch(e){ /* already closed */ }
        if(this.removeEntry) await this.removeEntry();
    }
}

// ---- browser storage (OPFS) housekeeping ----------------------------------------------------------------
// Every page load gets its own directory, and holds a Web Lock with a matching name for as long as the page
// is open. At start-up, directories whose lock nobody holds belong to closed tabs: they are deleted.
// A directory of another OPEN tab can never be deleted, because its lock is still held.
const OPFS_PAGE_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const OPFS_DIR_PREFIX = "p2p-";
const OPFS_PAGE_DIR = OPFS_DIR_PREFIX + OPFS_PAGE_ID;

function holdPageLock(){
    try{
        if(navigator.locks) navigator.locks.request(OPFS_PAGE_DIR, () => new Promise(() => {})).catch(() => {});   // never resolves: held until the page closes
    }catch(e){ /* no Web Locks: orphaned files are not cleaned up automatically */ }
}

async function cleanupOrphanedOpfsDirs(){
    try{
        if(!navigator.storage || !navigator.storage.getDirectory || !navigator.locks) return;
        const root = await navigator.storage.getDirectory();
        const names = [];
        for await (const [name] of root.entries()) names.push(name);
        for(const name of names){
            if(!name.startsWith(OPFS_DIR_PREFIX) || name === OPFS_PAGE_DIR) continue;
            const orphan = await navigator.locks.request(name, { ifAvailable: true }, (lock) => lock !== null);
            if(orphan) await root.removeEntry(name, { recursive: true });
        }
    }catch(e){
        console.log("could not clean up old browser storage:", e);
    }
}

// Deletes everything this page stored in browser storage (called when the chat is cleared).
async function releaseReceivedFiles(){
    try{
        if(!navigator.storage || !navigator.storage.getDirectory) return;
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(OPFS_PAGE_DIR, { recursive: true });
    }catch(e){ /* nothing stored */ }
}

async function createOpfsSink(){
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_PAGE_DIR, { create: true });
    const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + ".part";     // our own name, never the sender's
    const handle = await dir.getFileHandle(name, { create: true });
    const sink = new WritableSink("opfs", handle, async () => { try{ await dir.removeEntry(name); }catch(e){ /* gone already */ } });
    await sink.open();
    return sink;
}

// Must be called straight from the click on "Accept" (the save dialog needs that user gesture),
// so there is no `await` before showSaveFilePicker() below.
async function createReceiveSink(mode, meta){
    if(mode === "fsa"){
        let handle = null;
        try{
            handle = await window.showSaveFilePicker({ suggestedName: meta.name });
        }catch(e){
            if(e && e.name === "AbortError") throw new ReceiveCancelled("No save location chosen");
            console.log("the save dialog is not available, using browser storage instead:", e);
            mode = "opfs";
        }
        if(handle){
            const sink = new WritableSink("fsa", handle);
            await sink.open();
            return sink;
        }
    }

    const refusal = await refusalReason(mode, meta.size);
    if(refusal) throw new ReceiveRefused(refusal);

    if(mode === "opfs") return await createOpfsSink();
    return new MemorySink(meta.mimeType);
}

holdPageLock();
cleanupOrphanedOpfsDirs();
