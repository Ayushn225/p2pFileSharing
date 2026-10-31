let chatHistory = [];
const maxSize = 200;

function saveRecord(record, roomId, name){
    if (!roomId || !name) return;
    try{
        if(!roomId || !name) return;
        if(!record || typeof record !== "object") return;
        const {kind} = record;
        if(kind==="chat" || kind==="file"){
            const {who, text, time} = record;
            if(!roomId || !kind || !who || !text || !time) return;
        }
        

        chatHistory.push(record);

        if(chatHistory.length>maxSize){
            chatHistory = chatHistory.slice(-maxSize);
        }

        localStorage.setItem(`chat:${roomId}:${name}`, JSON.stringify(chatHistory));
    } catch(err){
        console.log("error saving record: ", err);
    }
}

function loadRecord(roomId, name){
    if (!roomId || !name) return;
    try{
        const data = JSON.parse(localStorage.getItem(`chat:${roomId}:${name}`))??[];
        chatHistory = Array.isArray(data)? data : [];
        return chatHistory;
    } catch(err){
        console.log("error loading record: ", err);
        return [];
    }
}

function clearRecord(roomId, name){
    if (!roomId || !name) return;
    try{
        localStorage.removeItem(`chat:${roomId}:${name}`);
        chatHistory = [];
    } catch(err){
        console.log("error clearing record: ", err);
    }
}