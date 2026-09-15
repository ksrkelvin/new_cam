const maxParticipants = 10;
const appVersion = "20260915-14";
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
const ownerPanel = document.querySelector("#owner-panel");
const musicForm = document.querySelector("#music-form");
const musicURLInput = document.querySelector("#music-url");
const musicPlayPause = document.querySelector("#music-play-pause");
const musicSeek = document.querySelector("#music-seek");
const musicTitle = document.querySelector("#music-title");
const musicTime = document.querySelector("#music-time");
const musicProgressBar = document.querySelector("#music-progress-bar");
const musicStatus = document.querySelector("#music-status");
const musicEnable = document.querySelector("#music-enable");
const musicMute = document.querySelector("#music-mute");
const musicLoop = document.querySelector("#music-loop");
const musicVolumeBars = document.querySelector("#music-volume-bars");
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
const clientLogID = getOrCreateClientLogID();

const socketProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const socketURL = new URL(`${socketProtocol}://${window.location.host}/ws/rooms/${roomCode}`);
if (guestToken) socketURL.searchParams.set("guest_token", guestToken);
const socket = new WebSocket(socketURL);
logClientEvent("info", "room-script-loaded", { version: appVersion, isOwner, roomCode, connection: connectionInfo() });

const peerConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  iceCandidatePoolSize: 4,
};
logClientEvent("info", "ice-config", {
  iceServers: peerConfig.iceServers.map((server) => ({
    urls: server.urls,
  })),
});

const peers = new Map();
const knownPeers = new Set();
const peerNames = new Map();
const peerVolumes = new Map();
const pendingCandidatesByPeer = new Map();
let audioContext;
let localStream;
let localMediaPromise;
let selfID = "";
let micEnabled = true;
let approved = isOwner;
let youtubePlayer;
let youtubePlayerReady = false;
let pendingMusicState = null;
let musicState = { videoId: "", playing: false, position: 0, updatedAt: 0, revision: 0 };
let musicUserActivated = isOwner;
let musicMuted = false;
let musicVolumeValue = 60;
let musicLoopEnabled = false;
let musicDuration = 0;
let musicSeekPending = false;
let musicDriftTimer;

window.onYouTubeIframeAPIReady = () => {
  try {
    youtubePlayer = new YT.Player("youtube-player", {
      height: "1",
      width: "1",
      playerVars: {
        playsinline: 1,
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
      },
      events: {
        onReady: handleYouTubeReady,
        onStateChange: handleYouTubeStateChange,
        onError: handleYouTubeError,
      },
    });
  } catch (error) {
    updateMusicStatus("Player indisponivel");
    logClientEvent("warn", "youtube-player-create-error", { name: error.name, message: error.message });
  }
};

if (!isOwner) {
  lobby.hidden = false;
  guestName.value = localStorage.getItem(guestNameKey) || "";
  stage.classList.add("is-waiting");
}

socket.addEventListener("message", async (event) => {
  try {
    const message = JSON.parse(event.data);
    logClientEvent("debug", "websocket-message", { type: message.type, from: message.from, to: message.to });
    await handleSignalMessage(message);
  } catch (error) {
    logClientEvent("error", "signal-handler-error", { name: error.name, message: error.message });
    showMediaProblem(error);
  }
});

