let reconnectBubble = null;

const MAX_CHAT_LENGTH = 5000;

// File transfer protocol (JSON messages on the data channel, chunks are binary):
//
//   sender                                              receiver
//   file-offer {id, name, size, chunkSize, chunkCount}  ->   shows Accept / Decline
//                                                       <-   file-accept {id}  | file-decline {id, reason}
//   chunk, chunk, chunk ...                             ->   hashed + written to disk as they arrive
//   file-end {id, sha256}                               ->   compares the checksum, THEN closes the file
//                                                       <-   file-ack {id}     | file-error {id, reason}
//   file-cancel {id}  (sender gave up waiting)          ->
//
// The sender waits for the ack before the next file, so there is only ever one transfer at a time.
// Size limits (MAX_MEMORY_FILE_SIZE, MAX_DISK_FILE_SIZE) and the sinks live in sinks.js, SHA-256 in sha256.js.

// The file is cut into CHUNK_SIZE pieces. 16 KB is the message size every browser is guaranteed to
// accept on a data channel, so it is the interoperable choice (Chrome allows up to 256 KB).
// The sender announces chunkSize and chunkCount in the offer so the receiver can check what it gets.
const CHUNK_SIZE = 16 * 1024;
const MIN_CHUNK_SIZE = 1024;
const MAX_CHUNK_SIZE = 256 * 1024;

// If the disk falls this far behind the network, the receiver gives up instead of filling its memory.
const MAX_WRITE_BACKLOG = 64 * 1024 * 1024;

const OFFER_TIMEOUT_MS = 5 * 60 * 1000;     // how long the sender waits for Accept
const ACK_TIMEOUT_MS = 5 * 60 * 1000;       // ... and for the receiver to confirm the finished file

// Ids of files the receiver rejected: the sender stops uploading them.
const cancelledTransfers = new Set();

// The file being received right now: { meta, mode, state, sink, hash, received, count }
// state: "checking" -> "offered" -> "preparing" -> "receiving" -> "finishing"
let currentIncoming = null;

// The sender waits for the receiver's answers ("accept:<id>", "ack:<id>").
const replyWaiters = new Map();

// An error whose message is meant for the user (shown in the file bubble).
class SendFailure extends Error {}

function waitForReply(kind, id, timeoutMs){
    return new Promise((resolve, reject) => {
        const key = `${kind}:${id}`;
        const timer = setTimeout(() => {
            replyWaiters.delete(key);
            reject(new SendFailure(kind === "accept" ? "No answer from the receiver" : "The receiver did not confirm the file"));
        }, timeoutMs);
        replyWaiters.set(key, {
            resolve: () => { clearTimeout(timer); resolve(); },
            reject: (err) => { clearTimeout(timer); reject(err); },
        });
    });
}

function settleReply(kind, id, error){
    const key = `${kind}:${id}`;
    const waiter = replyWaiters.get(key);
    if(!waiter) return;
    replyWaiters.delete(key);
    if(error) waiter.reject(error); else waiter.resolve();
}

function failAllReplyWaiters(error){
    replyWaiters.forEach((waiter) => waiter.reject(error));
    replyWaiters.clear();
}

// Everything that arrives over the data channel comes from the other person: never trust it.
// Returns the reason an offer is unacceptable, or null when it is fine.
function checkFileMeta(meta){
    if(typeof meta.id !== "string" || meta.id.length === 0 || meta.id.length > 100) return "Invalid file";
    if(typeof meta.name !== "string" || meta.name.length === 0 || meta.name.length > 255) return "Invalid file name";
    if(!Number.isSafeInteger(meta.size) || meta.size < 0) return "Invalid file size";
    if(meta.size > MAX_DISK_FILE_SIZE) return `File is larger than ${getFormattedSize(MAX_DISK_FILE_SIZE)}`;
    if(!Number.isSafeInteger(meta.chunkSize) || meta.chunkSize < MIN_CHUNK_SIZE || meta.chunkSize > MAX_CHUNK_SIZE) return "Invalid chunk size";
    if(meta.chunkCount !== Math.ceil(meta.size / meta.chunkSize)) return "Invalid chunk count";
    if(meta.mimeType !== undefined && (typeof meta.mimeType !== "string" || meta.mimeType.length > 100)) return "Invalid file type";
    if(typeof meta.timestamp !== "string" || meta.timestamp.length > 40) return "Invalid file";
    return null;
}

