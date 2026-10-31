const ROOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function generateRoomId(length = 12){
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => ROOM_ALPHABET[b & 31]).join("");
}

document.addEventListener('DOMContentLoaded', () => {
    const nameInputElement = document.getElementById('userName');
    const roomIdInputElement = document.getElementById('roomId');
    const lobbyForm = document.getElementById('lobbyForm');

    const savedName = localStorage.getItem('name');
    const lastRoom = localStorage.getItem('lastJoinedRoom');

    if (savedName) nameInputElement.value = savedName;
    if (lastRoom) roomIdInputElement.placeholder = `Leave empty to create a new room (last: ${lastRoom})`;

    const roomFromUrl = new URLSearchParams(location.search).get("room");

    if (roomFromUrl) {
        if (savedName && savedName.trim() !== "") {
            showView("chat");
            renderRecord(roomFromUrl, savedName);
            joinRoom(roomFromUrl, savedName);
        } else {
            showView("lobby");
            if (roomIdInputElement) roomIdInputElement.value = roomFromUrl;
            if (nameInputElement) nameInputElement.focus();
        }
    } else {
        showView("lobby");
    }

    document.getElementById('generateRoomBtn').addEventListener('click', () => {
        roomIdInputElement.value = generateRoomId();
        roomIdInputElement.focus();
    });

    lobbyForm.addEventListener('submit', (event) => {
        event.preventDefault();

        let nameValue = nameInputElement.value.trim();
        let roomValue = roomIdInputElement.value.trim();

        if (nameValue === "") {
            setLobbyError("Please write a name")
            return;
        }
        if (roomValue === "") {
            // empty = "create a new room": make an unguessable ID for it
            roomValue = generateRoomId();
            roomIdInputElement.value = roomValue;
        }

        const checkValidRoom = /^[a-zA-Z0-9-]{1,32}$/.test(roomValue);
        if(!checkValidRoom){
            roomIdInputElement.value = "";
            roomIdInputElement.focus();
            setLobbyError(`invalid room id`);
            return;
        }

        localStorage.setItem('name', nameValue);
        localStorage.setItem('lastJoinedRoom', roomValue);

        const param = new URLSearchParams(window.location.search);
        param.set("room", roomValue);
        const newURL = `${window.location.pathname}?${param.toString()}`;
        window.history.replaceState({}, '', newURL);

        showView("chat");
        renderRecord(roomValue, nameValue);
        joinRoom(roomValue, nameValue);
        setLobbyError(null);
    });
});