async function handleSignalMessage(message) {
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
    applyMusicState(message.data?.music);
    for (const peerID of knownPeers) await createPeer(peerID, true);
    updateGrid();
    return;
  }

  if (message.type === "music-state") {
    applyMusicState(message.data);
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
    if (ownerPanel) ownerPanel.hidden = true;
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
    await ensureMedia();
    const entry = await createPeer(message.from, false);
    if (!entry) return;
    logClientEvent("info", "signal-offer-received", {
      from: message.from,
      signalingState: entry.connection.signalingState,
      sdpTypes: describeSDP(message.data?.sdp || ""),
    });
    if (entry.connection.signalingState !== "stable") {
      logClientEvent("warn", "offer-ignored-not-stable", {
        from: message.from,
        signalingState: entry.connection.signalingState,
      });
      return;
    }
    await entry.connection.setRemoteDescription(message.data);
    await flushPendingCandidates(entry, message.from);
    await entry.connection.setLocalDescription();
    logClientEvent("info", "signal-answer-sent", {
      to: message.from,
      signalingState: entry.connection.signalingState,
      sdpTypes: describeSDP(entry.connection.localDescription?.sdp || ""),
    });
    send("answer", message.from, entry.connection.localDescription);
    return;
  }

  if (message.type === "candidate") {
    logCandidate("remote", message.from, message.data?.candidate || "");
    const candidateEntry = peers.get(message.from);
    if (!candidateEntry) {
      queueCandidate(message.from, message.data);
      logClientEvent("debug", "ice-candidate-queued-without-peer", {
        from: message.from,
        queued: pendingCandidatesByPeer.get(message.from)?.length || 0,
      });
      return;
    }
    if (!candidateEntry.connection.remoteDescription) {
      candidateEntry.pendingCandidates.push(message.data);
      logClientEvent("debug", "ice-candidate-queued", {
        from: message.from,
        queued: candidateEntry.pendingCandidates.length,
      });
      return;
    }
    await addIceCandidate(candidateEntry, message.from, message.data);
    return;
  }

  const entry = peers.get(message.from);
  if (!entry) return;

  if (message.type === "answer") {
    logClientEvent("info", "signal-answer-received", {
      from: message.from,
      signalingState: entry.connection.signalingState,
      sdpTypes: describeSDP(message.data?.sdp || ""),
    });
    if (entry.connection.signalingState !== "have-local-offer") {
      logClientEvent("warn", "stale-answer-ignored", {
        from: message.from,
        signalingState: entry.connection.signalingState,
        connectionState: entry.connection.connectionState,
        iceConnectionState: entry.connection.iceConnectionState,
      });
      return;
    }
    await entry.connection.setRemoteDescription(message.data);
    await flushPendingCandidates(entry, message.from);
  }
}

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

async function ensureMedia() {
  if (localStream) return;
  if (localMediaPromise) {
    await localMediaPromise;
    return;
  }
  localMediaPromise = openLocalMedia();
  try {
    await localMediaPromise;
  } finally {
    localMediaPromise = null;
  }
}

async function openLocalMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    const error = new Error("getUserMedia indisponivel");
    error.name = "MediaDevicesUnavailable";
    throw error;
  }
  if (!window.isSecureContext) {
    const error = new Error("camera e microfone exigem HTTPS ou localhost");
    error.name = "InsecureContext";
    throw error;
  }
  await logPermissionState();
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: {
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    logClientEvent("error", "media-error", { name: error.name, message: error.message });
    showMediaProblem(error);
    throw error;
  }
  micEnabled = localStream.getAudioTracks()[0]?.enabled ?? false;
  localVideo.srcObject = localStream;
  lobbyVideo.srcObject = localStream;
  logClientEvent("info", "media-ready", {
    audioTracks: localStream.getAudioTracks().length,
    videoTracks: localStream.getVideoTracks().length,
    audioSettings: localStream.getAudioTracks()[0]?.getSettings?.() || {},
    videoSettings: localStream.getVideoTracks()[0]?.getSettings?.() || {},
  });
}

