const socket = io();

const configuration = { iceServers: [{urls: 'stun:stun.l.google.com:19302'}]};
const forceRelay = new URLSearchParams(location.search).get("relay") === "1";

let peerConnection;
let dataChannel;
let targetPeerId;
let currentRoomId = null;
let currentName = null;
let peerName = null;

// Candidates that arrive before the offer/answer has been applied (see applyRemoteDescription).
let pendingCandidates = [];

// Never rejects: on any problem we simply keep the STUN-only defaults.
async function loadIceConfig(){
    try{
        const res = await fetch("/ice-config", {cache: "no-store"});
        if(!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if(Array.isArray(data.iceServers) && data.iceServers.length){
            configuration.iceServers = data.iceServers;
        }
    }catch(e){
        console.log("using default ICE servers:", e);
    }
    if(forceRelay) configuration.iceTransportPolicy = "relay";
}
const iceConfigReady = loadIceConfig();

// Join only after the ICE settings are known, so the very first RTCPeerConnection already has them.
function emitJoin(){
    iceConfigReady.then(()=>{
        if(!currentRoomId) return;      // left the room while we were waiting
        socket.emit('join', {
            roomId: currentRoomId,
            name: currentName,
        });
    });
}

function joinRoom(roomId, name){
    currentRoomId = roomId;
    currentName = name;
    if (socket.connected) emitJoin();
}

socket.on("connect", ()=>{
    if(!currentRoomId) {
        console.log("no room id");
        return;
    }
    console.log('Connected to server with ID:', socket.id);
    // 1. Tell the server we want to join a specific room
    emitJoin();
});

// The offer/answer and the first ICE candidates travel right behind each other, and the
// handler for the offer/answer is still awaiting setRemoteDescription when the candidates
// arrive. Adding a candidate before the remote description exists throws, so those early
// candidates (often the ones that matter most) used to be lost. Queue them instead.
async function applyRemoteDescription(pc, sdp){
    await pc.setRemoteDescription(sdp);
    if(pc !== peerConnection) return;       // this connection was closed in the meantime

    const queued = pendingCandidates;
    pendingCandidates = [];
    for(const candidate of queued){
        try{
            await pc.addIceCandidate(candidate);
        }catch(e){
            console.log(`error adding queued candidate: ${e}`);
        }
    }
}

socket.on('webrtc-ice', async ({candidate})=>{
    try{
        if(!peerConnection || !candidate) return;

        if(!peerConnection.remoteDescription){
            pendingCandidates.push(candidate);      // too early: keep it for applyRemoteDescription
            return;
        }
        await peerConnection.addIceCandidate(candidate);
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
        updateSystemMessage(null, `${peerName} joined`, true);
        saveRecord({
            kind: "system",
            text: `${peerName} joined`,
            setActive: true,
        }, currentRoomId, currentName)
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
    chatHistory = [];
    leaveReset();
    setLobbyError(data);
})

socket.on("peer-left", (data)=>{
    console.log('New room notification:', data.message);

    if(reconnectBubble) {
        updateSystemMessage(reconnectBubble, `${data.peerName} left`, false);
    }else{
        updateSystemMessage(null,  `${data.peerName} left`, false);
    }

    saveRecord({
        kind: "system",
        text: `${data.peerName} left`,
        setActive: false,
    }, currentRoomId, currentName);

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

        updateSystemMessage(null, `${peerName?? "Peer"} joined`, true);

        saveRecord({
            kind: "system",
            text: `${peerName?? "Peer"} joined`,
            setActive: true,
        }, currentRoomId, currentName)
    }
});

socket.on('webrtc-offer', async ({senderId, sdp})=>{
    const pc = peerConnection;  
    try{
        if(!pc) return;

        if(senderId!==targetPeerId){
            console.log("wrong person");
            return;
        }

        await applyRemoteDescription(pc, sdp);
        if(pc !== peerConnection) return;

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if(pc !== peerConnection) return;

        socket.emit('webrtc-answer', {targetPeerId: targetPeerId, sdp: pc.localDescription});
    } catch (e){
        console.log(`error in webrtc-offer: ${e}`);
    }

});

socket.on('webrtc-answer', async ({ sdp })=>{
    const pc = peerConnection;
    try{
        if(!pc) return;
        await applyRemoteDescription(pc, sdp);
    }catch (e){
        console.log(`error in webrtc-answer: ${e}`);
    }

});

function leaveRoom(){
    socket.emit('leave_room', currentRoomId);
    clearRecord(currentRoomId, currentName);
    leaveReset();
    closeConnection("room left");
}

function leaveReset(){
    currentRoomId = null;
    showView("lobby");
    history.replaceState({}, "", location.pathname);
    peerName = null;
}