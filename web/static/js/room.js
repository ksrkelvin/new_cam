const maxParticipants = 10;
const roomCode = document.body.dataset.roomCode;
const isOwner = document.body.dataset.isOwner === "true";
const stage = document.querySelector("#stage");
const localVideo = document.querySelector("#local-video");
const localState = document.querySelector("#local-state");
const localMicStatus = document.querySelector("#local-mic-status");
const participantCount = document.querySelector("#participant-count");
const toggleCamera = document.querySelector("#toggle-camera");
const toggleMic = document.querySelector("#toggle-mic");
const shareRoom = document.querySelector("#share-room");
const leaveRoom = document.querySelector("#leave-room");
const toggleOwnerPanel = document.querySelector("#toggle-owner-panel");
const ownerPanel = document.querySelector("#owner-panel");
const pendingBadge = document.querySelector("#pending-badge");
const participantList = document.querySelector("#participant-list");
const pendingList = document.querySelector("#pending-list");
const lobby = document.querySelector("#lobby");
const lobbyVideo = document.querySelector("#lobby-video");
const lobbyStatus = document.querySelector("#lobby-status");
const guestName = document.querySelector("#guest-name");
const requestEntry = document.querySelector("#request-entry");
const lobbyToggleCamera = document.querySelector("#lobby-toggle-camera");
const lobbyToggleMic = document.querySelector("#lobby-toggle-mic");
const guestTokenKey = `wecam_guest_${roomCode}`;
const guestNameKey = `wecam_guest_name_${roomCode}`;
const guestToken = isOwner ? "" : getOrCreateGuestToken();

const socketProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const socketURL = new URL(`${socketProtocol}://${window.location.host}/ws/rooms/${roomCode}`);
if (guestToken) socketURL.searchParams.set("guest_token", guestToken);
const socket = new WebSocket(socketURL);

const peerConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const peers = new Map();
const knownPeers = new Set();
const peerNames = new Map();
const peerVolumes = new Map();
let audioContext;
let localStream;
let selfID = "";
let micEnabled = true;
let approved = isOwner;

if (!isOwner) {
  lobby.hidden = false;
  guestName.value = localStorage.getItem(guestNameKey) || "";
  stage.classList.add("is-waiting");
}

socket.addEventListener("message", async (event) => {
  const message = JSON.parse(event.data);

  if (message.type === "room-full") {
    showRoomFull();
    return;
  }

  if (message.type === "waiting") {
    selfID = message.from;
    lobbyStatus.textContent = "Confira seus dispositivos e aperte entrar.";
    await ensureMedia();
    return;
  }

  if (message.type === "ready" || message.type === "approved") {
    selfID = message.from;
    approved = true;
    lobby.hidden = true;
    stage.classList.remove("is-waiting");
    if (isOwner) ownerPanel.setAttribute("aria-hidden", "true");
    knownPeers.clear();
    for (const peerID of message.peers || []) knownPeers.add(peerID);
    rememberPeerNames(message.data?.peers || []);
    renderParticipants();
    await ensureMedia();
    localVideo.srcObject = localStream;
    localState.textContent = localDisplayName();
    updateMicStatus(localMicStatus, micEnabled);
    send("participant-info", "", { name: localDisplayName() });
    send("media-state", "", { micEnabled });
    for (const peerID of knownPeers) await createPeer(peerID, true);
    updateGrid();
    return;
  }

  if (message.type === "pending-list" && isOwner) {
    renderPending(message.data?.pending || []);
    return;
  }

  if (message.type === "kicked" || message.type === "rejected") {
    alert(message.type === "kicked" ? "Voce foi removido da sala." : "Sua entrada nao foi autorizada.");
    leaveCurrentRoom();
    window.location.href = "/";
    return;
  }

  if (message.type === "owner-replaced") {
    ownerPanel.hidden = true;
    return;
  }

  if (!approved || !message.from || message.from === selfID) return;

  if (message.type === "peer-joined") {
    knownPeers.add(message.from);
    rememberPeerName(message.from, message.data?.name);
    updateGrid();
    renderParticipants();
    await ensureMedia();
    await createPeer(message.from, false);
    send("media-state", message.from, { micEnabled });
    return;
  }

  if (message.type === "peer-left") {
    knownPeers.delete(message.from);
    removePeer(message.from);
    renderParticipants();
    return;
  }

  if (message.type === "media-state") {
    const remoteEntry = peers.get(message.from);
    if (remoteEntry) updateMicStatus(remoteEntry.tile.micStatus, Boolean(message.data?.micEnabled));
    return;
  }

  if (message.type === "peer-info") {
    rememberPeerName(message.from, message.data?.name);
    updatePeerLabel(message.from);
    renderParticipants();
    return;
  }

  if (message.type === "offer") {
    knownPeers.add(message.from);
    const entry = await createPeer(message.from, false);
    if (!entry) return;
    await entry.connection.setRemoteDescription(message.data);
    await entry.connection.setLocalDescription();
    send("answer", message.from, entry.connection.localDescription);
    return;
  }

  const entry = peers.get(message.from);
  if (!entry) return;

  if (message.type === "answer") await entry.connection.setRemoteDescription(message.data);
  if (message.type === "candidate") await entry.connection.addIceCandidate(message.data);
});