async function createPeer(peerID, shouldOffer) {
  if (peers.has(peerID)) return peers.get(peerID);
  if (!knownPeers.has(peerID)) return null;

  const tile = createTile(peerID);
  const connection = new RTCPeerConnection(peerConfig);
  const entry = {
    connection,
    tile,
    audio: null,
    pendingCandidates: pendingCandidatesByPeer.get(peerID) || [],
    watchdogTimers: [],
  };
  pendingCandidatesByPeer.delete(peerID);
  peers.set(peerID, entry);
  logClientEvent("info", "peer-created", {
    peerID,
    shouldOffer,
    localTracks: localStream.getTracks().map((track) => ({
      kind: track.kind,
      enabled: track.enabled,
      muted: track.muted,
      readyState: track.readyState,
    })),
    queuedCandidates: entry.pendingCandidates.length,
  });
  setPeerVolume(peerID, peerVolumes.get(peerID) ?? 100);

  localStream.getTracks().forEach((track) => connection.addTrack(track, localStream));

  connection.ontrack = (event) => {
    const [stream] = event.streams;
    logClientEvent("info", "remote-track", {
      peerID,
      kind: event.track.kind,
      muted: event.track.muted,
      readyState: event.track.readyState,
      streamTracks: stream?.getTracks().map((track) => ({ kind: track.kind, muted: track.muted, readyState: track.readyState })) || [],
    });
    event.track.addEventListener("unmute", () => logClientEvent("info", "remote-track-unmute", { peerID, kind: event.track.kind }));
    event.track.addEventListener("mute", () => logClientEvent("warn", "remote-track-mute", { peerID, kind: event.track.kind }));
    event.track.addEventListener("ended", () => logClientEvent("warn", "remote-track-ended", { peerID, kind: event.track.kind }));
    tile.video.srcObject = stream;
    tile.video.muted = true;
    tile.video.play().catch((error) => {
      logClientEvent("warn", "remote-video-play-error", { peerID, name: error.name, message: error.message });
    });
    updatePeerLabel(peerID);
    entry.audio ||= createAudioController(stream);
    setPeerVolume(peerID, peerVolumes.get(peerID) ?? 100);
  };

  connection.onicecandidate = (event) => {
    if (event.candidate) {
      logCandidate("local", peerID, event.candidate.candidate || "");
      send("candidate", peerID, event.candidate);
    }
  };

  connection.onconnectionstatechange = () => {
    logClientEvent("info", "peer-connection-state", {
      peerID,
      state: connection.connectionState,
      iceConnectionState: connection.iceConnectionState,
      iceGatheringState: connection.iceGatheringState,
      signalingState: connection.signalingState,
    });
    if (connection.connectionState === "connected") {
      logPeerStats(peerID).catch((error) => {
        logClientEvent("warn", "peer-stats-error", { peerID, name: error.name, message: error.message });
      });
    }
    if (["failed", "closed"].includes(connection.connectionState)) removePeer(peerID);
  };

  connection.oniceconnectionstatechange = () => {
    logClientEvent("info", "peer-ice-state", {
      peerID,
      iceConnectionState: connection.iceConnectionState,
      connectionState: connection.connectionState,
    });
  };

  connection.onicegatheringstatechange = () => {
    logClientEvent("debug", "peer-ice-gathering-state", {
      peerID,
      iceGatheringState: connection.iceGatheringState,
    });
  };

  if (shouldOffer) {
    await connection.setLocalDescription(await connection.createOffer());
    logClientEvent("info", "signal-offer-sent", {
      to: peerID,
      signalingState: connection.signalingState,
      sdpTypes: describeSDP(connection.localDescription?.sdp || ""),
    });
    send("offer", peerID, connection.localDescription);
  }

  startPeerWatchdog(peerID);
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
  for (const timer of entry.watchdogTimers || []) clearTimeout(timer);
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

function handleYouTubeReady() {
  youtubePlayerReady = true;
  setMusicVolume(musicVolumeValue);
  if (pendingMusicState) {
    const state = pendingMusicState;
    pendingMusicState = null;
    applyMusicState(state);
  }
  startMusicDriftCorrection();
}

function handleYouTubeStateChange(event) {
  refreshMusicDuration();
  if (musicLoopEnabled && event.data === YT.PlayerState.ENDED) {
    youtubePlayer?.seekTo?.(0, true);
    youtubePlayer?.playVideo?.();
  }
}

function handleYouTubeError(event) {
  updateMusicStatus("Video indisponivel ou sem embed");
  logClientEvent("warn", "youtube-player-error", { code: event.data, videoId: musicState.videoId });
}

function applyMusicState(nextState) {
  if (!nextState) return;
  musicState = {
    videoId: String(nextState.videoId || ""),
    playing: Boolean(nextState.playing),
    position: Number(nextState.position || 0),
    updatedAt: Number(nextState.updatedAt || 0),
    revision: Number(nextState.revision || 0),
  };
  renderMusicState();

  if (!youtubePlayerReady || !youtubePlayer) {
    pendingMusicState = musicState;
    return;
  }

  try {
    if (!musicState.videoId) {
      youtubePlayer.stopVideo();
      return;
    }

    const currentVideoID = youtubePlayer.getVideoData?.().video_id || "";
    const expected = expectedMusicPosition();
    if (currentVideoID !== musicState.videoId) {
      youtubePlayer.loadVideoById({ videoId: musicState.videoId, startSeconds: expected });
    } else if (Math.abs((youtubePlayer.getCurrentTime?.() || 0) - expected) > 1.25) {
      youtubePlayer.seekTo(expected, true);
    }

    setMusicVolume(musicVolumeValue);
    youtubePlayer.setLoop?.(musicLoopEnabled);
    if (musicState.playing) {
      youtubePlayer.playVideo();
      if (!musicUserActivated) showMusicActivation();
    } else {
      youtubePlayer.pauseVideo();
      hideMusicActivation();
    }
    refreshMusicDuration();
  } catch (error) {
    updateMusicStatus("Falha ao controlar musica");
    logClientEvent("warn", "music-apply-error", { name: error.name, message: error.message });
  }
}

function renderMusicState() {
  const hasVideo = Boolean(musicState.videoId);
  if (musicTitle) musicTitle.textContent = hasVideo ? `YouTube ${musicState.videoId}` : "Sem música";
  updateMusicStatus(hasVideo ? (musicState.playing ? "Tocando" : "Pausada") : "Parada");
  updateMusicProgress();
  if (musicPlayPause) {
    musicPlayPause.innerHTML = musicState.playing ? '<i class="fa-solid fa-pause" aria-hidden="true"></i>' : '<i class="fa-solid fa-play" aria-hidden="true"></i>';
  }
  if (musicSeek && !musicSeekPending) {
    musicSeek.value = String(Math.floor(expectedMusicPosition()));
  }
}

function updateMusicStatus(text) {
  if (musicStatus) musicStatus.textContent = text;
}

function expectedMusicPosition() {
  if (!musicState.playing || !musicState.updatedAt) return musicState.position || 0;
  return Math.max(0, (musicState.position || 0) + (Date.now() - musicState.updatedAt) / 1000);
}

function startMusicDriftCorrection() {
  if (musicDriftTimer) return;
  musicDriftTimer = setInterval(() => {
    if (!youtubePlayerReady || !youtubePlayer || !musicState.videoId) return;
    refreshMusicDuration();
    renderMusicState();
    if (!musicState.playing) return;
    try {
      const current = youtubePlayer.getCurrentTime?.() || 0;
      const expected = expectedMusicPosition();
      if (Math.abs(current - expected) > 2.5) youtubePlayer.seekTo(expected, true);
    } catch (error) {
      logClientEvent("debug", "music-drift-check-error", { name: error.name, message: error.message });
    }
  }, 3000);
}

function refreshMusicDuration() {
  if (!youtubePlayer?.getDuration) return;
  const duration = Math.floor(youtubePlayer.getDuration() || 0);
  if (duration > 0) musicDuration = duration;
  if (musicSeek) musicSeek.max = String(Math.max(musicDuration, Math.floor(expectedMusicPosition()), 0));
  updateMusicProgress();
}

function updateMusicProgress() {
  const position = Math.floor(expectedMusicPosition());
  const duration = Math.max(musicDuration, position, 0);
  if (musicTime) musicTime.textContent = `${formatMusicTime(position)} / ${formatMusicTime(duration)}`;
  if (musicProgressBar) {
    const progress = duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0;
    musicProgressBar.style.width = `${progress}%`;
  }
}

function formatMusicTime(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function showMusicActivation() {
  if (musicEnable) musicEnable.hidden = false;
}

function hideMusicActivation() {
  if (musicEnable) musicEnable.hidden = true;
}

function activateMusic() {
  musicUserActivated = true;
  hideMusicActivation();
  try {
    youtubePlayer?.unMute?.();
    setMusicVolume(musicVolumeValue);
    if (musicState.playing) youtubePlayer?.playVideo?.();
  } catch (error) {
    logClientEvent("warn", "music-activation-error", { name: error.name, message: error.message });
  }
}

function setMusicVolume(value) {
  const clampedValue = Math.max(0, Math.min(100, value));
  musicVolumeValue = clampedValue;
  updateMusicVolumeBars();
  try {
    youtubePlayer?.setVolume?.(clampedValue);
    if (musicMuted || clampedValue === 0) youtubePlayer?.mute?.();
    else youtubePlayer?.unMute?.();
  } catch {
    return;
  }
}

function setMusicMuted(muted) {
  musicMuted = muted;
  if (musicMute) {
    musicMute.innerHTML = muted ? '<i class="fa-solid fa-volume-xmark" aria-hidden="true"></i>' : '<i class="fa-solid fa-volume-high" aria-hidden="true"></i>';
    musicMute.classList.toggle("is-muted", muted);
  }
  setMusicVolume(musicVolumeValue);
}

function setMusicLoop(enabled) {
  musicLoopEnabled = enabled;
  try {
    youtubePlayer?.setLoop?.(enabled);
  } catch {
    return;
  } finally {
    if (musicLoop) {
      musicLoop.classList.toggle("is-active", enabled);
      musicLoop.setAttribute("aria-label", enabled ? "Desligar repetição" : "Ligar repetição");
    }
  }
}

function updateMusicVolumeFromPointer(event) {
  if (!musicVolumeBars) return;
  const rect = musicVolumeBars.getBoundingClientRect();
  const ratio = (event.clientX - rect.left) / rect.width;
  musicUserActivated = true;
  setMusicMuted(false);
  setMusicVolume(Math.round(Math.max(0, Math.min(1, ratio)) * 100));
}

function updateMusicVolumeBars() {
  if (!musicVolumeBars) return;
  const value = musicMuted ? 0 : musicVolumeValue;
  const activeBars = Math.ceil((value / 100) * musicVolumeBars.querySelectorAll("span").length);
  musicVolumeBars.setAttribute("aria-valuenow", String(value));
  musicVolumeBars.querySelectorAll("span").forEach((bar, index) => {
    bar.classList.toggle("is-active", index < activeBars);
  });
}

function extractYouTubeVideoID(value) {
  const rawValue = value.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(rawValue)) return rawValue;
  try {
    const url = new URL(rawValue);
    if (url.hostname === "youtu.be") return cleanYouTubeID(url.pathname.slice(1));
    if (url.hostname.endsWith("youtube.com")) {
      if (url.pathname.startsWith("/watch")) return cleanYouTubeID(url.searchParams.get("v") || "");
      if (url.pathname.startsWith("/embed/")) return cleanYouTubeID(url.pathname.split("/")[2] || "");
      if (url.pathname.startsWith("/shorts/")) return cleanYouTubeID(url.pathname.split("/")[2] || "");
    }
  } catch {
    return "";
  }
  return "";
}

function cleanYouTubeID(value) {
  const id = value.split(/[?&#/]/)[0] || "";
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
}

async function flushPendingCandidates(entry, peerID) {
  const candidates = entry.pendingCandidates.splice(0);
  for (const candidate of candidates) {
    await addIceCandidate(entry, peerID, candidate);
  }
  if (candidates.length > 0) {
    logClientEvent("debug", "ice-candidates-flushed", { peerID, count: candidates.length });
  }
}

function queueCandidate(peerID, candidate) {
  const candidates = pendingCandidatesByPeer.get(peerID) || [];
  candidates.push(candidate);
  pendingCandidatesByPeer.set(peerID, candidates);
}

async function addIceCandidate(entry, peerID, candidate) {
  try {
    await entry.connection.addIceCandidate(candidate);
  } catch (error) {
    logClientEvent("warn", "ice-candidate-error", {
      peerID,
      name: error.name,
      message: error.message,
      connectionState: entry.connection.connectionState,
      iceConnectionState: entry.connection.iceConnectionState,
      signalingState: entry.connection.signalingState,
    });
  }
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
  return '<i class="fa-solid fa-microphone" aria-hidden="true"></i>';
}

function micOffIcon() {
  return '<i class="fa-solid fa-microphone-slash" aria-hidden="true"></i>';
}

function volumeIconSVG() {
  return '<span class="volume-icon"><i class="fa-solid fa-volume-high" aria-hidden="true"></i></span>';
}

function setCameraEnabled(enabled) {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = enabled;
  toggleCamera.innerHTML = enabled ? '<i class="fa-solid fa-video" aria-hidden="true"></i>' : '<i class="fa-solid fa-video-slash" aria-hidden="true"></i>';
  toggleCamera.setAttribute("aria-label", enabled ? "Desligar camera" : "Ligar camera");
  toggleCamera.classList.toggle("is-off", !enabled);
  lobbyToggleCamera.textContent = enabled ? "Desligar camera" : "Ligar camera";
}

function setMicEnabled(enabled) {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = enabled;
  micEnabled = enabled;
  updateMicStatus(localMicStatus, micEnabled);
  send("media-state", "", { micEnabled });
  toggleMic.innerHTML = enabled ? micOnIcon() : micOffIcon();
  toggleMic.setAttribute("aria-label", enabled ? "Desligar microfone" : "Ligar microfone");
  lobbyToggleMic.textContent = enabled ? "Desligar microfone" : "Ligar microfone";
  toggleMic.classList.toggle("danger-button", !enabled);
  lobbyToggleMic.classList.toggle("danger-button", !enabled);
}

musicForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const videoId = extractYouTubeVideoID(musicURLInput?.value || "");
  if (!videoId) {
    updateMusicStatus("URL do YouTube invalida");
    return;
  }
  musicUserActivated = true;
  send("music-set", "", { videoId });
});

musicPlayPause?.addEventListener("click", () => {
  musicUserActivated = true;
  const position = youtubePlayer?.getCurrentTime?.() || expectedMusicPosition();
  send(musicState.playing ? "music-pause" : "music-play", "", { position });
});

musicSeek?.addEventListener("input", () => {
  musicSeekPending = true;
});

musicSeek?.addEventListener("change", () => {
  musicSeekPending = false;
  musicUserActivated = true;
  send("music-seek", "", { position: Number(musicSeek.value || 0) });
});

musicEnable?.addEventListener("click", activateMusic);
musicMute?.addEventListener("click", () => setMusicMuted(!musicMuted));
musicLoop?.addEventListener("click", () => setMusicLoop(!musicLoopEnabled));
musicVolumeBars?.addEventListener("pointerdown", (event) => {
  updateMusicVolumeFromPointer(event);
  musicVolumeBars.setPointerCapture(event.pointerId);
});
musicVolumeBars?.addEventListener("pointermove", (event) => {
  if (event.buttons !== 1) return;
  updateMusicVolumeFromPointer(event);
});
musicVolumeBars?.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowDown" && event.key !== "ArrowRight" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -10 : 10;
  musicUserActivated = true;
  setMusicMuted(false);
  setMusicVolume(musicVolumeValue + direction);
});
updateMusicVolumeBars();

