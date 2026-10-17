const chatMessages = document.querySelector("#chatMessages");
const chatbody = document.querySelector(".chat-body");
const objUrls = new Set();

document.getElementById('copyLinkBtn').addEventListener('click', async function(){
    const btn = this;
    const currUrl = window.location.href;

    try{
        await navigator.clipboard.writeText(currUrl);

        btn.textContent = 'Copied!';
        btn.disabled = true;

        setTimeout(()=>{
            btn.textContent = 'Copy Link';
            btn.disabled = false;
        }, 2000);
    }catch (err){
        console.error('Failed to copy text: ', err);
        btn.textContent = 'Error!';
        
        setTimeout(() => {
            btn.textContent = 'Copy Link';
            btn.disabled = false;
        }, 2000);
    }
});

document.getElementById('leaveRoomBtn').addEventListener('click', function(){
    
    leaveRoom();
    clearChat();
})

function addMessage(text, file, who, url, isError=false){
    const msgDiv = document.createElement("div");
    msgDiv.classList.add("msg");

    if(who==="me"){
        msgDiv.classList.add("message-me");
    }else{
        msgDiv.classList.add("message-them");
    }

    if(isError){
        msgDiv.classList.add("message-error");
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
            img.onload = ()=> chatbody.scrollTop = chatbody.scrollHeight;
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
        objUrls.add(url);
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

function clearChat(){
    chatMessages.replaceChildren();

    objUrls.forEach(url =>{
        URL.revokeObjectURL(url);
    })

    objUrls.clear();
}

function getFormattedTime() {
	const now = new Date();
	return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getFormattedSize(size){
    const suff = ['B', 'KB', 'MB', 'GB', 'TB'];
    let sz = size;
    let i = 0;
    while(sz>1024 && i<suff.length-1){
        sz = sz/1024
        i++;
    }

    sz = sz.toFixed(1);

    return `${sz} ${suff[i]}`;
}

function handleMyMessage(obj, isError=false){
    addMessage(obj.message, obj, "me", null, isError);
}

function handleTheirMessage(obj){
    addMessage(obj.message, obj, "them", null);
}

function handleMyFile(file, url){
    const sizeKB =  getFormattedSize(file.size);
    addMessage(`${file.name} (${sizeKB})`, file, "me", url)
}

function handleTheirFile(file, url){
    const sizeKB = getFormattedSize(file.size);
    addMessage(`${file.name} (${sizeKB})`, file, "them", url)
}

const form = document.querySelector(".input-container");
const input = document.querySelector(".chat-input");
const sendBtn = document.querySelector(".send-btn");
const fileInput = document.querySelector("#fileInput");
const fileNameDisplay = document.querySelector("#fileNameDisplay");
const fileText = fileNameDisplay.querySelector(".file-text");
const clearFileBtn = document.querySelector("#clearFileBtn");

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sendBtn.disabled) return;

    const messageText = input.value.trim();
    const isText = messageText !== "";
    const isFile = fileInput.files.length > 0;

    if (!isText && !isFile) {
        return;
    }

    if (isText) {
        console.log("sending: ", input.value);
        send(messageText);

        input.value = "";
    }
    if(isFile) {
        const files = Array.from(fileInput.files);
        hideFileBadge();
        files.forEach(queueFile);
    }
});

fileInput.addEventListener("change", () => {
    if (fileInput.files.length == 1) {
        const chosenFileName = fileInput.files[0].name;
        fileText.textContent = `📁 ${chosenFileName}`;
        fileNameDisplay.style.display = "flex";
    } else if(fileInput.files.length>1) {
        fileText.textContent = `📁 ${fileInput.files.length} files selected`;
        fileNameDisplay.style.display = "flex";
    } else {
        hideFileBadge();
    }
});

clearFileBtn.addEventListener("click", () => {
    hideFileBadge();
});

function hideFileBadge() {
    fileInput.value = "";
    fileText.textContent = "";
    fileNameDisplay.style.display = "none";
}

function setStatus(text){
    const status = document.getElementById("status");
    status.innerText = text;
}

function setChatEnabled(boolVal){
    document.querySelector(".send-btn").disabled = !boolVal;
}

function showView(viewName = "lobby"){
    const lobbySection = document.querySelector("#lobby");
    const chatSection = document.querySelector("#chat");
    if(viewName === "lobby"){
        lobbySection.classList.remove("hidden");
        chatSection.classList.add("hidden");
    }else if(viewName === "chat"){
        lobbySection.classList.add("hidden");
        chatSection.classList.remove("hidden");
    }
}

function setLobbyError(errorMessage) {
    const errorElement = document.getElementById('lobbyError');
    
    if (errorMessage) {
        errorElement.textContent = errorMessage;
        errorElement.style.display = 'block'; // Shows the error
    } else {
        errorElement.textContent = '';
        errorElement.style.display = 'none';  // Hides the error
    }
}