const chatMessages = document.querySelector("#chatMessages");
const chatbody = document.querySelector(".chat-body");
const objUrls = new Set();

const transfers = new Map();

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
    // clearRecord(currentRoomId, currentName);
    leaveRoom();
    clearChat();
})

function renderRecord(roomId, name){
    try{
        clearChat();

        const records = loadRecord(roomId, name);

        records.forEach((record)=>{
            const {kind} = record??null;
            if(!kind) return;

            switch(kind){
                case "chat":
                    addMessage(record.text, record.time, record.who);
                    break;
                case "file":
                    // The blob is gone after a refresh, so a restored file is always "expired".
                    // No id: it is never updated, and it must not be saved again.
                    createTransferBubble(null, {
                        name: record.name ?? record.text,
                        size: record.size,
                        mimeType: record.mimeType,
                        timestamp: record.time,
                    }, record.who, "expired");
                    break;
                case "system":            
                    updateSystemMessage(null, record.text, record.setActive);
                    break;
            }
        })
    } catch(err) { 
        console.log("error in redering records: ", err);
    }
}

function scrollToBottom(){
    if (chatbody) {
        chatbody.scrollTop = chatbody.scrollHeight;
    }
}

function createBubble(who, timestamp, isError=false){
    const bubble = document.createElement("div");
    bubble.classList.add("msg", who === "me" ? "message-me" : "message-them");

    if(isError){
        bubble.classList.add("message-error");
    }

    const body = document.createElement("div");
    body.classList.add("msg-body");
    bubble.appendChild(body);

    const timeSpan = document.createElement("span");
    timeSpan.classList.add("timestamp");
    timeSpan.textContent = timestamp;
    bubble.appendChild(timeSpan);

    chatMessages.appendChild(bubble);
    scrollToBottom();

    return { bubble, body };
}

// Text messages only. Files have their own bubble: createTransferBubble().
function addMessage(text, timestamp, who, isError=false){
    const { body } = createBubble(who, timestamp, isError);

    const textSpan = document.createElement("span");
    textSpan.textContent = text;
    body.appendChild(textSpan);
}

function clearChat(){
    chatMessages.replaceChildren();

    objUrls.forEach(url =>{
        URL.revokeObjectURL(url);
    })

    objUrls.clear();
    transfers.clear();
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
    addMessage(obj.message, obj.timestamp, "me", isError);
    if(!isError) {
        saveRecord({
            kind: "chat",
            text: obj.message,
            who: "me",
            time: obj.timestamp,
        }, currentRoomId, currentName);
    }
}

function handleTheirMessage(obj){
    addMessage(obj.message, obj.timestamp, "them");
    saveRecord({
        kind: "chat",
        text: obj.message,
        who: "them",
        time: obj.timestamp,
    }, currentRoomId, currentName);
}

// Sender: the bubble appears as soon as the file is queued, in the "waiting" state.
// `url` is a local blob URL of the File, so images can be previewed right away.
function handleMyFile(meta, url){
    createTransferBubble(meta.id, meta, "me", "waiting", url);
}

