export function createLogger({ roomCode, clientLogID }) {
  return function logClientEvent(level, event, data = {}) {
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
  };
}

export function connectionInfo() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection) return {};
  return {
    effectiveType: connection.effectiveType,
    downlink: connection.downlink,
    rtt: connection.rtt,
    saveData: connection.saveData,
  };
}

export function describeSDP(sdp) {
  return {
    audio: /m=audio /.test(sdp),
    video: /m=video /.test(sdp),
    sendrecv: (sdp.match(/a=sendrecv/g) || []).length,
    sendonly: (sdp.match(/a=sendonly/g) || []).length,
    recvonly: (sdp.match(/a=recvonly/g) || []).length,
    inactive: (sdp.match(/a=inactive/g) || []).length,
  };
}

