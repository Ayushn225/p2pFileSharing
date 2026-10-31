let reconnectBubble = null;

const MAX_FILE_SIZE = 500 * 1024 * 1024;    // the receiver keeps the whole file in memory
const MAX_CHAT_LENGTH = 5000;

// Ids of files the receiver rejected: the sender stops uploading them.
const cancelledTransfers = new Set();

// Everything that arrives over the data channel comes from the other person: never trust it.
// Returns the reason a file-meta is unacceptable, or null when it is fine.
function checkFileMeta(meta){
    if(typeof meta.id !== "string" || meta.id.length === 0 || meta.id.length > 100) return "Invalid file";
    if(typeof meta.name !== "string" || meta.name.length === 0 || meta.name.length > 255) return "Invalid file name";
    if(!Number.isSafeInteger(meta.size) || meta.size < 0) return "Invalid file size";
    if(meta.size > MAX_FILE_SIZE) return `File is larger than ${getFormattedSize(MAX_FILE_SIZE)}`;
    if(meta.mimeType !== undefined && (typeof meta.mimeType !== "string" || meta.mimeType.length > 100)) return "Invalid file type";
    if(typeof meta.timestamp !== "string" || meta.timestamp.length > 40) return "Invalid file";
    return null;
}

// Control and bidi-override characters can make "evil‮gnp.exe" look like something else.
function cleanFileName(name){
    const cleaned = name
        .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "")
        .replace(/[\/\\]/g, "_")
        .trim();
    return cleaned || "file";
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
    let fileMetaData = null;
    let chunks = [];
    let recievedBytes = 0;
    let discarding = false;     // true after we rejected a file: its remaining chunks are dropped silently

    function resetReceive(){
        chunks = [];
        fileMetaData = null;
        recievedBytes = 0;
    }

    // Small replies (ack / error) must never throw inside onmessage.
    function reply(obj){
        try{
            channel.send(JSON.stringify(obj));
        }catch(e){
            console.log("could not reply:", e);
        }
    }

    // The incoming file can't be completed: fail our bubble, tell the sender which file, start clean.
    function rejectIncomingFile(reason){
        const id = fileMetaData.id;
        failTransfer(id, reason);
        reply({type: "file-error", id, reason});
        resetReceive();
        discarding = true;
    }

    // The announcement itself is unacceptable (too big, malformed, ...): no bubble, just a notice.
    function rejectFileMeta(meta, reason){
        discarding = true;
        updateSystemMessage(null, `Rejected a file from ${peerName ?? "your peer"}: ${reason}`, false);
        if(typeof meta.id === "string"){
            reply({type: "file-error", id: meta.id.slice(0, 100), reason});
        }
    }

    channel.binaryType = "arraybuffer"

    channel.onmessage = (event) =>{
        if(typeof event.data === 'string'){
            // console.log(`recieved ${event.data}`);
            let recieved;
            try{
                recieved = JSON.parse(event.data);
            }catch(e){
                return;                         // not JSON: ignore it
            }
            if(!recieved || typeof recieved !== "object") return;
            
            if(recieved.type === "chat"){
                if(typeof recieved.message !== "string" || recieved.message.length > MAX_CHAT_LENGTH) return;
                handleTheirMessage(recieved);
            }else if(recieved.type==="file-meta"){
                // a new file while another is unfinished: the old one is abandoned
                if(fileMetaData) failTransfer(fileMetaData.id, "Interrupted");
                resetReceive();

                const problem = checkFileMeta(recieved);
                if(problem){
                    rejectFileMeta(recieved, problem);
                    return;
                }

                discarding = false;
                recieved.name = cleanFileName(recieved.name);
                fileMetaData = recieved;
                handleTheirFile(recieved);      // bubble appears, receiving 0%
            }else if(recieved.type === "file-end"){
                if(!fileMetaData || recieved.id !== fileMetaData.id) return;

                if(recievedBytes !== fileMetaData.size){
                    rejectIncomingFile("File was incomplete");
                    return;
                }

                const blob = new Blob(chunks, {type: fileMetaData.mimeType});
                const url = URL.createObjectURL(blob);
                finishTransfer(fileMetaData.id, url);
                reply({type: "file-ack", id: fileMetaData.id});
                resetReceive();

            }else if(recieved.type === "file-ack"){
                // sender side: the receiver has the whole file
                finishTransfer(recieved.id);
            }else if(recieved.type === "file-error"){
                // sender side: the receiver could not complete this file, so stop uploading it
                if(typeof recieved.id !== "string") return;
                cancelledTransfers.add(recieved.id);
                failTransfer(recieved.id, String(recieved.reason || "Receiver could not complete the transfer").slice(0, 200));
            }
        }else if(event.data instanceof ArrayBuffer || event.data instanceof Blob){
            if(discarding) return;      // the rest of a file we already rejected
            if(!fileMetaData){
                console.error("Received a file buffer, but missing the metadata!");
                resetReceive();
                return;
            }
            // const buffer = event.data;
            // console.log(recievedBytes);

            chunks.push(event.data);
            recievedBytes += event.data.byteLength;
            if(recievedBytes > fileMetaData.size){
                console.error("recievedBye is greater than expected");
                rejectIncomingFile("File was larger than announced");
                return;
            }

            updateProgress(fileMetaData.id, percentOf(recievedBytes, fileMetaData.size));
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
        throw new Error("cannot send file channel is not open");
    }
    const CHUNK_SIZE = 16*1024;
    const MAX_BUFFER = 8*1024*1024;
    channel.bufferedAmountLowThreshold = 1024*1024;

    channel.send(JSON.stringify(meta));
    updateProgress(meta.id, 0);                         // waiting -> sending

    // The loop below sleeps while the buffer drains, so it can't drive the bar by itself
    // (it would freeze, then jump ~7 MB at a time). A timer reads bufferedAmount instead:
    //   handed to the channel - still queued = actually on the wire.
    let handed = 0;
    const tick = setInterval(() => {
        updateProgress(meta.id, percentOf(handed - channel.bufferedAmount, file.size));
    }, 150);

    try{
        for(let offset = 0; offset<file.size; offset+= CHUNK_SIZE){
            // the receiver said no (too big, invalid, ...): don't keep uploading
            if(cancelledTransfers.has(meta.id)) throw new Error("rejected by the receiver");

            if(channel.bufferedAmount > MAX_BUFFER){
                await waitForDrain(channel);
            }
            const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
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
        if(cancelledTransfers.has(meta.id)) throw new Error("rejected by the receiver");
    }finally{
        clearInterval(tick);
    }

    updateProgress(meta.id, 100);
    channel.send(JSON.stringify({type: "file-end", id: meta.id}));
    // no "done" here: the bubble turns "Delivered" when the receiver's file-ack arrives
}

let sendQueue = Promise.resolve();

function queueFile(file){
    const meta = {
        type: "file-meta",
        id: newTransferId(),
        name: file.name,
        size: file.size,
        mimeType: file.type,
        timestamp: getFormattedTime(),
    };

    // too big: show the bubble as failed straight away and never start sending
    const tooBig = file.size > MAX_FILE_SIZE;

    // the bubble shows up immediately ("waiting") while earlier files are still sending
    handleMyFile(meta, tooBig ? null : URL.createObjectURL(file));

    if(tooBig){
        failTransfer(meta.id, `File is larger than ${getFormattedSize(MAX_FILE_SIZE)}`);
        return;
    }

    sendQueue = sendQueue
        .then(() => sendFile(file, meta))
        .catch((err)=>{
            console.log(err);
            failTransfer(meta.id, "Failed to send");
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