function initPeerConnection(){
    const pc = new RTCPeerConnection(configuration);
    peerConnection = pc;
    pendingCandidates = [];             // a new connection starts without leftovers
    let connectedOnce = false;

    pc.onicecandidate = async (event)=>{
        if(event.candidate && targetPeerId){
            socket.emit('webrtc-ice', {targetPeerId: targetPeerId, candidate: event.candidate});
        }
    }

    pc.ondatachannel = (event)=>{
        console.log("channel recieved");
        dataChannel = event.channel;
        setupChannel(dataChannel);
    };

    pc.onconnectionstatechange = () =>{
        if(peerConnection !== pc){
            return;
        }

        console.log("connection: ", pc.connectionState);
        const state = pc.connectionState;

        switch(state){
            case 'failed': {
                const who = peerName ?? "Peer";
                const text = connectedOnce
                    ? `Connection to ${who} is lost`
                    : `Couldn't connect to ${who}. Your network may be blocking direct connections: try another network, or another browser.`;

                if(reconnectBubble){
                    updateSystemMessage(reconnectBubble, text, false);
                    reconnectBubble = null;
                }else{
                    updateSystemMessage(null, text, false);
                    saveRecord({
                        kind: "system",
                        text: text,
                        setActive: false,
                    }, currentRoomId, currentName);
                }
                closeConnection('failed');
                break;
            }
            case 'disconnected':
                setStatus("reconnecting....")
                if(!reconnectBubble) reconnectBubble = updateSystemMessage(null, `${peerName?? "Peer"} is reconnecting...`, false);
                break;
            case 'connected':
                connectedOnce = true;
                setStatus("connected")
                if(reconnectBubble) updateSystemMessage(reconnectBubble, `${peerName?? "Peer"} reconnected`, true);
                reconnectBubble = null;
                break;
            case 'closed':
                break;
        }
    };
}