async function ensureMedia() {
  if (localStream) return;
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  micEnabled = localStream.getAudioTracks()[0]?.enabled ?? false;
  localVideo.srcObject = localStream;
  lobbyVideo.srcObject = localStream;
}

async function createPeer(peerID, shouldOffer) {
  if (peers.has(peerID)) return peers.get(peerID);
  if (!knownPeers.has(peerID)) return null;

  const tile = createTile(peerID);
  const connection = new RTCPeerConnection(peerConfig);
  const entry = { connection, tile, audio: null };
  peers.set(peerID, entry);
  setPeerVolume(peerID, peerVolumes.get(peerID) ?? 100);

  localStream.getTracks().forEach((track) => connection.addTrack(track, localStream));

  connection.ontrack = (event) => {
    const [stream] = event.streams;
    tile.video.srcObject = stream;
    tile.video.muted = true;
    updatePeerLabel(peerID);
    entry.audio ||= createAudioController(stream);
    setPeerVolume(peerID, peerVolumes.get(peerID) ?? 100);
  };

  connection.onicecandidate = (event) => {
    if (event.candidate) send("candidate", peerID, event.candidate);
  };

  connection.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(connection.connectionState)) removePeer(peerID);
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

  const volumeControl = document.createElement("label");
  volumeControl.className = "volume-control";
  volumeControl.setAttribute("aria-label", "Volume deste participante");
  volumeControl.innerHTML = `${volumeIconSVG()}<input type="range" min="0" max="200" value="${peerVolumes.get(peerID) ?? 100}"><output class="volume-value">100%</output>`;
  const volumeSlider = volumeControl.querySelector("input");
  const volumeValue = volumeControl.querySelector("output");
  volumeSlider.addEventListener("input", () => setPeerVolume(peerID, Number(volumeSlider.value)));

  const micStatus = document.createElement("span");
  micStatus.className = "mic-icon is-on";
  micStatus.setAttribute("aria-label", "Microfone ligado");

  const name = document.createElement("span");
  name.textContent = "Conectando";

  const actions = document.createElement("div");
  actions.className = "peer-actions";
  if (isOwner) {
    const kick = document.createElement("button");
    kick.type = "button";
    kick.className = "danger-button";
    kick.textContent = "Expulsar";
    kick.addEventListener("click", () => send("kick", peerID));
    actions.append(kick);
  }

  label.append(micStatus, name);
  frame.append(video, label, volumeControl, actions);
  stage.append(frame);
  return { frame, video, name, micStatus, volumeControl, volumeSlider, volumeValue };
}

function renderPending(pending) {
  pendingList.innerHTML = "";
  updatePendingBadge(pending.length);
  if (pending.length === 0) {
    pendingList.innerHTML = '<p class="empty-pending">Nenhum convidado aguardando.</p>';
    return;
  }
  for (const guest of pending) {
    const row = document.createElement("div");
    row.className = "pending-item";
    const name = document.createElement("strong");
    name.textContent = guest.name || `Convidado ${shortID(guest.id)}`;
    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = "Permitir";
    approve.addEventListener("click", () => send("approve", guest.id));
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "danger-button";
    reject.textContent = "Recusar";
    reject.addEventListener("click", () => send("kick", guest.id));
    row.append(name, approve, reject);
    pendingList.append(row);
  }
}

function updatePendingBadge(count) {
  if (!pendingBadge) return;
  pendingBadge.hidden = count === 0;
  pendingBadge.textContent = String(count);
}

