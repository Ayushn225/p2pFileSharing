
function initPeerConnection(){
    peerConnection = new RTCPeerConnection(configuration);

    peerConnection.onicecandidate = async (event)=>{
        if(event.candidate && targetPeerId){
            socket.emit('webrtc-ice', {targetPeerId: targetPeerId, candidate: event.candidate});
        }
    }

    peerConnection.ondatachannel = (event)=>{
        console.log("channel recieved");
        dataChannel = event.channel;
        setupChannel(dataChannel);
    };

    peerConnection.onconnectionstatechange = () =>{
        console.log("connection: ", peerConnection.connectionState);
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
    }
    
}

function waitForDrain(){
    return new Promise((resolve, reject) => {
        dataChannel.onbufferedamountlow = ()=>{
            dataChannel.onbufferedamountlow = null;
            dataChannel.removeEventListener("close", onClose);
            resolve();
        }

        const onClose = () => reject(new Error("channel closed"));
        dataChannel.addEventListener("close", onClose, { once: true });
    })
}

async function sendFile(file){
    try{
        const CHUNK_SIZE = 16*1024;
        // const buffer = await file.arrayBuffer();
        const MAX_BUFFER = 8*1024*1024;
        dataChannel.bufferedAmountLowThreshold = 1024*1024;


        const timestamp = getFormattedTime();
        console.log(file);
        const obj = {
            type: "file-meta",
            name: file.name,
            size: file.size,
            mimeType: file.type,
            timestamp: timestamp
        }
        const url = URL.createObjectURL(file);

        dataChannel.send(JSON.stringify(obj));

        handleMyFile(obj, url);

        for(let offset = 0; offset<file.size; offset+= CHUNK_SIZE){
            if(dataChannel.bufferedAmount > MAX_BUFFER){
                await waitForDrain();
            }
            const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
            dataChannel.send(chunk);
        }

        dataChannel.send(JSON.stringify({type: "file-end"}));

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
                message: `⚠️ error in sending queue`,
                timestamp: getFormattedTime(),
            }, true);
        })
}