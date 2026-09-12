const maxParticipants = 10;
const roomCode = document.body.dataset.roomCode;
const stage = document.querySelector("#stage");
const localVideo = document.querySelector("#local-video");
const localState = document.querySelector("#local-state");
const localMicStatus = document.querySelector("#local-mic-status");
const participantCount = document.querySelector("#participant-count");
const toggleCamera = document.querySelector("#toggle-camera");
const toggleMic = document.querySelector("#toggle-mic");
const copyCode = document.querySelector("#copy-code");
const leaveRoom = document.querySelector("#leave-room");

const socketProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const socket = new WebSocket(`${socketProtocol}://${window.location.host}/ws/rooms/${roomCode}`);

const peerConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const peers = new Map();
const knownPeers = new Set();
let localStream;
let selfID = "";
let micEnabled = true;

async function start() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  localVideo.srcObject = localStream;
  micEnabled = localStream.getAudioTracks()[0]?.enabled ?? false;
  localState.textContent = "Voce";
  updateMicStatus(localMicStatus, micEnabled);
  send("media-state", "", { micEnabled });
  updateGrid();
}

socket.addEventListener("message", async (event) => {
  const message = JSON.parse(event.data);

  if (message.type === "room-full") {
    showRoomFull();
    return;
  }

  if (message.type === "ready") {
    selfID = message.from;
    knownPeers.clear();
    for (const peerID of message.peers || []) {
      knownPeers.add(peerID);
    }
    updateGrid();
    await ensureMedia();
    send("media-state", "", { micEnabled });
    for (const peerID of knownPeers) {
      await createPeer(peerID, true);
    }
    updateGrid();
    return;
  }

  if (!message.from || message.from === selfID) return;

  if (message.type === "peer-joined") {
    knownPeers.add(message.from);
    updateGrid();
    await ensureMedia();
    if (knownPeers.has(message.from)) {
      await createPeer(message.from, false);
    }
    send("media-state", message.from, { micEnabled });
    updateGrid();
    return;
  }

  if (message.type === "peer-left") {
    knownPeers.delete(message.from);
    removePeer(message.from);
    return;
  }

  if (message.type === "media-state") {
    const remoteEntry = peers.get(message.from);
    if (remoteEntry) {
      updateMicStatus(remoteEntry.tile.micStatus, Boolean(message.data?.micEnabled));
    }
    return;
  }

  if (message.type === "offer") {
    knownPeers.add(message.from);
    updateGrid();
    const entry = await createPeer(message.from, false);
    if (!entry) return;
    await entry.connection.setRemoteDescription(message.data);
    await entry.connection.setLocalDescription();
    send("answer", message.from, entry.connection.localDescription);
    return;
  }

  const entry = peers.get(message.from);
  if (!entry) return;

  if (message.type === "answer") {
    await entry.connection.setRemoteDescription(message.data);
  }

  if (message.type === "candidate") {
    await entry.connection.addIceCandidate(message.data);
  }
});

async function ensureMedia() {
  if (!localStream) {
    await start();
  }
}

async function createPeer(peerID, shouldOffer) {
  if (peers.has(peerID)) return peers.get(peerID);
  if (!knownPeers.has(peerID)) return null;

  const tile = createTile(peerID);
  const connection = new RTCPeerConnection(peerConfig);
  const entry = { connection, tile };
  peers.set(peerID, entry);

  localStream.getTracks().forEach((track) => connection.addTrack(track, localStream));

  connection.ontrack = (event) => {
    tile.video.srcObject = event.streams[0];
    tile.name.textContent = `Camera ${shortID(peerID)}`;
  };

  connection.onicecandidate = (event) => {
    if (event.candidate) {
      send("candidate", peerID, event.candidate);
    }
  };

  connection.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(connection.connectionState)) {
      removePeer(peerID);
    }
  };

  if (shouldOffer) {
    await connection.setLocalDescription(await connection.createOffer());
    send("offer", peerID, connection.localDescription);
  }

  updateGrid();
  return entry;
}

