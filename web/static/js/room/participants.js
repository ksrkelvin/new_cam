import { volumeIcon } from "./icons.js";
import { shortID } from "./identity.js";

export function createParticipants({ dom, isOwner, maxParticipants, knownPeers, peerNames, peerVolumes, send, setPeerVolume }) {
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
    volumeControl.innerHTML = `${volumeIcon()}<input type="range" min="0" max="200" value="${peerVolumes.get(peerID) ?? 100}"><output class="volume-value">100%</output>`;
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
    dom.stage.append(frame);
    return { frame, video, name, micStatus, volumeControl, volumeSlider, volumeValue };
  }

  function renderPending(pending) {
    dom.pendingList.innerHTML = "";
    updatePendingBadge(pending.length);
    if (pending.length === 0) {
      dom.pendingList.innerHTML = '<p class="empty-pending">Nenhum convidado aguardando.</p>';
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
      dom.pendingList.append(row);
    }
  }

  function renderParticipants() {
    if (!isOwner || !dom.participantList) return;
    dom.participantList.innerHTML = "";
    const participantIDs = Array.from(knownPeers);
    if (participantIDs.length === 0) {
      dom.participantList.innerHTML = '<p class="empty-pending">Nenhum convidado na sala.</p>';
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
      dom.participantList.append(row);
    }
  }

  function updatePendingBadge(count) {
    if (!dom.pendingBadge) return;
    dom.pendingBadge.hidden = count === 0;
    dom.pendingBadge.textContent = String(count);
  }

  function updateGrid(approved) {
    const total = knownPeers.size + (approved ? 1 : 0);
    dom.stage.dataset.count = String(Math.max(total, 1));
    dom.participantCount.textContent = `${total}/${maxParticipants}`;
  }

  function showRoomFull() {
    dom.stage.innerHTML = '<div class="empty-state">Sala cheia. O limite atual e de 10 pessoas.</div>';
    dom.participantCount.textContent = `${maxParticipants}/${maxParticipants}`;
  }

  function rememberPeerNames(peerList) {
    for (const peer of peerList) rememberPeerName(peer.id, peer.name);
  }

  function rememberPeerName(peerID, name) {
    if (!peerID || !name) return;
    peerNames.set(peerID, name);
  }

  function updatePeerLabel(peerID, entry) {
    if (!entry) return;
    entry.tile.name.textContent = peerNames.get(peerID) || `Convidado ${shortID(peerID)}`;
  }

  return {
    createTile,
    renderPending,
    renderParticipants,
    updateGrid,
    showRoomFull,
    rememberPeerNames,
    rememberPeerName,
    updatePeerLabel,
  };
}

