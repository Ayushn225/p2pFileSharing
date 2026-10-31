const express = require('express')
const http = require('http');
const path = require('path');
const { Server } = require("socket.io");

const app = express()
const port = process.env.PORT || 3000;

const server = http.createServer(app)
const publicPath = path.join(__dirname, "public")

app.use(express.static(publicPath));

server.listen(port, ()=>{
  console.log(`server listening on port http://localhost:${port}`);
})

// const io = new Server(server, { cors: {origin: "*"}})
const io = new Server(server);

// Signals (offer / answer / ICE) may only go to the other person in the SAME room.
// Returns the target socket, or null if the request isn't allowed.
function relayTarget(socket, targetPeerId){
  if(!socket.data.roomId) return null;                 // sender isn't in a room
  if(typeof targetPeerId !== "string") return null;

  const target = io.sockets.sockets.get(targetPeerId);
  if(!target || target.id === socket.id) return null;  // unknown socket, or sending to yourself

  return target.data.roomId === socket.data.roomId ? target : null;
}

io.on("connection", (socket)=>{

  console.log(`User connected: ${socket.id}`);

  // 1. Listen for the 'join-room' event from the client
  socket.on("join", (payload) => {
    if(!payload || typeof payload !== "object") return;
    const {roomId} = payload;
    if(typeof roomId != "string" ||  !/^[a-zA-Z0-9-]{1,32}$/.test(roomId)) return;

    let name = typeof payload.name === "string"? payload.name.trim().slice(0, 20): "";
    console.log(`${name} asking for joining ${roomId}`);
    //check for room
    if (socket.data.roomId === roomId) return; 
    if(!name) name = "Guest";

    const room = io.sockets.adapter.rooms.get(roomId);
    const roomSize = room?.size ?? 0;

    socket.data.name = name;
    
    if(roomSize >= 2){
      console.log(`room ${roomId} is full`);
      socket.emit("room-full", "room is full please request some time later");
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    if(roomSize === 0){
      console.log(`first person joined room ${roomId}`);

      //get calleId
      socket.emit("joined", {
        count: 1,
        message: "waiting for other...",
      });

    }else{

      const calle = Array.from(room).at(0);
      if(calle){
        socket.data.targetPeerId = calle
      }

      console.log(`another joined room ${roomId}`);
      
      socket.emit("joined", {
        count: 2,
        message: "welcome",
        targetPeerId: calle,
        peerName: io.sockets.sockets.get(calle)?.data.name,
      });

      socket.to(roomId).emit("peer-joined", {
        message: `${socket.id} joined the room`,
        targetPeerId: socket.id,
        peerName: socket.data.name,
      });
    }
  });

  // The client is untrusted: any payload (even none) can arrive, so check it before using it.
  socket.on('webrtc-offer', (payload)=>{
    if(!payload || typeof payload !== "object") return;
    const target = relayTarget(socket, payload.targetPeerId);
    if(!target) return;
    target.emit('webrtc-offer', { senderId: socket.id, sdp: payload.sdp});
  });

  socket.on('webrtc-answer', (payload)=>{
    if(!payload || typeof payload !== "object") return;
    const target = relayTarget(socket, payload.targetPeerId);
    if(!target) return;
    target.emit('webrtc-answer', { sdp: payload.sdp});
  });

  socket.on('webrtc-ice', (payload)=>{
    if(!payload || typeof payload !== "object") return;
    const target = relayTarget(socket, payload.targetPeerId);
    if(!target) return;
    target.emit('webrtc-ice', { candidate: payload.candidate });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    console.log(`User disconnected: ${socket.id}`);
    if(!roomId) return;
    socket.to(roomId).emit("peer-left", {
      message: `${socket.id} left the room`,
      peerName: socket.data.name,
    });
  });

  socket.on('leave_room', (roomId)=>{
    if(!roomId || roomId !== socket.data.roomId) return;
    socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.targetPeerId = null;
    io.to(roomId).emit('peer-left',  {
      message: `${socket.id} left the room`,
      peerName: socket.data.name,
    });
  });

})

