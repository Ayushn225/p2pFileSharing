const socket = io();
const configuration = { iceServers: [{urls: 'stun:stun.l.google.com:19302'}]};

let peerConnection;
let dataChannel;
let targetPeerId;
let currentRoomId = null;
let currentName = null;
let peerName = null;

function joinRoom(roomId, name){
    currentRoomId = roomId;
    currentName = name;
    if (socket.connected) socket.emit('join', {
        roomId: currentRoomId,
        name: currentName,
    });
}

socket.on("connect", ()=>{
    if(!currentRoomId) {
        console.log("no room id");
        return;
    }
    console.log('Connected to server with ID:', socket.id);
    // 1. Tell the server we want to join a specific room
    socket.emit('join', {
        roomId: currentRoomId,
        name: currentName,
    });
});

socket.on('webrtc-ice', async ({candidate})=>{
    try{
        if(peerConnection && candidate){
            await peerConnection.addIceCandidate(candidate);
        }
    } catch (e){
        console.log(`error in peerconnection add ice: ${e}`);
    }
    
});

socket.on("peer-joined", async (data)=>{
    try{
        closeConnection('peer-joined'); //safety net in case old connection is still there
        console.log('New room notification:', data.message);
        setStatus(data.message);
        targetPeerId = data.targetPeerId;
        peerName = data.peerName;
        addSystemMessage(`${peerName} joined`, true);
        initPeerConnection();

        dataChannel = peerConnection.createDataChannel("file");
        setupChannel(dataChannel);

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('webrtc-offer', {targetPeerId: targetPeerId, sdp: peerConnection.localDescription});
    }catch(err){
        console.log("error peer-joined: ", err);
    }
})

socket.on("room-full", (data)=>{
    console.log('New room notification:', data);
    // setStatus(data)
    leaveReset();
    setLobbyError(data);
})

socket.on("peer-left", (data)=>{
    console.log('New room notification:', data.message);

    if(recconectBubble) {
        updateSystemMessage(recconectBubble, `${data.peerName} left`, false);
        recconectBubble = null;
    }else{
        updateSystemMessage(null,  `${data.peerName} left`, false);
    }
    closeConnection("peer left, waiting...");
});

socket.on("joined", (data)=>{
    console.log('New room notification:', data.message);

    const count = data.count;
    setStatus(data.message);
    if(count === 2){
        closeConnection('joined');
        targetPeerId = data.targetPeerId;
        initPeerConnection();
        peerName = data.peerName;

        updateSystemMessage(null, `${peerName?? "Peer"} joined`);
    }
});

socket.on('webrtc-offer', async ({senderId, sdp})=>{
    try{
        if(!peerConnection) return;
        
        if(senderId!==targetPeerId){
            console.log("wrong person");
            return;
        }

        await peerConnection.setRemoteDescription(sdp);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        socket.emit('webrtc-answer', {targetPeerId: targetPeerId, sdp: peerConnection.localDescription});
    } catch (e){
        console.log(`error in webrtc-offer: ${e}`);
    }
    
});

socket.on('webrtc-answer', async ({ sdp })=>{
    try{
        if(!peerConnection) return;
        await peerConnection.setRemoteDescription(sdp);
    }catch (e){
        console.log(`error in webrtc-answer: ${e}`);
    }
    
});

function leaveRoom(){
    socket.emit('leave_room', currentRoomId);
    leaveReset();
    closeConnection("room left");
}

function leaveReset(){
    currentRoomId = null;
    showView("lobby");
    history.replaceState({}, "", location.pathname);
    peerName = null;
}