toggleCamera.addEventListener("click", () => setCameraEnabled(!(localStream?.getVideoTracks()[0]?.enabled ?? false)));
toggleMic.addEventListener("click", () => setMicEnabled(!(localStream?.getAudioTracks()[0]?.enabled ?? false)));
lobbyToggleCamera.addEventListener("click", () => setCameraEnabled(!(localStream?.getVideoTracks()[0]?.enabled ?? false)));
lobbyToggleMic.addEventListener("click", () => setMicEnabled(!(localStream?.getAudioTracks()[0]?.enabled ?? false)));

requestEntry.addEventListener("click", async () => {
  try {
    await ensureMedia();
    const name = guestName.value.trim() || "Convidado";
    localStorage.setItem(guestNameKey, name);
    send("lobby-info", "", { name });
    requestEntry.disabled = true;
    lobbyStatus.textContent = "Aguardando autorizacao do criador da sala.";
  } catch (error) {
    logClientEvent("error", "request-entry-media-error", { name: error.name, message: error.message });
    showMediaProblem(error);
  }
});

shareRoom.addEventListener("click", async () => {
  const url = window.location.href;
  if (navigator.share) {
    await navigator.share({ title: "Sala We Cam", url }).catch(() => {});
    return;
  }
  await navigator.clipboard.writeText(url);
  shareRoom.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i>';
  setTimeout(() => {
    shareRoom.innerHTML = '<i class="fa-solid fa-link" aria-hidden="true"></i>';
  }, 1400);
});

