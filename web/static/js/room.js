import { createDice } from "./room/dice.js";
import { dom } from "./room/dom.js?v=20260915-52";
import { getOrCreateClientLogID, getOrCreateGuestToken, guestNameKey } from "./room/identity.js";
import { createInitiative } from "./room/initiative.js?v=20260915-52";
import { connectionInfo, createLogger } from "./room/logger.js";
import { createLocalMedia, updateMicStatus } from "./room/media.js?v=20260915-48";
import { createMusic } from "./room/music.js";
import { createParticipants } from "./room/participants.js";
import { createPeerManager } from "./room/peers.js?v=20260915-48";

const maxParticipants = 10;
const appVersion = "20260915-53";
const roomCode = document.body.dataset.roomCode;
const isOwner = document.body.dataset.isOwner === "true";
const guestToken = isOwner ? "" : getOrCreateGuestToken(roomCode);
const guestStorageKey = guestNameKey(roomCode);
const clientLogID = getOrCreateClientLogID();
const logClientEvent = createLogger({ roomCode, clientLogID });

const socketProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const socketURL = new URL(`${socketProtocol}://${window.location.host}/ws/rooms/${roomCode}`);
if (guestToken) socketURL.searchParams.set("guest_token", guestToken);
const socket = new WebSocket(socketURL);

const peerConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  iceCandidatePoolSize: 4,
};

const knownPeers = new Set();
const peerNames = new Map();
const peerVolumes = new Map();
let selfID = "";
let approved = isOwner;
let peerManager;
let hasLeftRoom = false;

function send(type, to = "", data) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type, to, data }));
}

const localMedia = createLocalMedia({
  dom,
  logClientEvent,
  sendMediaState: (micEnabled) => send("media-state", "", { micEnabled }),
  replaceLocalTrack: (kind, track) => peerManager?.replaceLocalTrack(kind, track),
});

const participants = createParticipants({
  dom,
  isOwner,
  maxParticipants,
  knownPeers,
  peerNames,
  peerVolumes,
  send,
  setPeerVolume: (peerID, value) => peerManager?.setPeerVolume(peerID, value),
});

peerManager = createPeerManager({
  peerConfig,
  knownPeers,
  peerVolumes,
  createTile: participants.createTile,
  updateGrid: () => participants.updateGrid(approved),
  updatePeerLabel: participants.updatePeerLabel,
  renderParticipants: participants.renderParticipants,
  getLocalStream: localMedia.getLocalStream,
  send,
  logClientEvent,
});

const dice = createDice({ dom, send });
const initiative = createInitiative({
  dom,
  isOwner,
  send,
  getParticipantNames: () => {
    const names = Array.from(peerNames.values()).filter(Boolean);
    return isOwner ? ["Criador", ...names] : names;
  },
});
const music = createMusic({ dom, isOwner, send, logClientEvent });
music.installYouTubeCallback();

logClientEvent("info", "room-script-loaded", { version: appVersion, isOwner, roomCode, connection: connectionInfo() });
logClientEvent("info", "ice-config", { iceServers: peerConfig.iceServers.map((server) => ({ urls: server.urls })) });

if (!isOwner) {
  dom.lobby.hidden = false;
  dom.guestName.value = localStorage.getItem(guestStorageKey) || "";
  dom.stage.classList.add("is-waiting");
}

socket.addEventListener("message", async (event) => {
  try {
    const message = JSON.parse(event.data);
    logClientEvent("debug", "websocket-message", { type: message.type, from: message.from, to: message.to });
    await handleSignalMessage(message);
  } catch (error) {
    logClientEvent("error", "signal-handler-error", { name: error.name, message: error.message });
    localMedia.showMediaProblem(error);
  }
});

socket.addEventListener("open", () => {
  logClientEvent("info", "websocket-open", { url: socketURL.pathname, connection: connectionInfo() });
});

socket.addEventListener("close", (event) => {
  logClientEvent("warn", "websocket-close", {
    code: event.code,
    reason: event.reason,
    wasClean: event.wasClean,
    connection: connectionInfo(),
  });
});

socket.addEventListener("error", () => {
  logClientEvent("error", "websocket-error", { readyState: socket.readyState, connection: connectionInfo() });
});