function renderParticipants() {
  if (!isOwner || !participantList) return;

  participantList.innerHTML = "";
  const participantIDs = Array.from(knownPeers);
  if (participantIDs.length === 0) {
    participantList.innerHTML = '<p class="empty-pending">Nenhum convidado na sala.</p>';
    return;
  }

  for (const peerID of participantIDs) {
    const row = document.createElement("div");
    row.className = "participant-item";

    const name = document.createElement("strong");
    name.textContent = peerNames.get(peerID) || `Convidado ${shortID(peerID)}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.textContent = "Remover";
    remove.addEventListener("click", () => send("kick", peerID));

    row.append(name, remove);
    participantList.append(row);
  }
}

function setPeerVolume(peerID, value) {
  const entry = peers.get(peerID);
  if (!entry) return;
  const clampedValue = Math.max(0, Math.min(200, value));
  peerVolumes.set(peerID, clampedValue);
  entry.tile.video.muted = true;
  entry.tile.video.volume = 0;
  entry.audio?.setGain(clampedValue / 100);
  entry.tile.volumeSlider.value = String(clampedValue);
  entry.tile.volumeValue.value = String(clampedValue);
  entry.tile.volumeValue.textContent = `${clampedValue}%`;
  entry.tile.volumeControl.classList.toggle("is-muted", clampedValue === 0);
}

function createAudioController(stream) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    audioContext ||= new AudioContextClass();
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return null;
    const source = audioContext.createMediaStreamSource(new MediaStream(audioTracks));
    const gainNode = audioContext.createGain();
    source.connect(gainNode).connect(audioContext.destination);
    return {
      setGain(value) {
        if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
        gainNode.gain.value = value;
      },
      close() {
        source.disconnect();
        gainNode.disconnect();
      },
    };
  } catch {
    return null;
  }
}

function removePeer(peerID) {
  const entry = peers.get(peerID);
  if (!entry) {
    updateGrid();
    return;
  }
  entry.audio?.close();
  entry.connection.close();
  entry.tile.frame.remove();
  peers.delete(peerID);
  updateGrid();
  renderParticipants();
}

function send(type, to = "", data) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type, to, data }));
}

function updateGrid() {
  const total = knownPeers.size + (approved ? 1 : 0);
  stage.dataset.count = String(Math.max(total, 1));
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
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z"></path><path d="M19 11a7 7 0 0 1-14 0"></path><path d="M12 18v3"></path><path d="M8 21h8"></path></svg>';
}

function micOffIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"></path><path d="M9 9v2a3 3 0 0 0 5.12 2.12"></path><path d="M15 9.34V6a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 11"></path><path d="M19 11a6.97 6.97 0 0 1-1.2 3.92"></path><path d="M12 18v3"></path><path d="M8 21h8"></path></svg>';
}

function volumeIconSVG() {
  return '<span class="volume-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 5.5a9 9 0 0 1 0 13"></path></svg></span>';
}

function setCameraEnabled(enabled) {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = enabled;
  toggleCamera.textContent = enabled ? "Desligar camera" : "Ligar camera";
  lobbyToggleCamera.textContent = toggleCamera.textContent;
}

function setMicEnabled(enabled) {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = enabled;
  micEnabled = enabled;
  updateMicStatus(localMicStatus, micEnabled);
  send("media-state", "", { micEnabled });
  toggleMic.textContent = enabled ? "Desligar microfone" : "Ligar microfone";
  lobbyToggleMic.textContent = toggleMic.textContent;
  toggleMic.classList.toggle("danger-button", !enabled);
  lobbyToggleMic.classList.toggle("danger-button", !enabled);
}

toggleCamera.addEventListener("click", () => setCameraEnabled(!(localStream?.getVideoTracks()[0]?.enabled ?? false)));
toggleMic.addEventListener("click", () => setMicEnabled(!(localStream?.getAudioTracks()[0]?.enabled ?? false)));
lobbyToggleCamera.addEventListener("click", () => setCameraEnabled(!(localStream?.getVideoTracks()[0]?.enabled ?? false)));
lobbyToggleMic.addEventListener("click", () => setMicEnabled(!(localStream?.getAudioTracks()[0]?.enabled ?? false)));

requestEntry.addEventListener("click", async () => {
  await ensureMedia();
  const name = guestName.value.trim() || "Convidado";
  localStorage.setItem(guestNameKey, name);
  send("lobby-info", "", { name });
  requestEntry.disabled = true;
  lobbyStatus.textContent = "Aguardando autorizacao do criador da sala.";
});

shareRoom.addEventListener("click", async () => {
  const url = window.location.href;
  if (navigator.share) {
    await navigator.share({ title: "Sala We Cam", url }).catch(() => {});
    return;
  }
  await navigator.clipboard.writeText(url);
  shareRoom.textContent = "Link copiado";
  setTimeout(() => {
    shareRoom.textContent = "Compartilhar sala";
  }, 1400);
});

leaveRoom.addEventListener("click", () => {
  leaveCurrentRoom();
  window.location.href = "/";
});

toggleOwnerPanel?.addEventListener("click", () => {
  const isOpen = ownerPanel.classList.toggle("is-open");
  ownerPanel.setAttribute("aria-hidden", String(!isOpen));
  toggleOwnerPanel.setAttribute("aria-expanded", String(isOpen));
});

window.addEventListener("beforeunload", leaveCurrentRoom);

function leaveCurrentRoom() {
  for (const peerID of Array.from(peers.keys())) removePeer(peerID);
  for (const track of localStream?.getTracks() || []) track.stop();
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(1000, "leaving room");
  }
}

ensureMedia().catch(() => {
  localState.textContent = "Permita o acesso a camera";
  lobbyStatus.textContent = "Permita camera e microfone para continuar.";
});

function getOrCreateGuestToken() {
  const existingToken = localStorage.getItem(guestTokenKey);
  if (existingToken) return existingToken;

  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(guestTokenKey, token);
  return token;
}

function localDisplayName() {
  if (isOwner) return "Criador";
  return localStorage.getItem(guestNameKey) || guestName.value.trim() || "Voce";
}

function rememberPeerNames(peerList) {
  for (const peer of peerList) {
    rememberPeerName(peer.id, peer.name);
  }
}

function rememberPeerName(peerID, name) {
  if (!peerID || !name) return;
  peerNames.set(peerID, name);
}

function updatePeerLabel(peerID) {
  const entry = peers.get(peerID);
  if (!entry) return;
  entry.tile.name.textContent = peerNames.get(peerID) || `Convidado ${shortID(peerID)}`;
}
