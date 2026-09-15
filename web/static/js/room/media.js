import { micOffIcon, micOnIcon } from "./icons.js";

export function createLocalMedia({ dom, logClientEvent, sendMediaState }) {
  let localStream;
  let localMediaPromise;
  let micEnabled = true;

  async function ensureMedia() {
    if (localStream) return localStream;
    if (localMediaPromise) return localMediaPromise;
    localMediaPromise = openLocalMedia().finally(() => {
      localMediaPromise = null;
    });
    return localMediaPromise;
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
    await logPermissionState(logClientEvent);
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
    dom.localVideo.srcObject = localStream;
    dom.lobbyVideo.srcObject = localStream;
    logClientEvent("info", "media-ready", {
      audioTracks: localStream.getAudioTracks().length,
      videoTracks: localStream.getVideoTracks().length,
      audioSettings: localStream.getAudioTracks()[0]?.getSettings?.() || {},
      videoSettings: localStream.getVideoTracks()[0]?.getSettings?.() || {},
    });
    return localStream;
  }

  function setCameraEnabled(enabled) {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = enabled;
    dom.toggleCamera.innerHTML = enabled ? '<i class="fa-solid fa-video" aria-hidden="true"></i>' : '<i class="fa-solid fa-video-slash" aria-hidden="true"></i>';
    dom.toggleCamera.setAttribute("aria-label", enabled ? "Desligar camera" : "Ligar camera");
    dom.toggleCamera.classList.toggle("is-off", !enabled);
    dom.lobbyToggleCamera.textContent = enabled ? "Desligar camera" : "Ligar camera";
  }

  function setMicEnabled(enabled) {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = enabled;
    micEnabled = enabled;
    updateMicStatus(dom.localMicStatus, micEnabled);
    sendMediaState(micEnabled);
    dom.toggleMic.innerHTML = enabled ? micOnIcon() : micOffIcon();
    dom.toggleMic.setAttribute("aria-label", enabled ? "Desligar microfone" : "Ligar microfone");
    dom.lobbyToggleMic.textContent = enabled ? "Desligar microfone" : "Ligar microfone";
    dom.toggleMic.classList.toggle("danger-button", !enabled);
    dom.lobbyToggleMic.classList.toggle("danger-button", !enabled);
  }

  function stop() {
    for (const track of localStream?.getTracks() || []) track.stop();
  }

  function showMediaProblem(error) {
    const message = mediaProblemMessage(error);
    dom.localState.textContent = message;
    if (dom.lobbyStatus) dom.lobbyStatus.textContent = message;
  }

  return {
    ensureMedia,
    getLocalStream: () => localStream,
    isMicEnabled: () => micEnabled,
    setCameraEnabled,
    setMicEnabled,
    showMediaProblem,
    stop,
  };
}

export function updateMicStatus(element, enabled) {
  const label = element.closest(".camera-label");
  element.classList.toggle("is-on", enabled);
  element.classList.toggle("is-off", !enabled);
  label?.classList.toggle("is-muted", !enabled);
  element.innerHTML = enabled ? micOnIcon() : micOffIcon();
  element.setAttribute("aria-label", enabled ? "Microfone ligado" : "Microfone desligado");
}

async function logPermissionState(logClientEvent) {
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

function mediaProblemMessage(error) {
  if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") return "Permissao de camera ou microfone bloqueada neste navegador.";
  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") return "Camera ou microfone nao encontrado no celular.";
  if (error.name === "NotReadableError" || error.name === "TrackStartError") return "Camera ou microfone esta ocupado por outro app.";
  if (error.name === "OverconstrainedError" || error.name === "ConstraintNotSatisfiedError") return "O celular nao aceitou a configuracao de camera.";
  if (error.name === "InsecureContext" || error.name === "MediaDevicesUnavailable") return "Abra a sala em HTTPS para liberar camera e microfone.";
  return "Nao foi possivel acessar camera e microfone.";
}