// Receiver: the bubble appears when file-meta arrives and fills up as chunks come in.
function handleTheirFile(meta){
    createTransferBubble(meta.id, meta, "them", "transferring");
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

function addSystemMessage(text, setActive = false){
    const sysMsg = document.createElement('div');
    sysMsg.innerText = text;
    sysMsg.classList.add("system-message");
    if(setActive) sysMsg.classList.add("success");

    chatMessages.append(sysMsg);

    if (chatbody) {
        chatbody.scrollTop = chatbody.scrollHeight;
    }

    return sysMsg;
}

function updateSystemMessage(el, text, setActive = false){
    if(!el){
        return addSystemMessage(text, setActive);
    }

    el.innerText = text;
    el.classList.remove("success");
    
    if(setActive) el.classList.add("success");

    return el;

}

// ---- File bubbles -------------------------------------------------------------
// One state machine for every file bubble, on both sides:
//
//   waiting ──► transferring ──► done
//      └────────────┴──────────► failed          (restored from history ──► expired)
//
// Who drives it:  sender   = queueFile / sendFile loop / file-ack / file-error
//                 receiver = file-meta / each chunk / file-end

function createTransferBubble(id, file, who, state="waiting", url=null){
    const { bubble, body } = createBubble(who, file.timestamp);

    const titleEl = document.createElement("span");
    titleEl.classList.add("transfer-title");
    titleEl.textContent = (typeof file.size === "number")
        ? `${file.name} (${getFormattedSize(file.size)})`
        : file.name;
    body.appendChild(titleEl);

    const progress = document.createElement("progress");
    progress.classList.add("transfer-progress");
    progress.max = 100;
    body.appendChild(progress);

    const statusEl = document.createElement("span");
    statusEl.classList.add("transfer-status");
    body.appendChild(statusEl);

    const actionsEl = document.createElement("div");
    body.appendChild(actionsEl);

    const t = {
        id, bubble, body, who, file,
        title: titleEl.textContent,
        progress, statusEl, actionsEl,
        preview: null,
        url: null,
        state: null,
        lastPercent: -1,
    };

    if(id !== null && id !== undefined) transfers.set(id, t);
    if(url) attachTransferUrl(t, url);
    setTransferState(t, state);

    return t;
}

function attachTransferUrl(t, url){
    t.url = url;
    objUrls.add(url);       // revoked in clearChat()
    showTransferPreview(t);
}

function showTransferPreview(t){
    if(t.preview || !t.url) return;
    if(!t.file.mimeType || !t.file.mimeType.startsWith("image/")) return;

    const img = document.createElement("img");
    img.src = t.url;
    img.alt = t.file.name;
    img.classList.add("chat-thumbnail");
    img.onload = scrollToBottom;        // the image has no height until it loads
    t.body.insertBefore(img, t.progress);
    t.preview = img;
}

function setTransferState(t, state, detail=""){
    t.state = state;
    t.bubble.classList.toggle("transfer-failed", state === "failed");
    t.actionsEl.replaceChildren();

    const busy = (state === "waiting" || state === "transferring");
    t.progress.hidden = !busy;

    switch(state){
        case "waiting":
            t.progress.removeAttribute("value");    // no value = indeterminate animation
            t.statusEl.textContent = (t.who === "me") ? "Waiting to send…" : "Waiting…";
            break;
        case "transferring":
            t.progress.value = 0;
            t.statusEl.textContent = `${t.who === "me" ? "Sending" : "Receiving"}… 0%`;
            break;
        case "done":
            t.statusEl.textContent = (t.who === "me") ? "✓ Delivered" : "✓ Received";
            addTransferDownloadLink(t);
            break;
        case "failed":
            t.statusEl.textContent = `⚠️ ${detail || "Transfer failed"}`;
            break;
        case "expired":
            t.statusEl.textContent = "No longer available";
            break;
    }
}

function addTransferDownloadLink(t){
    if(!t.url) return;

    const link = document.createElement("a");
    link.classList.add("download-btn", t.who === "me" ? "download-me" : "download-them");
    link.href = t.url;
    link.download = t.file.name;
    link.textContent = "⬇ Download";
    t.actionsEl.appendChild(link);
}

// percent: 0..100. Cheap to call for every chunk: the DOM is only touched
// when the whole-number percent changes (a 500 MB file is ~32,000 chunks).
function updateProgress(id, percent){
    const t = transfers.get(id);
    if(!t || t.state === "done" || t.state === "failed" || t.state === "expired") return;
    if(!Number.isFinite(percent)) return;

    const p = Math.max(0, Math.min(100, Math.floor(percent)));
    if(t.state === "transferring" && p === t.lastPercent) return;

    if(t.state !== "transferring") setTransferState(t, "transferring");

    t.lastPercent = p;
    t.progress.value = p;
    t.statusEl.textContent = (p >= 100)
        ? "Finishing…"
        : `${t.who === "me" ? "Sending" : "Receiving"}… ${p}%`;
}

// Receiver: pass the blob URL of the finished file. Sender: no url (it already has one).
function finishTransfer(id, url){
    const t = transfers.get(id);
    if(!t || t.state === "done" || t.state === "failed") return;

    if(url) attachTransferUrl(t, url);
    setTransferState(t, "done");
    scrollToBottom();

    // The only moment a file becomes "real", so it is also the only place we save it.
    // (Restored bubbles go through createTransferBubble directly, so they are never saved twice.)
    saveRecord({
        kind: "file",
        who: t.who,
        text: t.title,
        time: t.file.timestamp,
        name: t.file.name,
        size: t.file.size,
        mimeType: t.file.mimeType,
    }, currentRoomId, currentName);
}

function failTransfer(id, reason){
    const t = transfers.get(id);
    if(!t || t.state === "done" || t.state === "failed") return;

    setTransferState(t, "failed", reason);
}

// Connection lost / peer left: nothing unfinished can finish any more.
function failAllTransfers(reason){
    transfers.forEach((t, id) => {
        if(t.state === "waiting" || t.state === "transferring") failTransfer(id, reason);
    });
}