leaveRoom.addEventListener("click", () => {
  leaveCurrentRoom();
  window.location.href = "/";
});

window.addEventListener("beforeunload", leaveCurrentRoom);

function leaveCurrentRoom() {
  logClientEvent("info", "leave-room", { readyState: socket.readyState, peers: peers.size });
  for (const peerID of Array.from(peers.keys())) removePeer(peerID);
  for (const track of localStream?.getTracks() || []) track.stop();
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(1000, "leaving room");
  }
}

ensureMedia().catch(() => {
  localState.textContent = "Permita o acesso a camera";
});

async function logPermissionState() {
  if (!navigator.permissions?.query) return;
  const states = {};
  for (const name of ["camera", "microphone"]) {
    try {
      states[name] = (await navigator.permissions.query({ name })).state;
    } catch (error) {
      states[name] = `unknown:${error.name}`;
    }
  }
  logClientEvent("info", "permission-state", states);
}

function showMediaProblem(error) {
  const message = mediaProblemMessage(error);
  localState.textContent = message;
  if (lobbyStatus) lobbyStatus.textContent = message;
}

function mediaProblemMessage(error) {
  if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
    return "Permissao de camera ou microfone bloqueada neste navegador.";
  }
  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
    return "Camera ou microfone nao encontrado no celular.";
  }
  if (error.name === "NotReadableError" || error.name === "TrackStartError") {
    return "Camera ou microfone esta ocupado por outro app.";
  }
  if (error.name === "OverconstrainedError" || error.name === "ConstraintNotSatisfiedError") {
    return "O celular nao aceitou a configuracao de camera.";
  }
  if (error.name === "InsecureContext" || error.name === "MediaDevicesUnavailable") {
    return "Abra a sala em HTTPS para liberar camera e microfone.";
  }
  return "Nao foi possivel acessar camera e microfone.";
}