function setupChannel(channel){
    let discarding = false;     // true after we refused a file: its remaining chunks (if any) are dropped silently

    // Small replies must never throw inside onmessage.
    function reply(obj){
        try{
            channel.send(JSON.stringify(obj));
        }catch(e){
            console.log("could not reply:", e);
        }
    }

    function dropSink(inc){
        return inc.sink ? inc.sink.abort().catch(() => {}) : Promise.resolve();
    }

    // The file being received can't be completed: fail the bubble, tell the sender, throw the partial file away.
    function rejectIncoming(reason){
        const inc = currentIncoming;
        if(!inc) return Promise.resolve();
        currentIncoming = null;
        discarding = true;
        failTransfer(inc.meta.id, reason);
        reply({type: "file-error", id: inc.meta.id, reason});
        return dropSink(inc);
    }

    // The offer itself is unacceptable (too big, malformed, no space, ...): a notice instead of a file bubble.
    function refuseOffer(meta, reason){
        discarding = true;
        updateSystemMessage(null, `Rejected a file from ${peerName ?? "your peer"}: ${reason}`, false);
        if(typeof meta.id === "string"){
            reply({type: "file-decline", id: meta.id.slice(0, 100), reason});
        }
    }

    function declineIncoming(inc, reason){
        if(currentIncoming !== inc || inc.state !== "offered") return;
        currentIncoming = null;
        failTransfer(inc.meta.id, reason);
        reply({type: "file-decline", id: inc.meta.id, reason});
    }

    // Called straight from the click on "Accept": the save dialog may only open from a user gesture,
    // so nothing is awaited before createReceiveSink() starts.
    async function acceptIncoming(inc){
        if(currentIncoming !== inc || inc.state !== "offered") return;
        inc.state = "preparing";
        markPreparing(inc.meta.id);

        let sink;
        try{
            sink = await createReceiveSink(inc.mode, inc.meta);
        }catch(e){
            if(currentIncoming !== inc) return;
            currentIncoming = null;
            const expected = (e instanceof ReceiveCancelled) || (e instanceof ReceiveRefused);
            if(!expected) console.log(e);
            const reason = expected ? e.message : "Could not open a file to write to";
            failTransfer(inc.meta.id, reason);
            reply({type: "file-decline", id: inc.meta.id, reason});
            return;
        }

        if(currentIncoming !== inc){            // the connection closed or the sender withdrew while we prepared
            sink.abort().catch(() => {});
            return;
        }

        inc.sink = sink;
        inc.hash = new Sha256();
        inc.state = "receiving";
        updateProgress(inc.meta.id, 0, 0);      // offered -> receiving: the stopwatch starts here
        reply({type: "file-accept", id: inc.meta.id});
    }

    async function onOffer(offer){
        if(currentIncoming){                    // one file at a time
            if(typeof offer.id === "string") reply({type: "file-decline", id: offer.id.slice(0, 100), reason: "Busy with another file"});
            return;
        }

        const problem = checkFileMeta(offer);
        if(problem){
            refuseOffer(offer, problem);
            return;
        }

        offer.name = sanitizeFileName(offer.name);
        const inc = { meta: offer, mode: detectReceiveMode(), state: "checking", sink: null, hash: null, received: 0, count: 0 };
        currentIncoming = inc;
        discarding = false;

        // say no early to what this browser can't take (too big for memory, no storage space)
        const refusal = await refusalReason(inc.mode, offer.size);
        if(currentIncoming !== inc) return;     // the connection closed meanwhile
        if(refusal){
            currentIncoming = null;
            refuseOffer(offer, refusal);
            return;
        }

        inc.state = "offered";
        handleTheirOffer(offer, {
            note: describeReceiveMode(inc.mode),
            onAccept: () => acceptIncoming(inc),
            onDecline: () => declineIncoming(inc, "Declined"),
        });
    }

    async function onFileEnd(end){
        const inc = currentIncoming;
        if(!inc || inc.state !== "receiving" || end.id !== inc.meta.id) return;

        if(inc.received !== inc.meta.size || inc.count !== inc.meta.chunkCount){
            await rejectIncoming("File was incomplete");
            return;
        }
        if(typeof end.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(end.sha256)){
            await rejectIncoming("Missing checksum");
            return;
        }

        // Compare the checksum BEFORE the file is closed: the file only appears on disk at commit().
        inc.state = "finishing";
        if(inc.hash.digestHex() !== end.sha256){
            await rejectIncoming("Checksum mismatch: the file arrived damaged");
            return;
        }

        let result;
        try{
            result = await inc.sink.commit();
        }catch(e){
            console.log(e);
            if(currentIncoming === inc) await rejectIncoming("Could not save the file");
            return;
        }
        if(currentIncoming !== inc) return;     // the connection closed while we were saving
        currentIncoming = null;

        const source = result.file || result.blob;
        finishTransfer(inc.meta.id, source ? URL.createObjectURL(source) : null, result.savedAs);
        reply({type: "file-ack", id: inc.meta.id});
    }

    channel.binaryType = "arraybuffer"

    channel.onmessage = async (event) =>{
        if(typeof event.data === 'string'){
            let recieved;
            try{
                recieved = JSON.parse(event.data);
            }catch(e){
                return;                         // not JSON: ignore it
            }
            if(!recieved || typeof recieved !== "object") return;

            switch(recieved.type){
                case "chat":
                    if(typeof recieved.message !== "string" || recieved.message.length > MAX_CHAT_LENGTH) return;
                    handleTheirMessage(recieved);
                    break;

                // ---- we are the receiver ----
                case "file-offer":
                    await onOffer(recieved);
                    break;
                case "file-end":
                    await onFileEnd(recieved);
                    break;
                case "file-cancel": {           // the sender gave up waiting
                    const inc = currentIncoming;
                    if(!inc || recieved.id !== inc.meta.id) break;
                    currentIncoming = null;
                    discarding = true;
                    failTransfer(inc.meta.id, "Cancelled by the sender");
                    await dropSink(inc);
                    break;
                }

                // ---- we are the sender ----
                case "file-accept":
                    if(typeof recieved.id === "string") settleReply("accept", recieved.id);
                    break;
                case "file-ack":                // the receiver checked the checksum and saved the whole file
                    finishTransfer(recieved.id);
                    if(typeof recieved.id === "string") settleReply("ack", recieved.id);
                    break;
                case "file-decline":
                case "file-error": {            // the receiver said no, or could not complete the file: stop uploading it
                    if(typeof recieved.id !== "string") return;
                    const reason = String(recieved.reason || (recieved.type === "file-decline" ? "Declined by the receiver" : "Receiver could not complete the transfer")).slice(0, 200);
                    cancelledTransfers.add(recieved.id);
                    failTransfer(recieved.id, reason);
                    const failure = new SendFailure(reason);
                    settleReply("accept", recieved.id, failure);
                    settleReply("ack", recieved.id, failure);
                    break;
                }
            }
        }else if(event.data instanceof ArrayBuffer){
            if(discarding) return;              // the rest of a file we already refused
            const inc = currentIncoming;
            if(!inc || inc.state !== "receiving") return;      // data nobody asked for

            // Never take more than the offer allowed: a peer sending millions of tiny chunks would
            // otherwise cost far more memory than the file size suggests.
            const size = event.data.byteLength;
            if(inc.count >= inc.meta.chunkCount || size > inc.meta.chunkSize){
                rejectIncoming("Chunks don't match the announcement");
                return;
            }
            if(inc.received + size > inc.meta.size){
                rejectIncoming("File was larger than announced");
                return;
            }

            inc.hash.update(event.data);
            inc.sink.write(event.data);
            inc.count++;
            inc.received += size;

            if(inc.sink.backlog > MAX_WRITE_BACKLOG){
                rejectIncoming("Your disk can't keep up with the transfer");
                return;
            }
            updateProgress(inc.meta.id, percentOf(inc.received, inc.meta.size), inc.received);
        }
    }

    channel.onopen = () =>{
        console.log("channel opened");
        setStatus("connected");
        setChatEnabled(true);
    }

    channel.onclose = () =>{
        if(channel !== dataChannel){
            console.warn("⚠️ StaleGuard Triggered: Blocked an old/stale close event from tearing down the new active channel.");
            return;
        }

        console.log("✅ Active data channel closed intentionally. Cleaning up state...");
        closeConnection("closed channel");
    }
}

