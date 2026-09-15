import { describeSDP } from "./logger.js";
import { updateMicStatus } from "./media.js";

const mediaTypes = ["audio", "video"];

export function createPeerManager({ peerConfig, knownPeers, peerVolumes, createTile, updateGrid, updatePeerLabel, renderParticipants, getLocalStream, send, logClientEvent }) {
  const peers = new Map();
  const pendingCandidatesByPeer = new Map();
  let audioContext;

  async function createPeer(peerID, shouldOffer) {
    if (peers.has(peerID)) return peers.get(peerID);
    if (!knownPeers.has(peerID)) return null;

    const localStream = getLocalStream();
    const queuedCandidates = pendingCandidatesByPeer.get(peerID) || emptyCandidateBuckets();
    const entry = {
      connections: {},
      tile: createTile(peerID),
      audio: null,
      remoteStream: new MediaStream(),
      pendingCandidates: queuedCandidates,
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
      queuedAudioCandidates: entry.pendingCandidates.audio.length,
      queuedVideoCandidates: entry.pendingCandidates.video.length,
    });
    setPeerVolume(peerID, peerVolumes.get(peerID) ?? 100);

    for (const mediaType of mediaTypes) {
      entry.connections[mediaType] = createMediaConnection(peerID, entry, mediaType);
    }

    if (shouldOffer) {
      for (const mediaType of mediaTypes) {
        const connection = entry.connections[mediaType];
        await connection.setLocalDescription(await connection.createOffer());
        logClientEvent("info", "signal-offer-sent", {
          to: peerID,
          mediaType,
          signalingState: connection.signalingState,
          sdpTypes: describeSDP(connection.localDescription?.sdp || ""),
        });
        send("offer", peerID, mediaSignal(mediaType, connection.localDescription));
      }
    }

    startPeerWatchdog(peerID);
    updateGrid();
    return entry;
  }

  function createMediaConnection(peerID, entry, mediaType) {
    const connection = new RTCPeerConnection(peerConfig);
    const localStream = getLocalStream();
    const tracks = mediaType === "audio" ? localStream.getAudioTracks() : localStream.getVideoTracks();
    tracks.forEach((track) => connection.addTrack(track, new MediaStream([track])));

    connection.ontrack = (event) => {
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
        logCandidate("local", peerID, mediaType, event.candidate.candidate || "");
        send("candidate", peerID, mediaSignal(mediaType, event.candidate));
      }
    };

    connection.onconnectionstatechange = () => {
      logClientEvent("info", "peer-connection-state", {
        peerID,
        mediaType,
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
      if (connection.connectionState === "closed") removePeer(peerID);
    };

    connection.oniceconnectionstatechange = () => {
      logClientEvent("info", "peer-ice-state", {
        peerID,
        mediaType,
        iceConnectionState: connection.iceConnectionState,
        connectionState: connection.connectionState,
      });
    };

    connection.onicegatheringstatechange = () => {
      logClientEvent("debug", "peer-ice-gathering-state", { peerID, mediaType, iceGatheringState: connection.iceGatheringState });
    };

    return connection;
  }

  async function handleOffer(message) {
    const entry = await createPeer(message.from, false);
    if (!entry) return;
    const mediaType = signalMediaType(message);
    const mediaConnection = entry.connections[mediaType];
    logClientEvent("info", "signal-offer-received", {
      from: message.from,
      mediaType,
      signalingState: mediaConnection.signalingState,
      sdpTypes: describeSDP(message.data?.sdp || ""),
    });
    if (mediaConnection.signalingState !== "stable") {
      logClientEvent("warn", "offer-ignored-not-stable", { from: message.from, mediaType, signalingState: mediaConnection.signalingState });
      return;
    }
    await mediaConnection.setRemoteDescription(message.data);
    await flushPendingCandidates(entry, message.from, mediaType);
    await mediaConnection.setLocalDescription();
    logClientEvent("info", "signal-answer-sent", {
      to: message.from,
      mediaType,
      signalingState: mediaConnection.signalingState,
      sdpTypes: describeSDP(mediaConnection.localDescription?.sdp || ""),
    });
    send("answer", message.from, mediaSignal(mediaType, mediaConnection.localDescription));
  }

  async function handleAnswer(message) {
    const entry = peers.get(message.from);
    if (!entry) return;
    const mediaType = signalMediaType(message);
    const mediaConnection = entry.connections[mediaType];
    logClientEvent("info", "signal-answer-received", {
      from: message.from,
      mediaType,
      signalingState: mediaConnection.signalingState,
      sdpTypes: describeSDP(message.data?.sdp || ""),
    });
    if (mediaConnection.signalingState !== "have-local-offer") {
      logClientEvent("warn", "stale-answer-ignored", {
        from: message.from,
        mediaType,
        signalingState: mediaConnection.signalingState,
        connectionState: mediaConnection.connectionState,
        iceConnectionState: mediaConnection.iceConnectionState,
      });
      return;
    }
    await mediaConnection.setRemoteDescription(message.data);
    await flushPendingCandidates(entry, message.from, mediaType);
  }

  async function handleCandidate(message) {
    const mediaType = signalMediaType(message);
    logCandidate("remote", message.from, mediaType, message.data?.candidate || "");
    const entry = peers.get(message.from);
    if (!entry) {
      queueCandidate(message.from, mediaType, message.data);
      logClientEvent("debug", "ice-candidate-queued-without-peer", {
        from: message.from,
        mediaType,
        queued: pendingCandidatesByPeer.get(message.from)?.[mediaType]?.length || 0,
      });
      return;
    }
    const mediaConnection = entry.connections[mediaType];
    if (!mediaConnection.remoteDescription) {
      entry.pendingCandidates[mediaType].push(message.data);
      logClientEvent("debug", "ice-candidate-queued", { from: message.from, mediaType, queued: entry.pendingCandidates[mediaType].length });
      return;
    }
    await addIceCandidate(entry, message.from, mediaType, message.data);
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
    entry.tile.frame.remove();
    peers.delete(peerID);
    for (const connection of Object.values(entry.connections || {})) connection.close();
    updateGrid();
    renderParticipants();
  }

  function updateRemoteMic(peerID, enabled) {
    const entry = peers.get(peerID);
    if (entry) updateMicStatus(entry.tile.micStatus, enabled);
  }

  function refreshPeerLabel(peerID) {
    updatePeerLabel(peerID, peers.get(peerID));
  }

  async function flushPendingCandidates(entry, peerID, mediaType) {
    const candidates = entry.pendingCandidates[mediaType].splice(0);
    for (const candidate of candidates) await addIceCandidate(entry, peerID, mediaType, candidate);
    if (candidates.length > 0) logClientEvent("debug", "ice-candidates-flushed", { peerID, mediaType, count: candidates.length });
  }

  function queueCandidate(peerID, mediaType, candidate) {
    const candidates = pendingCandidatesByPeer.get(peerID) || emptyCandidateBuckets();
    candidates[mediaType].push(candidate);
    pendingCandidatesByPeer.set(peerID, candidates);
  }

  async function addIceCandidate(entry, peerID, mediaType, candidate) {
    try {
      await entry.connections[mediaType].addIceCandidate(candidate);
    } catch (error) {
      logClientEvent("warn", "ice-candidate-error", {
        peerID,
        mediaType,
        name: error.name,
        message: error.message,
        connectionState: entry.connections[mediaType].connectionState,
        iceConnectionState: entry.connections[mediaType].iceConnectionState,
        signalingState: entry.connections[mediaType].signalingState,
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
        for (const [mediaType, connection] of Object.entries(currentEntry.connections)) {
          logClientEvent("warn", "peer-connect-watchdog", {
            peerID,
            mediaType,
            delay,
            connectionState: connection.connectionState,
            iceConnectionState: connection.iceConnectionState,
            iceGatheringState: connection.iceGatheringState,
            signalingState: connection.signalingState,
          });
        }
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
    const summary = { peerID, audio: peerStatsSummary(), video: peerStatsSummary() };
    for (const mediaType of mediaTypes) {
      const reports = await entry.connections[mediaType].getStats();
      const mediaSummary = summary[mediaType];
      for (const report of reports.values()) {
        if (report.type === "candidate-pair" && (report.selected || report.nominated)) {
          mediaSummary.selectedPairState = report.state || "";
          const localCandidate = reports.get(report.localCandidateId);
          const remoteCandidate = reports.get(report.remoteCandidateId);
          mediaSummary.localCandidateType = localCandidate?.candidateType || "";
          mediaSummary.remoteCandidateType = remoteCandidate?.candidateType || "";
        }
        if (report.type === "inbound-rtp") mediaSummary.inboundPackets += report.packetsReceived || 0;
        if (report.type === "outbound-rtp") mediaSummary.outboundPackets += report.packetsSent || 0;
      }
    }
    logClientEvent("info", "peer-stats", summary);
  }

  function logCandidate(direction, peerID, mediaType, candidate) {
    const candidateType = candidate.match(/ typ ([a-z]+)/)?.[1] || "";
    const protocol = candidate.match(/ (udp|tcp) /i)?.[1] || "";
    logClientEvent("debug", "ice-candidate", { direction, peerID, mediaType, candidateType, protocol });
  }

  return {
    createPeer,
    handleOffer,
    handleAnswer,
    handleCandidate,
    removePeer,
    setPeerVolume,
    updateRemoteMic,
    updatePeerLabel: refreshPeerLabel,
    peerCount: () => peers.size,
    peerIDs: () => Array.from(peers.keys()),
  };
}

function emptyCandidateBuckets() {
  return { audio: [], video: [] };
}

function signalMediaType(message) {
  return mediaTypes.includes(message.data?.mediaType) ? message.data.mediaType : "video";
}

function mediaSignal(mediaType, descriptionOrCandidate) {
  const payload = descriptionOrCandidate?.toJSON?.() || {
    type: descriptionOrCandidate?.type,
    sdp: descriptionOrCandidate?.sdp,
    candidate: descriptionOrCandidate?.candidate,
    sdpMid: descriptionOrCandidate?.sdpMid,
    sdpMLineIndex: descriptionOrCandidate?.sdpMLineIndex,
    usernameFragment: descriptionOrCandidate?.usernameFragment,
  };
  return { ...payload, mediaType };
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
