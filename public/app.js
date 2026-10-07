const configuration = { iceServers: [{urls: 'stun:stun.l.google.com:19302'}]};
const peerA = new RTCPeerConnection(configuration);
const peerB = new RTCPeerConnection(configuration);

peerA.onicecandidate = event =>{
    if(event.candidate){
        peerB.addIceCandidate(event.candidate)
        .catch(e=>console.log("B->A candidate error", e));
    }
}

peerB.onicecandidate = event => {
    if(event.candidate){
        peerA.addIceCandidate(event.candidate)
        .catch(e=>console.log("A->B candidate error", e));
    }
}

peerA.oniceconnectionstatechange = () => {
    console.log("A.ice: ", peerA.iceConnectionState);
}
peerB.oniceconnectionstatechange = () =>{
    console.log("B ide: ", peerB.iceConnectionState);
}

const channel = peerA.createDataChannel("chat")

function send(msg){
    const obj = {
        message: msg,
        timestamp: new Date(),
    }
    channel.send(JSON.stringify(obj));
}

async function setOffer(){
    try{
        const offer = await peerA.createOffer();
        await peerA.setLocalDescription(offer);
        await peerB.setRemoteDescription(peerA.localDescription);
        const answer = await peerB.createAnswer();
        await peerB.setLocalDescription(answer);
        await peerA.setRemoteDescription(peerB.localDescription);
    }catch(e){
        console.log(`error ${e}`);
    }
}

setOffer();

channel.onopen = () =>{
    console.log("channel opened");
    send("hello");
}

channel.onmessage = (event)=>{
    console.log(`A recieved ${event.data}`);
}

channel.onclose = () => {
  console.log("datachannel close");
};

peerB.ondatachannel = e =>{
    const bChannel = e.channel;
    console.log("b recieved channel");

    bChannel.onmessage = (event) =>{
        console.log(`B recieved ${event.data}`);
    }
}