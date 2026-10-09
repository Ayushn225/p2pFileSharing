const socket = io();
const queryString = window.location.search;
const urlParams = new URLSearchParams(queryString); 
const roomId = urlParams.get('roomId')?? "test"; //added deafult room

const statusPara = document.getElementById("status");

socket.on("connect", ()=>{
    console.log('Connected to server with ID:', socket.id);

    // 1. Tell the server we want to join a specific room
    socket.emit('join', roomId);
});

socket.on("peer-joined", (data)=>{
    console.log('New room notification:', data);
    statusPara.innerText = data;
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
    console.log('New room notification:', data);
    statusPara.innerText = data;
});