function getOrCreateGuestToken() {
  const existingToken = localStorage.getItem(guestTokenKey);
  if (existingToken) return existingToken;

  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(guestTokenKey, token);
  return token;
}

function getOrCreateClientLogID() {
  const key = "wecam_client_log_id";
  const existingID = localStorage.getItem(key);
  if (existingID) return existingID;

  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(key, id);
  return id;
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

function logClientEvent(level, event, data = {}) {
  const payload = JSON.stringify({
    room: roomCode,
    clientId: clientLogID,
    level,
    event,
    userAgent: navigator.userAgent,
    data,
  });

  if (navigator.sendBeacon) {
    const blob = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon("/client-logs", blob)) return;
  }

  fetch("/client-logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}

function connectionInfo() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection) return {};
  return {
    effectiveType: connection.effectiveType,
    downlink: connection.downlink,
    rtt: connection.rtt,
    saveData: connection.saveData,
  };
}

function logCandidate(direction, peerID, candidate) {
  const candidateType = candidate.match(/ typ ([a-z]+)/)?.[1] || "";
  const protocol = candidate.match(/ (udp|tcp) /i)?.[1] || "";
  logClientEvent("debug", "ice-candidate", { direction, peerID, candidateType, protocol });
}

function startPeerWatchdog(peerID) {
  const entry = peers.get(peerID);
  if (!entry) return;

  for (const delay of [8000, 15000]) {
    const timer = setTimeout(() => {
      const currentEntry = peers.get(peerID);
      if (!currentEntry) return;
      logClientEvent("warn", "peer-connect-watchdog", {
        peerID,
        delay,
        connectionState: currentEntry.connection.connectionState,
        iceConnectionState: currentEntry.connection.iceConnectionState,
        iceGatheringState: currentEntry.connection.iceGatheringState,
        signalingState: currentEntry.connection.signalingState,
      });
      logPeerStats(peerID).catch((error) => {
        logClientEvent("warn", "peer-stats-error", { peerID, name: error.name, message: error.message });
      });
    }, delay);
    entry.watchdogTimers.push(timer);
  }
}