function createTile(peerID) {
  const frame = document.createElement("div");
  frame.className = "video-frame";
  frame.dataset.peerId = peerID;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;

  const label = document.createElement("span");
  label.className = "camera-label";

  const micStatus = document.createElement("span");
  micStatus.className = "mic-icon is-on";
  micStatus.setAttribute("aria-label", "Microfone ligado");

  const name = document.createElement("span");
  name.textContent = "Conectando";

  label.append(micStatus, name);
  frame.append(video, label);
  stage.append(frame);
  return { frame, video, name, micStatus };
}

function removePeer(peerID) {
  const entry = peers.get(peerID);
  if (!entry) {
    updateGrid();
    return;
  }
  entry.connection.close();
  entry.tile.frame.remove();
  peers.delete(peerID);
  updateGrid();
}

function send(type, to, data) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type, to, data }));
}

function updateGrid() {
  const total = knownPeers.size + 1;
  stage.dataset.count = String(total);
  participantCount.textContent = `${total}/${maxParticipants}`;
}

function showRoomFull() {
  stage.innerHTML = '<div class="empty-state">Sala cheia. O limite atual e de 10 pessoas.</div>';
  participantCount.textContent = `${maxParticipants}/${maxParticipants}`;
}

function shortID(peerID) {
  return peerID.slice(0, 4).toUpperCase();
}

function updateMicStatus(element, enabled) {
  const label = element.closest(".camera-label");
  element.classList.toggle("is-on", enabled);
  element.classList.toggle("is-off", !enabled);
  label?.classList.toggle("is-muted", !enabled);
  element.innerHTML = enabled ? micOnIcon() : micOffIcon();
  element.setAttribute("aria-label", enabled ? "Microfone ligado" : "Microfone desligado");
}

function micOnIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z"></path>
      <path d="M19 11a7 7 0 0 1-14 0"></path>
      <path d="M12 18v3"></path>
      <path d="M8 21h8"></path>
    </svg>
  `;
}

function micOffIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m2 2 20 20"></path>
      <path d="M9 9v2a3 3 0 0 0 5.12 2.12"></path>
      <path d="M15 9.34V6a3 3 0 0 0-5.94-.6"></path>
      <path d="M17 16.95A7 7 0 0 1 5 11"></path>
      <path d="M19 11a6.97 6.97 0 0 1-1.2 3.92"></path>
      <path d="M12 18v3"></path>
      <path d="M8 21h8"></path>
    </svg>
  `;
}

toggleCamera.addEventListener("click", () => {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  toggleCamera.textContent = track.enabled ? "Desligar camera" : "Ligar camera";
});

toggleMic.addEventListener("click", () => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  micEnabled = track.enabled;
  updateMicStatus(localMicStatus, micEnabled);
  send("media-state", "", { micEnabled });
  toggleMic.textContent = track.enabled ? "Desligar microfone" : "Ligar microfone";
  toggleMic.classList.toggle("danger-button", !track.enabled);
});

copyCode.addEventListener("click", async () => {
  await navigator.clipboard.writeText(roomCode);
  copyCode.textContent = "Copiado";
  setTimeout(() => {
    copyCode.textContent = "Copiar codigo";
  }, 1400);
});

leaveRoom.addEventListener("click", () => {
  leaveCurrentRoom();
  window.location.href = "/";
});

window.addEventListener("beforeunload", () => {
  leaveCurrentRoom();
});

function leaveCurrentRoom() {
  for (const peerID of Array.from(peers.keys())) {
    removePeer(peerID);
  }

  for (const track of localStream?.getTracks() || []) {
    track.stop();
  }

  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(1000, "leaving room");
  }
}

start().catch(() => {
  localState.textContent = "Permita o acesso a camera";
});
