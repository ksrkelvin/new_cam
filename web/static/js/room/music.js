export function createMusic({ dom, isOwner, send, logClientEvent }) {
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

  function installYouTubeCallback() {
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
    if (window.YT?.Player) {
      window.onYouTubeIframeAPIReady();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    document.head.append(script);
  }

  function bindEvents() {
    dom.musicForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const videoId = extractYouTubeVideoID(dom.musicURLInput?.value || "");
      if (!videoId) {
        updateMusicStatus("URL do YouTube invalida");
        return;
      }
      musicUserActivated = true;
      send("music-set", "", { videoId });
    });

    dom.musicPlayPause?.addEventListener("click", () => {
      musicUserActivated = true;
      const position = youtubePlayer?.getCurrentTime?.() || expectedMusicPosition();
      send(musicState.playing ? "music-pause" : "music-play", "", { position });
    });

    dom.musicSeek?.addEventListener("input", () => {
      musicSeekPending = true;
    });

    dom.musicSeek?.addEventListener("change", () => {
      musicSeekPending = false;
      musicUserActivated = true;
      send("music-seek", "", { position: Number(dom.musicSeek.value || 0) });
    });

    dom.musicEnable?.addEventListener("click", activateMusic);
    dom.musicMute?.addEventListener("click", () => setMusicMuted(!musicMuted));
    dom.musicLoop?.addEventListener("click", () => setMusicLoop(!musicLoopEnabled));
    dom.musicVolumeBars?.addEventListener("pointerdown", (event) => {
      updateMusicVolumeFromPointer(event);
      dom.musicVolumeBars.setPointerCapture(event.pointerId);
    });
    dom.musicVolumeBars?.addEventListener("pointermove", (event) => {
      if (event.buttons !== 1) return;
      updateMusicVolumeFromPointer(event);
    });
    dom.musicVolumeBars?.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -10 : 10;
      musicUserActivated = true;
      setMusicMuted(false);
      setMusicVolume(musicVolumeValue + direction);
    });
    updateMusicVolumeBars();
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
    if (dom.musicTitle) dom.musicTitle.textContent = hasVideo ? `YouTube ${musicState.videoId}` : "Sem música";
    updateMusicStatus(hasVideo ? (musicState.playing ? "Tocando" : "Pausada") : "Parada");
    updateMusicProgress();
    if (dom.musicPlayPause) dom.musicPlayPause.innerHTML = musicState.playing ? '<i class="fa-solid fa-pause" aria-hidden="true"></i>' : '<i class="fa-solid fa-play" aria-hidden="true"></i>';
    if (dom.musicSeek && !musicSeekPending) dom.musicSeek.value = String(Math.floor(expectedMusicPosition()));
  }

  function updateMusicStatus(text) {
    if (dom.musicStatus) dom.musicStatus.textContent = text;
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
    if (dom.musicSeek) dom.musicSeek.max = String(Math.max(musicDuration, Math.floor(expectedMusicPosition()), 0));
    updateMusicProgress();
  }

  function updateMusicProgress() {
    const position = Math.floor(expectedMusicPosition());
    const duration = Math.max(musicDuration, position, 0);
    if (dom.musicTime) dom.musicTime.textContent = `${formatMusicTime(position)} / ${formatMusicTime(duration)}`;
    if (dom.musicProgressBar) {
      const progress = duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0;
      dom.musicProgressBar.style.width = `${progress}%`;
    }
  }

  function showMusicActivation() {
    if (dom.musicEnable) dom.musicEnable.hidden = false;
  }

  function hideMusicActivation() {
    if (dom.musicEnable) dom.musicEnable.hidden = true;
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
    if (dom.musicMute) {
      dom.musicMute.innerHTML = muted ? '<i class="fa-solid fa-volume-xmark" aria-hidden="true"></i>' : '<i class="fa-solid fa-volume-high" aria-hidden="true"></i>';
      dom.musicMute.classList.toggle("is-muted", muted);
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
      if (dom.musicLoop) {
        dom.musicLoop.classList.toggle("is-active", enabled);
        dom.musicLoop.setAttribute("aria-label", enabled ? "Desligar repetição" : "Ligar repetição");
      }
    }
  }

  function updateMusicVolumeFromPointer(event) {
    if (!dom.musicVolumeBars) return;
    const rect = dom.musicVolumeBars.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    musicUserActivated = true;
    setMusicMuted(false);
    setMusicVolume(Math.round(Math.max(0, Math.min(1, ratio)) * 100));
  }

  function updateMusicVolumeBars() {
    if (!dom.musicVolumeBars) return;
    const value = musicMuted ? 0 : musicVolumeValue;
    const activeBars = Math.ceil((value / 100) * dom.musicVolumeBars.querySelectorAll("span").length);
    dom.musicVolumeBars.setAttribute("aria-valuenow", String(value));
    dom.musicVolumeBars.querySelectorAll("span").forEach((bar, index) => {
      bar.classList.toggle("is-active", index < activeBars);
    });
  }

  return { installYouTubeCallback, bindEvents, applyMusicState };
}

function formatMusicTime(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
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
