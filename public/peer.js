let recconectBubble = null;

function initPeerConnection(){
    const pc = new RTCPeerConnection(configuration);
    peerConnection = pc;

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
            case 'failed':
                if(recconectBubble){
                    updateSystemMessage(recconectBubble, `Connection Lost`, true);
                    recconectBubble = null;
                }else{
                    updateSystemMessage(null, `Connection to ${peerName?? "Peer"} is lost`, false);
                }
                closeConnection('failed');
                break;
            case 'disconnected':
                setStatus("reconnecting....")
                if(!recconectBubble) recconectBubble = updateSystemMessage(null, `${peerName?? "Peer"} is reconnecting...`, false);
                break;
            case 'connected':
                setStatus("connected")
                if(recconectBubble) updateSystemMessage(recconectBubble, `${peerName?? "Peer"} reconnected`, true);
                recconectBubble = null;
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

    function resetReceive(){
        chunks = [];
        fileMetaData = null;
        recievedBytes = 0;
    }

    channel.binaryType = "arraybuffer"

    channel.onmessage = (event) =>{
        if(typeof event.data === 'string'){
            // console.log(`recieved ${event.data}`);
            const recieved = JSON.parse(event.data);
            
            if(recieved.type === "chat") handleTheirMessage(recieved);
            else if(recieved.type==="file-meta"){
                // console.log("in the file meta");
                resetReceive();
                fileMetaData = recieved;
            }else if(recieved.type === "file-end"){
                //signal that its ended
                // console.log("in the file end");
                if(!fileMetaData) return;
                if(recievedBytes !== fileMetaData.size){
                    console.log("mismatch between file and buffer size");

                    channel.send(JSON.stringify({
                        type: "error",
                        message: `⚠️ error in sending ${fileMetaData.name}`,
                        timestamp: getFormattedTime(),
                    }));
                    resetReceive();
                    return;
                }

                const blob = new Blob(chunks, {type: fileMetaData.mimeType});
                const url = URL.createObjectURL(blob);
                // console.log(url);
                handleTheirFile(fileMetaData, url);
                resetReceive();

            }else if(recieved.type==="error"){
                handleMyMessage(recieved, true);
            }
        }else if(event.data instanceof ArrayBuffer || event.data instanceof Blob){
            // console.log("in the file buffer recieving");
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
                resetReceive();
                return;
            }
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

async function sendFile(file){
    try{
        const channel = dataChannel;
        if(!channel || channel.readyState !== 'open'){
            throw new Error("cannot send file channel is not open");
        }
        const CHUNK_SIZE = 16*1024;
        // const buffer = await file.arrayBuffer();
        const MAX_BUFFER = 8*1024*1024;
        channel.bufferedAmountLowThreshold = 1024*1024;

        const timestamp = getFormattedTime();
        // console.log(file);
        const obj = {
            type: "file-meta",
            name: file.name,
            size: file.size,
            mimeType: file.type,
            timestamp: timestamp
        }
        const url = URL.createObjectURL(file);

        channel.send(JSON.stringify(obj));

        handleMyFile(obj, url);

        for(let offset = 0; offset<file.size; offset+= CHUNK_SIZE){
            if(channel.bufferedAmount > MAX_BUFFER){
                await waitForDrain(channel);
            }
            const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
            channel.send(chunk);
        }

        channel.send(JSON.stringify({type: "file-end"}));

    }catch(e){
        console.log("file send failed");
        console.log(e);
        throw e;
    }
}

let sendQueue = Promise.resolve();

function queueFile(file){
    sendQueue = sendQueue
        .then(() => sendFile(file))
        .catch((err)=>{
            console.log(err);
            handleMyMessage({
                type: "error",
                message: `⚠️ error in sending queue: ${file.name}`,
                timestamp: getFormattedTime(),
            }, true);
        })
}

function closeConnection(reason = "disconnected"){
    const channel = dataChannel;
    const pc = peerConnection;

    peerConnection = null;
    dataChannel = null;
    targetPeerId = null;
    peerName = null;
    recconectBubble = null;

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