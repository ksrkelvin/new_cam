import { updateMicStatus } from "./media.js";

export function createPeerManager({ peerConfig, knownPeers, peerVolumes, createTile, updateGrid, updatePeerLabel, renderParticipants, getLocalStream, send, logClientEvent }) {
  const peers = new Map();
  const pendingCandidatesByPeer = new Map();
  let audioContext;

  async function createPeer(peerID, shouldOffer) {
    if (peers.has(peerID)) return peers.get(peerID);
    if (!knownPeers.has(peerID)) return null;

    const localStream = getLocalStream();
    const queuedCandidates = pendingCandidatesByPeer.get(peerID) || [];
    const entry = {
      connection: null,
      tile: createTile(peerID),
      audio: null,
      remoteStream: new MediaStream(),
      pendingCandidates: queuedCandidates,
      makingOffer: false,
      restartingIce: false,
      restartTimer: null,
      watchdogTimers: [],
    };
    pendingCandidatesByPeer.delete(peerID);
    entry.connection = createMediaConnection(peerID, entry);
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

    if (shouldOffer) {
      await makeOffer(peerID, entry);
    }

    startPeerWatchdog(peerID);
    updateGrid();
    return entry;
  }

  function createMediaConnection(peerID, entry) {
    const connection = new RTCPeerConnection(peerConfig);
    const localStream = getLocalStream();
    addLocalMedia(connection, localStream);

    connection.ontrack = (event) => {
      const mediaType = event.track.kind;
      logClientEvent("info", "remote-track", {
        peerID,
        mediaType,
        kind: event.track.kind,
        muted: event.track.muted,
        readyState: event.track.readyState,
      });
      event.track.addEventListener("unmute", () => logClientEvent("info", "remote-track-unmute", { peerID, mediaType, kind: event.track.kind }));
      event.track.addEventListener("mute", () => logClientEvent("warn", "remote-track-mute", { peerID, mediaType, kind: event.track.kind }));
      event.track.addEventListener("ended", () => logClientEvent("warn", "remote-track-ended", { peerID, mediaType, kind: event.track.kind }));
      entry.remoteStream.getTracks().filter((track) => track.kind === event.track.kind).forEach((track) => entry.remoteStream.removeTrack(track));
      entry.remoteStream.addTrack(event.track);
      entry.tile.video.srcObject = entry.remoteStream;
      entry.tile.video.muted = true;
      entry.tile.frame.classList.toggle("is-audio-only", entry.remoteStream.getVideoTracks().length === 0);
      entry.tile.video.play().catch((error) => {
        logClientEvent("warn", "remote-video-play-error", { peerID, mediaType, name: error.name, message: error.message });
      });
      updatePeerLabel(peerID, entry);
      if (mediaType === "audio") {
        entry.audio?.close();
        entry.audio = createAudioController(entry.remoteStream);
      }
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
      if (connection.connectionState === "failed" || connection.connectionState === "disconnected") scheduleIceRestart(peerID);
      if (connection.connectionState === "closed") removePeer(peerID);
    };

    connection.oniceconnectionstatechange = () => {
      logClientEvent("info", "peer-ice-state", {
        peerID,
        iceConnectionState: connection.iceConnectionState,
        connectionState: connection.connectionState,
      });
      if (connection.iceConnectionState === "failed" || connection.iceConnectionState === "disconnected") scheduleIceRestart(peerID);
    };

    connection.onicegatheringstatechange = () => {
      logClientEvent("debug", "peer-ice-gathering-state", { peerID, iceGatheringState: connection.iceGatheringState });
    };

    return connection;
  }

  function addLocalMedia(connection, localStream) {
    const audioTracks = localStream.getAudioTracks();
    const videoTracks = localStream.getVideoTracks();
    if (audioTracks.length === 0) connection.addTransceiver("audio", { direction: "recvonly" });
    else audioTracks.forEach((track) => configureSender(connection.addTrack(track, new MediaStream([track]))));
    if (videoTracks.length === 0) connection.addTransceiver("video", { direction: "recvonly" });
    else videoTracks.forEach((track) => configureSender(connection.addTrack(track, new MediaStream([track]))));
  }

  function configureSender(sender) {
    if (sender.track?.kind === "video") {
      sender.track.contentHint = "motion";
      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings[0].maxBitrate = 450000;
      sender.setParameters(parameters).catch((error) => {
        logClientEvent("debug", "sender-parameters-error", { kind: sender.track?.kind, name: error.name, message: error.message });
      });
    }
  }

  async function makeOffer(peerID, entry, options = {}) {
    if (entry.makingOffer) return;
    entry.makingOffer = true;
    try {
      await entry.connection.setLocalDescription(await entry.connection.createOffer(options));
      logClientEvent("info", "signal-offer-sent", {
        to: peerID,
        restartIce: Boolean(options.iceRestart),
        signalingState: entry.connection.signalingState,
      });
      send("offer", peerID, entry.connection.localDescription);
    } finally {
      entry.makingOffer = false;
    }
  }

  async function handleOffer(message) {
    const entry = await createPeer(message.from, false);
    if (!entry) return;
    const mediaConnection = entry.connection;
    logClientEvent("info", "signal-offer-received", {
      from: message.from,
      signalingState: mediaConnection.signalingState,
    });
    if (mediaConnection.signalingState !== "stable") {
      await mediaConnection.setLocalDescription({ type: "rollback" });
      await mediaConnection.setRemoteDescription(message.data);
    } else {
      await mediaConnection.setRemoteDescription(message.data);
    }
    await flushPendingCandidates(entry, message.from);
    await mediaConnection.setLocalDescription();
    logClientEvent("info", "signal-answer-sent", {
      to: message.from,
      signalingState: mediaConnection.signalingState,
    });
    send("answer", message.from, mediaConnection.localDescription);
  }

  async function handleAnswer(message) {
    const entry = peers.get(message.from);
    if (!entry) return;
    const mediaConnection = entry.connection;
    logClientEvent("info", "signal-answer-received", {
      from: message.from,
      signalingState: mediaConnection.signalingState,
    });
    if (mediaConnection.signalingState !== "have-local-offer") {
      logClientEvent("warn", "stale-answer-ignored", {
        from: message.from,
        signalingState: mediaConnection.signalingState,
        connectionState: mediaConnection.connectionState,
        iceConnectionState: mediaConnection.iceConnectionState,
      });
      return;
    }
    await mediaConnection.setRemoteDescription(message.data);
    await flushPendingCandidates(entry, message.from);
  }

  async function handleCandidate(message) {
    logCandidate("remote", message.from, message.data?.candidate || "");
    const entry = peers.get(message.from);
    if (!entry) {
      queueCandidate(message.from, message.data);
      logClientEvent("debug", "ice-candidate-queued-without-peer", {
        from: message.from,
        queued: pendingCandidatesByPeer.get(message.from)?.length || 0,
      });
      return;
    }
    const mediaConnection = entry.connection;
    if (!mediaConnection.remoteDescription) {
      entry.pendingCandidates.push(message.data);
      logClientEvent("debug", "ice-candidate-queued", { from: message.from, queued: entry.pendingCandidates.length });
      return;
    }
    await addIceCandidate(entry, message.from, message.data);
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
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    entry.tile.frame.remove();
    peers.delete(peerID);
    entry.connection?.close();
    updateGrid();
    renderParticipants();
  }

  function updateRemoteMic(peerID, enabled) {
    const entry = peers.get(peerID);
    if (entry) updateMicStatus(entry.tile.micStatus, enabled);
  }

  async function replaceLocalTrack(kind, track) {
    for (const [peerID, entry] of peers) {
      const sender = entry.connection.getSenders().find((item) => item.track?.kind === kind);
      if (!sender) continue;
      await sender.replaceTrack(track);
      configureSender(sender);
      logClientEvent("info", "peer-local-track-replaced", { peerID, kind });
      scheduleIceRestart(peerID);
    }
  }

  function refreshPeerLabel(peerID) {
    updatePeerLabel(peerID, peers.get(peerID));
  }

  async function flushPendingCandidates(entry, peerID) {
    const candidates = entry.pendingCandidates.splice(0);
    for (const candidate of candidates) await addIceCandidate(entry, peerID, candidate);
    if (candidates.length > 0) logClientEvent("debug", "ice-candidates-flushed", { peerID, count: candidates.length });
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

  function startPeerWatchdog(peerID) {
    const entry = peers.get(peerID);
    if (!entry) return;
    for (const delay of [8000, 15000]) {
      const timer = setTimeout(() => {
        const currentEntry = peers.get(peerID);
        if (!currentEntry) return;
        const connection = currentEntry.connection;
        logClientEvent("warn", "peer-connect-watchdog", {
          peerID,
          delay,
          connectionState: connection.connectionState,
          iceConnectionState: connection.iceConnectionState,
          iceGatheringState: connection.iceGatheringState,
          signalingState: connection.signalingState,
        });
        logPeerStats(peerID).catch((error) => {
          logClientEvent("warn", "peer-stats-error", { peerID, name: error.name, message: error.message });
        });
      }, delay);
      entry.watchdogTimers.push(timer);
    }
  }

  async function logPeerStats(peerID) {
    const entry = peers.get(peerID);
    if (!entry) return;
    const reports = await entry.connection.getStats();
    const summary = { peerID, audio: peerStatsSummary(), video: peerStatsSummary() };
    for (const report of reports.values()) {
      if (report.type === "candidate-pair" && (report.selected || report.nominated)) {
        summary.selectedPairState = report.state || "";
        const localCandidate = reports.get(report.localCandidateId);
        const remoteCandidate = reports.get(report.remoteCandidateId);
        summary.localCandidateType = localCandidate?.candidateType || "";
        summary.remoteCandidateType = remoteCandidate?.candidateType || "";
      }
      if (report.type === "inbound-rtp" || report.type === "outbound-rtp") {
        const mediaSummary = report.kind === "audio" ? summary.audio : summary.video;
        if (report.type === "inbound-rtp") mediaSummary.inboundPackets += report.packetsReceived || 0;
        if (report.type === "outbound-rtp") mediaSummary.outboundPackets += report.packetsSent || 0;
      }
    }
    logClientEvent("info", "peer-stats", summary);
  }

  function scheduleIceRestart(peerID) {
    const entry = peers.get(peerID);
    if (!entry || entry.restartTimer || entry.restartingIce) return;
    entry.restartTimer = setTimeout(async () => {
      entry.restartTimer = null;
      const currentEntry = peers.get(peerID);
      if (!currentEntry || currentEntry.connection.signalingState !== "stable") return;
      currentEntry.restartingIce = true;
      try {
        logClientEvent("warn", "peer-ice-restart", { peerID });
        await makeOffer(peerID, currentEntry, { iceRestart: true });
      } catch (error) {
        logClientEvent("warn", "peer-ice-restart-error", { peerID, name: error.name, message: error.message });
      } finally {
        currentEntry.restartingIce = false;
      }
    }, 1200);
  }

  function logCandidate(direction, peerID, candidate) {
    const candidateType = candidate.match(/ typ ([a-z]+)/)?.[1] || "";
    const protocol = candidate.match(/ (udp|tcp) /i)?.[1] || "";
    logClientEvent("debug", "ice-candidate", { direction, peerID, candidateType, protocol });
  }

  return {
    createPeer,
    handleOffer,
    handleAnswer,
    handleCandidate,
    removePeer,
    replaceLocalTrack,
    setPeerVolume,
    updateRemoteMic,
    updatePeerLabel: refreshPeerLabel,
    peerCount: () => peers.size,
    peerIDs: () => Array.from(peers.keys()),
  };
}

function peerStatsSummary() {
  return {
    localCandidateType: "",
    remoteCandidateType: "",
    selectedPairState: "",
    inboundPackets: 0,
    outboundPackets: 0,
  };
}
