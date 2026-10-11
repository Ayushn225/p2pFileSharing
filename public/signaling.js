const socket = io();
const queryString = window.location.search;
const urlParams = new URLSearchParams(queryString); 
const roomId = urlParams.get('roomId')?? "test"; //added deafult room

let peerConnection;
let dataChannel;
let targetPeerId;

const statusPara = document.getElementById("status");

socket.on("connect", ()=>{
    console.log('Connected to server with ID:', socket.id);
    // 1. Tell the server we want to join a specific room
    socket.emit('join', roomId);
});

const configuration = { iceServers: [{urls: 'stun:stun.l.google.com:19302'}]};

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
    channel.onmessage = (event) =>{
        console.log(`recieved ${event.data}`);
    }

    channel.onopen = () =>{
        console.log("channel opened");
        send("hello");
    }
}

socket.on('webrtc-ice', async ({candidate})=>{

    if(peerConnection && candidate){
        await peerConnection.addIceCandidate(candidate);
    }
});

socket.on("peer-joined", async (data)=>{
    console.log('New room notification:', data.message);
    statusPara.innerText = data.message;
    targetPeerId = data.targetPeerId;

    initPeerConnection();

    dataChannel = peerConnection.createDataChannel("file");
    setupChannel(dataChannel);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('webrtc-offer', {targetPeerId: targetPeerId, sdp: peerConnection.localDescription});
})

socket.on("room-full", (data)=>{
    console.log('New room notification:', data);
    statusPara.innerText = data;
})

socket.on("peer-left", (data)=>{
    console.log('New room notification:', data);
    statusPara.innerText = data;
})

socket.on("joined", (data)=>{
    console.log('New room notification:', data.message);

    const count = data.count;
    statusPara.innerText = data.message;

    if(count === 2){
        targetPeerId = data.targetPeerId;
        initPeerConnection();
    }
});

socket.on('webrtc-offer', async ({senderId, sdp})=>{
    if(senderId!=targetPeerId){
        console.log("wrong person");
        return;
    }
    await peerConnection.setRemoteDescription(sdp);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    socket.emit('webrtc-answer', {targetPeerId: targetPeerId, sdp: peerConnection.localDescription});
});

socket.on('webrtc-answer', async ({ sdp })=>{
    await peerConnection.setRemoteDescription(sdp)
});

function send(msg){
    const obj = {
        message: msg,
        timestamp: new Date()
    }

    dataChannel.send(JSON.stringify(obj));
}