async function handleSignalMessage(message) {
  if (message.type === "room-full") {
    participants.showRoomFull();
    return;
  }
  if (message.type === "waiting") {
    selfID = message.from;
    dom.lobbyStatus.textContent = "Confira seus dispositivos e aperte entrar.";
    await localMedia.ensureMedia();
    return;
  }
  if (message.type === "ready" || message.type === "approved") {
    selfID = message.from;
    approved = true;
    dom.lobby.hidden = true;
    dom.stage.classList.remove("is-waiting");
    if (isOwner && dom.ownerPanel) {
      if (dom.ownerPanel.contains(document.activeElement)) document.activeElement.blur();
      dom.ownerPanel.setAttribute("aria-hidden", "true");
    }
    knownPeers.clear();
    for (const peerID of message.peers || []) knownPeers.add(peerID);
    participants.rememberPeerNames(message.data?.peers || []);
    participants.renderParticipants();
    await localMedia.ensureMedia();
    dom.localVideo.srcObject = localMedia.getLocalStream();
    dom.localState.textContent = localDisplayName();
    updateMicStatus(dom.localMicStatus, localMedia.isMicEnabled());
    send("participant-info", "", { name: localDisplayName() });
    send("media-state", "", { micEnabled: localMedia.isMicEnabled() });
    music.applyMusicState(message.data?.music);
    initiative.applyInitiativeState(message.data?.initiative);
    for (const peerID of knownPeers) await peerManager.createPeer(peerID, true);
    participants.updateGrid(approved);
    return;
  }
  if (message.type === "music-state") {
    music.applyMusicState(message.data);
    return;
  }
  if (message.type === "dice-result") {
    dice.renderDiceResult(message.data);
    return;
  }
  if (message.type === "dice-error") {
    dice.renderDiceError(message.data?.message || "Rolagem invalida.");
    return;
  }
  if (message.type === "initiative-state") {
    initiative.applyInitiativeState(message.data);
    return;
  }
  if (message.type === "pending-list" && isOwner) {
    participants.renderPending(message.data?.pending || []);
    return;
  }
  if (message.type === "kicked" || message.type === "rejected") {
    alert(message.type === "kicked" ? "Voce foi removido da sala." : "Sua entrada nao foi autorizada.");
    leaveCurrentRoom();
    window.location.href = "/";
    return;
  }
  if (message.type === "owner-replaced") {
    if (dom.ownerPanel) dom.ownerPanel.hidden = true;
    return;
  }
  if (!approved || !message.from || message.from === selfID) return;
  if (message.type === "peer-joined") {
    knownPeers.add(message.from);
    participants.rememberPeerName(message.from, message.data?.name);
    participants.updateGrid(approved);
    participants.renderParticipants();
    await localMedia.ensureMedia();
    await peerManager.createPeer(message.from, false);
    send("media-state", message.from, { micEnabled: localMedia.isMicEnabled() });
    return;
  }
  if (message.type === "peer-left") {
    knownPeers.delete(message.from);
    peerManager.removePeer(message.from);
    participants.renderParticipants();
    return;
  }
  if (message.type === "media-state") {
    peerManager.updateRemoteMic(message.from, Boolean(message.data?.micEnabled));
    return;
  }
  if (message.type === "peer-info") {
    participants.rememberPeerName(message.from, message.data?.name);
    peerManager.updatePeerLabel(message.from);
    participants.renderParticipants();
    return;
  }
  if (message.type === "offer") {
    knownPeers.add(message.from);
    await localMedia.ensureMedia();
    await peerManager.handleOffer(message);
    return;
  }
  if (message.type === "candidate") {
    await peerManager.handleCandidate(message);
    return;
  }
  if (message.type === "answer") await peerManager.handleAnswer(message);
}

function selectTool(toolName) {
  for (const tab of dom.toolTabs) {
    const selected = tab.dataset.toolTab === toolName;
    tab.classList.toggle("is-active", selected);
    tab.setAttribute("aria-selected", selected ? "true" : "false");
  }
  for (const panel of dom.toolPanels) panel.hidden = panel.dataset.toolPanel !== toolName;
}

