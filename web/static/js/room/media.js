import { micOffIcon, micOnIcon } from "./icons.js";

export function createLocalMedia({ dom, logClientEvent, sendMediaState, replaceLocalTrack }) {
  let localStream;
  let localMediaPromise;
  let micEnabled = true;
  let cameraEnabled = true;
  let selectedAudioDeviceID = "";
  let selectedVideoDeviceID = "";
  let deviceChangeBound = false;
  let refreshUnlockPromise;

  async function ensureMedia() {
    bindDeviceChange();
    await refreshDeviceOptions({ unlock: false }).catch(() => {});
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
    localStream = await captureLocalTracks();
    micEnabled = localStream.getAudioTracks()[0]?.enabled ?? false;
    cameraEnabled = localStream.getVideoTracks()[0]?.enabled ?? false;
    dom.localVideo.srcObject = localStream;
    dom.lobbyVideo.srcObject = localStream;
    await refreshDeviceOptions({ unlock: false });
    logClientEvent("info", "media-ready", {
      audioTracks: localStream.getAudioTracks().length,
      videoTracks: localStream.getVideoTracks().length,
      audioSettings: localStream.getAudioTracks()[0]?.getSettings?.() || {},
      videoSettings: localStream.getVideoTracks()[0]?.getSettings?.() || {},
    });
    return localStream;
  }

  async function captureLocalTracks() {
    const stream = new MediaStream();
    const errors = [];

    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
          ...(selectedAudioDeviceID ? { deviceId: { exact: selectedAudioDeviceID } } : {}),
        },
      });
      audioStream.getAudioTracks().forEach((track) => stream.addTrack(track));
    } catch (error) {
      errors.push({ kind: "audio", error });
      logClientEvent("error", "audio-media-error", { name: error.name, message: error.message });
    }

    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640, max: 1280 },
          height: { ideal: 360, max: 720 },
          frameRate: { ideal: 20, max: 30 },
          ...(selectedVideoDeviceID ? { deviceId: { exact: selectedVideoDeviceID } } : {}),
        },
      });
      videoStream.getVideoTracks().forEach((track) => stream.addTrack(track));
    } catch (error) {
      errors.push({ kind: "video", error });
      logClientEvent("error", "video-media-error", { name: error.name, message: error.message });
    }

    if (stream.getTracks().length > 0) {
      if (errors.length > 0) showPartialMediaProblem(errors);
      return stream;
    }

    const error = errors[0]?.error || new Error("Nao foi possivel acessar camera e microfone.");
    logClientEvent("error", "media-error", { name: error.name, message: error.message });
    showMediaProblem(error);
    throw error;
  }

  function setCameraEnabled(enabled) {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = enabled;
    cameraEnabled = enabled;
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

  async function selectDevice(kind, deviceID) {
    if (!localStream) await ensureMedia();
    if (deviceID.startsWith("synthetic-device:")) deviceID = "";
    if (kind === "audio") selectedAudioDeviceID = deviceID;
    if (kind === "video") selectedVideoDeviceID = deviceID;

    try {
      const stream = await captureDeviceStream(kind);
      const nextTrack = stream.getTracks().find((track) => track.kind === kind);
      if (!nextTrack) return;
      const oldTrack = kind === "audio" ? localStream.getAudioTracks()[0] : localStream.getVideoTracks()[0];
      if (kind === "audio") nextTrack.enabled = micEnabled;
      if (kind === "video") nextTrack.enabled = cameraEnabled;
      if (oldTrack) localStream.removeTrack(oldTrack);
      localStream.addTrack(nextTrack);
      dom.localVideo.srcObject = localStream;
      dom.lobbyVideo.srcObject = localStream;
      if (kind === "audio") {
        updateMicStatus(dom.localMicStatus, micEnabled);
        sendMediaState(micEnabled);
      }
      replaceLocalTrack?.(kind, nextTrack).catch((error) => {
        logClientEvent("error", "media-replace-track-error", { kind, name: error.name, message: error.message });
      });
      oldTrack?.stop();
      await refreshDeviceOptions({ unlock: false });
      logClientEvent("info", "media-device-selected", {
        kind,
        settings: nextTrack.getSettings?.() || {},
      });
    } catch (error) {
      logClientEvent("error", "media-device-select-error", { kind, name: error.name, message: error.message });
      showMediaProblem(error);
      syncSelectedDevices();
    }
  }

  async function captureDeviceStream(kind) {
    try {
      return await navigator.mediaDevices.getUserMedia({ [kind]: mediaConstraints(kind) });
    } catch (error) {
      if (error.name !== "OverconstrainedError" && error.name !== "ConstraintNotSatisfiedError" && error.name !== "NotFoundError") throw error;
      logClientEvent("warn", "media-device-exact-fallback", { kind, name: error.name, message: error.message });
      const selectedDeviceID = kind === "audio" ? selectedAudioDeviceID : selectedVideoDeviceID;
      return navigator.mediaDevices.getUserMedia({ [kind]: mediaConstraints(kind, { exact: false, deviceID: selectedDeviceID }) });
    }
  }

  async function refreshDeviceOptions({ unlock = true } = {}) {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    if (unlock && !localStream) await unlockDeviceLabels();
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === "videoinput");
    const microphones = devices.filter((device) => device.kind === "audioinput");
    renderDeviceOptions(deviceSelects("video"), cameras, "Camera padrao", selectedVideoDeviceID || activeDeviceID("video", cameras));
    renderDeviceOptions(deviceSelects("audio"), microphones, "Microfone padrao", selectedAudioDeviceID || activeDeviceID("audio", microphones));
    syncSelectedDevices();
    logClientEvent("info", "media-devices-enumerated", {
      cameras: cameras.length,
      microphones: microphones.length,
      cameraLabels: cameras.filter((device) => Boolean(device.label)).length,
      microphoneLabels: microphones.filter((device) => Boolean(device.label)).length,
    });
  }

  function renderDeviceOptions(selects, devices, defaultLabel, preferredDeviceID) {
    for (const select of selects || []) {
      const currentValue = select.value;
      select.replaceChildren();
      const hasSpecificDevices = devices.some((device) => isSpecificDeviceID(device.deviceId));
      if (!hasSpecificDevices) select.append(new Option(defaultLabel, ""));
      devices.forEach((device, index) => {
        if (hasSpecificDevices && !isSpecificDeviceID(device.deviceId)) return;
        const value = device.deviceId || `synthetic-device:${device.kind || defaultLabel}:${device.groupId || index}`;
        select.append(new Option(device.label || deviceLabel(defaultLabel, device, index), value));
      });
      const optionValues = Array.from(select.options).map((option) => option.value);
      if (preferredDeviceID && optionValues.includes(preferredDeviceID)) select.value = preferredDeviceID;
      else if (currentValue && optionValues.includes(currentValue)) select.value = currentValue;
      else if (optionValues.length > 1) select.selectedIndex = 1;
    }
  }

  function syncSelectedDevices() {
    const audioDeviceID = selectedAudioDeviceID || selectedOptionDeviceID("audio");
    const videoDeviceID = selectedVideoDeviceID || selectedOptionDeviceID("video");
    for (const select of deviceSelects("audio")) {
      if (Array.from(select.options).some((option) => option.value === audioDeviceID)) select.value = audioDeviceID;
    }
    for (const select of deviceSelects("video")) {
      if (Array.from(select.options).some((option) => option.value === videoDeviceID)) select.value = videoDeviceID;
    }
  }

  function deviceSelects(kind) {
    const domSelects = kind === "video" ? dom.cameraSelects : dom.microphoneSelects;
    return Array.from(domSelects || document.querySelectorAll(`[data-device-select="${kind}"]`));
  }

  function activeDeviceID(kind, devices) {
    const track = kind === "audio" ? localStream?.getAudioTracks()[0] : localStream?.getVideoTracks()[0];
    const deviceID = track?.getSettings?.().deviceId;
    if (isSpecificDeviceID(deviceID)) return deviceID;
    const normalizedTrackLabel = normalizeDeviceLabel(track?.label || "");
    if (normalizedTrackLabel) {
      const matchingDevice = devices.find((device) => isSpecificDeviceID(device.deviceId) && normalizeDeviceLabel(device.label).includes(normalizedTrackLabel));
      if (matchingDevice) return matchingDevice.deviceId;
      const matchingTrack = devices.find((device) => {
        const deviceLabel = normalizeDeviceLabel(device.label);
        return isSpecificDeviceID(device.deviceId) && deviceLabel && normalizedTrackLabel.includes(deviceLabel);
      });
      if (matchingTrack) return matchingTrack.deviceId;
    }
    return devices.find((device) => device.deviceId && device.deviceId !== "default" && device.deviceId !== "communications")?.deviceId || devices.find((device) => device.deviceId)?.deviceId || "";
  }

  async function unlockDeviceLabels() {
    if (refreshUnlockPromise) return refreshUnlockPromise;
    refreshUnlockPromise = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        },
        video: {
          width: { ideal: 640, max: 1280 },
          height: { ideal: 360, max: 720 },
          frameRate: { ideal: 20, max: 30 },
        },
      });
      for (const track of stream.getTracks()) track.stop();
    })().finally(() => {
      refreshUnlockPromise = null;
    });
    return refreshUnlockPromise;
  }

  function selectedOptionDeviceID(kind) {
    const select = deviceSelects(kind)[0];
    const selectedValue = select?.value || "";
    if (isSpecificDeviceID(selectedValue)) return selectedValue;
    const firstSpecificOption = Array.from(select?.options || []).find((option) => isSpecificDeviceID(option.value));
    return firstSpecificOption?.value || selectedValue;
  }

  function isSpecificDeviceID(deviceID) {
    return Boolean(deviceID && deviceID !== "default" && deviceID !== "communications");
  }

  function normalizeDeviceLabel(label) {
    return label.toLowerCase().replace(/\s+\([^)]+\)$/g, "").trim();
  }

  function deviceLabel(defaultLabel, device, index) {
    if (device.deviceId === "default") return defaultLabel;
    if (device.deviceId === "communications") return `${defaultLabel} de comunicacao`;
    return `${defaultLabel} ${index + 1}`;
  }

  function bindDeviceChange() {
    if (deviceChangeBound || !navigator.mediaDevices?.addEventListener) return;
    deviceChangeBound = true;
    navigator.mediaDevices.addEventListener("devicechange", () => {
      refreshDeviceOptions().catch((error) => {
        logClientEvent("warn", "media-devices-refresh-error", { name: error.name, message: error.message });
      });
    });
  }

  function mediaConstraints(kind, options = {}) {
    const exact = options.exact !== false;
    const selectedDeviceID = options.deviceID ?? (kind === "audio" ? selectedAudioDeviceID : selectedVideoDeviceID);
    const deviceConstraint = selectedDeviceID ? { deviceId: exact ? { exact: selectedDeviceID } : { ideal: selectedDeviceID } } : {};
    if (kind === "audio") {
      return {
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
        ...deviceConstraint,
      };
    }
    return {
      width: { ideal: 640, max: 1280 },
      height: { ideal: 360, max: 720 },
      frameRate: { ideal: 20, max: 30 },
      ...deviceConstraint,
    };
  }

  function stop() {
    for (const track of localStream?.getTracks() || []) track.stop();
    localStream = null;
    dom.localVideo.srcObject = null;
    dom.lobbyVideo.srcObject = null;
  }

  function showMediaProblem(error) {
    const message = mediaProblemMessage(error);
    if (dom.lobbyStatus) dom.lobbyStatus.textContent = message;
  }

  function showPartialMediaProblem(errors) {
    const failedKinds = new Set(errors.map((item) => item.kind));
    if (failedKinds.has("video") && !failedKinds.has("audio")) {
      if (dom.lobbyStatus) dom.lobbyStatus.textContent = "Audio conectado. Camera indisponivel neste celular.";
    }
    if (failedKinds.has("audio") && !failedKinds.has("video")) {
      if (dom.lobbyStatus) dom.lobbyStatus.textContent = "Camera conectada. Microfone indisponivel neste celular.";
    }
  }

  return {
    ensureMedia,
    getLocalStream: () => localStream,
    isMicEnabled: () => micEnabled,
    refreshDeviceOptions,
    selectDevice,
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