function send(msg){
    try{
        const timeStamp = getFormattedTime();
        const obj = {
            message: msg,
            timestamp: timeStamp,
            type: "chat",
        }
        dataChannel.send(JSON.stringify(obj));
        handleMyMessage(obj);
    }catch(e){
        console.log(e);
        handleMyMessage({
            message: `error in sending message`,
            timestamp: getFormattedTime(),
            type: 'chat'
        }, true);
    }

}

function waitForDrain(channel){
    return new Promise((resolve, reject) => {
        channel.onbufferedamountlow = ()=>{
            channel.onbufferedamountlow = null;
            channel.removeEventListener("close", onClose);
            resolve();
        }

        const onClose = () => reject(new Error("channel closed"));
        channel.addEventListener("close", onClose, { once: true });
    })
}

let FILE_COUNTER = 0;

// Unique per sender, so both peers can send at the same time without clashing.
function newTransferId(){
    FILE_COUNTER += 1;
    return `${socket.id}-${FILE_COUNTER}`;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function percentOf(done, total){
    return total > 0 ? (done / total) * 100 : 100;     // empty file = already complete
}

// Throws on failure: the queue below turns that into a "failed" bubble.
async function sendFile(file, meta){
    const channel = dataChannel;
    if(!channel || channel.readyState !== 'open'){
        throw new SendFailure("Not connected");
    }
    const MAX_BUFFER = 8*1024*1024;
    channel.bufferedAmountLowThreshold = 1024*1024;

    // 1. Offer the file and wait: nothing is sent before the receiver accepts.
    channel.send(JSON.stringify(meta));
    markOffered(meta.id);
    try{
        await waitForReply("accept", meta.id, OFFER_TIMEOUT_MS);
    }catch(err){
        try{ channel.send(JSON.stringify({type: "file-cancel", id: meta.id})); }catch(e){ /* channel is gone */ }
        throw err;
    }

    updateProgress(meta.id, 0, 0);                      // offered -> sending (starts the stopwatch)

    // 2. The chunks. The checksum is computed while sending, so the file is read only once.
    const hash = new Sha256();

    // The loop below sleeps while the buffer drains, so it can't drive the bar by itself
    // (it would freeze, then jump ~7 MB at a time). A timer reads bufferedAmount instead:
    //   handed to the channel - still queued = actually on the wire.
    let handed = 0;
    const tick = setInterval(() => {
        const onTheWire = Math.max(0, handed - channel.bufferedAmount);
        updateProgress(meta.id, percentOf(onTheWire, file.size), onTheWire);
    }, 150);

    try{
        for(let offset = 0; offset<file.size; offset+= CHUNK_SIZE){
            // the receiver said no (invalid, disk full, ...): don't keep uploading
            if(cancelledTransfers.has(meta.id)) throw new SendFailure("Rejected by the receiver");

            if(channel.bufferedAmount > MAX_BUFFER){
                await waitForDrain(channel);
            }
            const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
            hash.update(chunk);
            channel.send(chunk);
            handed = offset + chunk.byteLength;
        }

        // let the queue empty first, so 100% really means "everything is on the wire"
        while(channel.readyState === 'open' && channel.bufferedAmount > 0){
            await wait(50);
        }
        if(channel.readyState !== 'open'){
            throw new Error("channel closed while sending");
        }
        if(cancelledTransfers.has(meta.id)) throw new SendFailure("Rejected by the receiver");
    }finally{
        clearInterval(tick);
    }

    updateProgress(meta.id, 100, file.size);

    // 3. The checksum travels with file-end. The receiver compares it before closing the file, then confirms.
    channel.send(JSON.stringify({type: "file-end", id: meta.id, sha256: hash.digestHex()}));
    await waitForReply("ack", meta.id, ACK_TIMEOUT_MS);   // the bubble turns "Delivered" in the file-ack handler
}

let sendQueue = Promise.resolve();

function queueFile(file){
    const meta = {
        type: "file-offer",
        id: newTransferId(),
        name: file.name,
        size: file.size,
        mimeType: file.type,
        chunkSize: CHUNK_SIZE,
        chunkCount: Math.ceil(file.size / CHUNK_SIZE),
        timestamp: getFormattedTime(),
    };

    // too big: show the bubble as failed straight away and never start sending
    const tooBig = file.size > MAX_DISK_FILE_SIZE;

    // the bubble shows up immediately ("waiting") while earlier files are still sending
    handleMyFile(meta, tooBig ? null : URL.createObjectURL(file));

    if(tooBig){
        failTransfer(meta.id, `File is larger than ${getFormattedSize(MAX_DISK_FILE_SIZE)}`);
        return;
    }

    sendQueue = sendQueue
        .then(() => sendFile(file, meta))
        .catch((err)=>{
            console.log(err);
            failTransfer(meta.id, err instanceof SendFailure ? err.message : "Failed to send");
        })
}

function closeConnection(reason = "disconnected"){
    const channel = dataChannel;
    const pc = peerConnection;

    peerConnection = null;
    dataChannel = null;
    targetPeerId = null;
    peerName = null;
    reconnectBubble = null;
    pendingCandidates = [];
    cancelledTransfers.clear();

    failAllTransfers("Connection lost");
    failAllReplyWaiters(new SendFailure("Connection lost"));

    // a half-received file must not stay behind on disk
    const incoming = currentIncoming;
    currentIncoming = null;
    if(incoming && incoming.sink) incoming.sink.abort().catch(() => {});

    // 1. Close the Data Channel first
    if (channel) {
        // Remove event listeners to prevent leaks
        channel.onmessage = null;
        channel.onopen = null;
        channel.onclose = null;
        channel.onerror = null;

        if (channel.readyState !== 'closed') {
            channel.close();
            console.log("Data channel closed.");
        }
    }

    // 2. Stop all media tracks (Audio/Video) attached to the connection if there are
    if (pc) {

        // 3. Close the Peer Connection
        // Remove core event listeners
        pc.onicecandidate = null;
        pc.ondatachannel = null;
        pc.oniceconnectionstatechange = null;
        pc.onsignalingstatechange = null;
        pc.onconnectionstatechange = null;

        if (pc.signalingState !== 'closed') {
            pc.close();
            console.log("Peer connection closed.");
        }

    }

    setChatEnabled(false);
    setStatus(reason);

    console.log(`connection closed due to ${reason}`);

}
