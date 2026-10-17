document.addEventListener('DOMContentLoaded', () => {
    const nameInputElement = document.getElementById('userName');
    const roomIdInputElement = document.getElementById('roomId');
    const lobbyForm = document.getElementById('lobbyForm');

    const savedName = localStorage.getItem('name');
    const lastRoom = localStorage.getItem('lastJoinedRoom');

    if (savedName) nameInputElement.value = savedName;
    if (lastRoom) roomIdInputElement.placeholder = `Last room: ${lastRoom}`;

    const roomFromUrl = new URLSearchParams(location.search).get("room");

    if (roomFromUrl) {
        if (savedName && savedName.trim() !== "") {
            showView("chat");
            joinRoom(roomFromUrl);
        } else {
            showView("lobby");
            if (roomIdInputElement) roomIdInputElement.value = roomFromUrl;
            if (nameInputElement) nameInputElement.focus();
        }
    } else {
        showView("lobby");
    }

    lobbyForm.addEventListener('submit', (event) => {
        event.preventDefault();

        let nameValue = nameInputElement.value.trim();
        let roomValue = roomIdInputElement.value.trim();

        if (nameValue === "") {
            alert("Please write a name");
            return;
        }
        if (roomValue === "") {
            alert("Please enter a Room ID");
            return;
        }

        const checkValidRoom = /^[a-zA-Z0-9-]{1,32}$/.test(roomValue);
        if(!checkValidRoom){
            roomIdInputElement.value = "";
            roomIdInputElement.focus();
            alert(`invalid room id`);
            return;
        }

        localStorage.setItem('name', nameValue);
        localStorage.setItem('lastJoinedRoom', roomValue);

        const param = new URLSearchParams(window.location.search);
        param.set("room", roomValue);
        const newURL = `${window.location.pathname}?${param.toString()}`;
        window.history.replaceState({}, '', newURL);

        showView("chat");
        joinRoom(roomValue);
    });
});
