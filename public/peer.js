
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
    channel.binaryType = "arraybuffer"
    channel.onmessage = (event) =>{
        if(typeof event.data === 'string'){
            console.log(`recieved ${event.data}`);
            const recieved = JSON.parse(event.data);
            
            if(recieved.type === "chat") handleTheirMessage(recieved);
            else if(recieved.type==="file-meta"){
                fileMetaData = recieved;
            }else if(recieved.type==="error"){
                handleMyMessage(recieved, true);
            }
        }else if(event.data instanceof ArrayBuffer || event.data instanceof Blob){
            if(!fileMetaData){
                console.error("Received a file buffer, but missing the metadata!");
                return;
            }
            const buffer = event.data;
            console.log(buffer);

            if(buffer.byteLength !== fileMetaData.size){
                console.log("mismatch between file and buffer size");

                channel.send(JSON.stringify({
                    type: "error",
                    message: "⚠️ error in sending",
                    timestamp: getFormattedTime(),
                }));
                fileMetaData = null;
                return;
            }

            const blob = new Blob([buffer], {type: fileMetaData.mimeType});
            const url = URL.createObjectURL(blob);


            handleTheirFile(fileMetaData, url);
            fileMetaData = null;
        }
    }

    channel.onopen = () =>{
        console.log("channel opened");
        const para = document.getElementById("status");
        para.innerText = "connected";
        document.querySelector(".send-btn").disabled = false;
    }
}

//message ooperations

const chatMessages = document.querySelector("#chatMessages");

function getFormattedTime() {
	const now = new Date();
	return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getFormattedSize(size){
    const sz = size/1024;
    const szFormat = sz.toFixed(1);
    return `${szFormat} KB`;
}

function send(msg){
    const timeStamp = getFormattedTime();
    const obj = {
        message: msg,
        timestamp: timeStamp,
        type: "chat",
    }
    dataChannel.send(JSON.stringify(obj));
    handleMyMessage(obj);
}

async function sendFile(file){
    const timestamp = getFormattedTime();
    console.log(file);
    const buffer = await file.arrayBuffer();
    const obj = {
        type: "file-meta",
        name: file.name,
        size: file.size,
        mimeType: file.type,
        timestamp: timestamp
    }
    const blob = new Blob([buffer], { type: file.mimeType });
    const url = URL.createObjectURL(blob);

    dataChannel.send(JSON.stringify(obj));
    dataChannel.send(buffer);
    handleMyFile(obj, url);
}

function handleMyMessage(obj, isError=false){
    addMessage(obj.message, obj, "me", isError);
}

function handleTheirMessage(obj){
    addMessage(obj.message, obj, "them");
}

const chatbody = document.querySelector(".chat-body");


function addMessage(text, file, who, url, isError=false){
    const msgDiv = document.createElement("div");
    msgDiv.classList.add("msg");

    if(who==="me"){
        msgDiv.classList.add("message-me");
    }else{
        msgDiv.classList.add("message-them");
    }

    if(isError){
        msgDiv.classList.add("error-msg")
    }

    const textSpan = document.createElement("span");
    textSpan.textContent = text;
    msgDiv.appendChild(textSpan);

    if(file.type==="file-meta"){
        if(file.mimeType && file.mimeType.startsWith("image/")){
            //put image thumbnail
            const img = document.createElement("img");
            img.src = url;
            img.alt = file.name;
            img.classList.add("chat-thumbnail");
            msgDiv.appendChild(img);
        }

        const downloadLink = document.createElement("a");
        downloadLink.classList.add("download-btn");
        downloadLink.href = url;
        downloadLink.download = file.name;
        downloadLink.textContent = "⬇ Download";
        if(who==="me") downloadLink.classList.add("download-me");
        else downloadLink.classList.add("download-them")
        msgDiv.appendChild(downloadLink);
    }
    
    const timeSpan = document.createElement("span");
    timeSpan.classList.add("timestamp");
    timeSpan.textContent = file.timestamp;
    msgDiv.appendChild(timeSpan);
    chatMessages.appendChild(msgDiv);
    
    if (chatbody) {
        chatbody.scrollTop = chatbody.scrollHeight;
    }
}

function handleMyFile(file, url){
    const sizeKB =  getFormattedSize(file.size);
    addMessage(`${file.name} (${sizeKB})`, file, "me", url)
}

function handleTheirFile(file, url){
    const sizeKB = getFormattedSize(file.size);
    addMessage(`${file.name} (${sizeKB})`, file, "them", url)
}