function describeSDP(sdp) {
  return {
    audio: /m=audio /.test(sdp),
    video: /m=video /.test(sdp),
    sendrecv: (sdp.match(/a=sendrecv/g) || []).length,
    sendonly: (sdp.match(/a=sendonly/g) || []).length,
    recvonly: (sdp.match(/a=recvonly/g) || []).length,
    inactive: (sdp.match(/a=inactive/g) || []).length,
  };
}

async function logPeerStats(peerID) {
  const entry = peers.get(peerID);
  if (!entry) return;

  const reports = await entry.connection.getStats();
  const summary = {
    peerID,
    localCandidateType: "",
    remoteCandidateType: "",
    selectedPairState: "",
    inboundVideoPackets: 0,
    inboundAudioPackets: 0,
    outboundVideoPackets: 0,
    outboundAudioPackets: 0,
  };

  for (const report of reports.values()) {
    if (report.type === "candidate-pair" && (report.selected || report.nominated)) {
      summary.selectedPairState = report.state || "";
      const localCandidate = reports.get(report.localCandidateId);
      const remoteCandidate = reports.get(report.remoteCandidateId);
      summary.localCandidateType = localCandidate?.candidateType || "";
      summary.remoteCandidateType = remoteCandidate?.candidateType || "";
    }
    if (report.type === "inbound-rtp" && report.kind === "video") summary.inboundVideoPackets += report.packetsReceived || 0;
    if (report.type === "inbound-rtp" && report.kind === "audio") summary.inboundAudioPackets += report.packetsReceived || 0;
    if (report.type === "outbound-rtp" && report.kind === "video") summary.outboundVideoPackets += report.packetsSent || 0;
    if (report.type === "outbound-rtp" && report.kind === "audio") summary.outboundAudioPackets += report.packetsSent || 0;
  }

  logClientEvent("info", "peer-stats", summary);
}