function bindEvents() {
  for (const tab of dom.toolTabs) tab.addEventListener("click", () => selectTool(tab.dataset.toolTab));
  dice.bindEvents();
  initiative.bindEvents();
  music.bindEvents();
  dom.toggleCamera.addEventListener("click", () => localMedia.setCameraEnabled(!(localMedia.getLocalStream()?.getVideoTracks()[0]?.enabled ?? false)));
  dom.toggleMic.addEventListener("click", () => localMedia.setMicEnabled(!(localMedia.getLocalStream()?.getAudioTracks()[0]?.enabled ?? false)));
  dom.lobbyToggleCamera.addEventListener("click", () => localMedia.setCameraEnabled(!(localMedia.getLocalStream()?.getVideoTracks()[0]?.enabled ?? false)));
  dom.lobbyToggleMic.addEventListener("click", () => localMedia.setMicEnabled(!(localMedia.getLocalStream()?.getAudioTracks()[0]?.enabled ?? false)));
  for (const select of deviceSelects("video")) select.addEventListener("change", () => localMedia.selectDevice("video", select.value));
  for (const select of deviceSelects("audio")) select.addEventListener("change", () => localMedia.selectDevice("audio", select.value));
  for (const button of deviceRefreshButtons()) button.addEventListener("click", refreshDevices);
  dom.requestEntry.addEventListener("click", requestEntry);
  dom.shareRoom.addEventListener("click", shareCurrentRoom);
  dom.leaveRoom.addEventListener("click", goHome);
  dom.lobbyLeaveRoom?.addEventListener("click", goHome);
  window.addEventListener("beforeunload", leaveCurrentRoom);
  window.addEventListener("pagehide", leaveCurrentRoom);
  window.addEventListener("focus", refreshDevices);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshDevices();
  });
}

function deviceSelects(kind) {
  const domSelects = kind === "video" ? dom.cameraSelects : dom.microphoneSelects;
  return Array.from(domSelects || document.querySelectorAll(`[data-device-select="${kind}"]`));
}

function deviceRefreshButtons() {
  return Array.from(dom.deviceRefreshButtons || document.querySelectorAll("[data-device-refresh]"));
}

function refreshDevices() {
  const refresh = localMedia.refreshDeviceOptions || localMedia.ensureMedia;
  refresh().catch((error) => {
    logClientEvent("warn", "manual-device-refresh-error", { name: error.name, message: error.message });
  });
}

async function requestEntry() {
  try {
    await localMedia.ensureMedia();
    const name = dom.guestName.value.trim() || "Convidado";
    localStorage.setItem(guestStorageKey, name);
    await waitForSocketOpen();
    send("lobby-info", "", { name });
    dom.requestEntry.disabled = true;
    dom.lobbyStatus.textContent = "Aguardando autorizacao do criador da sala.";
  } catch (error) {
    logClientEvent("error", "request-entry-media-error", { name: error.name, message: error.message });
    localMedia.showMediaProblem(error);
  }
}

function waitForSocketOpen() {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    return Promise.reject(new Error("Conexao com a sala encerrada."));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("A conexao com a sala demorou para abrir."));
    }, 6000);
    function cleanup() {
      clearTimeout(timeout);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("close", handleClose);
      socket.removeEventListener("error", handleError);
    }
    function handleOpen() {
      cleanup();
      resolve();
    }
    function handleClose() {
      cleanup();
      reject(new Error("Conexao com a sala encerrada."));
    }
    function handleError() {
      cleanup();
      reject(new Error("Nao foi possivel conectar na sala."));
    }
    socket.addEventListener("open", handleOpen);
    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", handleError);
  });
}

async function shareCurrentRoom() {
  const url = window.location.href;
  if (navigator.share) {
    await navigator.share({ title: "Sala Tavernia", url }).catch(() => {});
    return;
  }
  await navigator.clipboard.writeText(url);
  dom.shareRoom.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i>';
  setTimeout(() => {
    dom.shareRoom.innerHTML = '<i class="fa-solid fa-link" aria-hidden="true"></i>';
  }, 1400);
}

function leaveCurrentRoom() {
  if (hasLeftRoom) return;
  hasLeftRoom = true;
  logClientEvent("info", "leave-room", { readyState: socket.readyState, peers: peerManager.peerCount() });
  for (const peerID of peerManager.peerIDs()) peerManager.removePeer(peerID);
  localMedia.stop();
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000, "leaving room");
}

function goHome() {
  leaveCurrentRoom();
  window.location.assign("/");
}

function localDisplayName() {
  if (isOwner) return "Criador";
  return localStorage.getItem(guestStorageKey) || dom.guestName.value.trim() || "Voce";
}

bindEvents();
localMedia.ensureMedia().catch(() => {
  dom.localState.textContent = localDisplayName();
});
