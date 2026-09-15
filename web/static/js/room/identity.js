export function getOrCreateGuestToken(roomCode) {
  const key = `wecam_guest_${roomCode}`;
  const existingToken = localStorage.getItem(key);
  if (existingToken) return existingToken;

  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(key, token);
  return token;
}

export function getOrCreateClientLogID() {
  const key = "wecam_client_log_id";
  const existingID = localStorage.getItem(key);
  if (existingID) return existingID;

  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(key, id);
  return id;
}

export function guestNameKey(roomCode) {
  return `wecam_guest_name_${roomCode}`;
}

export function shortID(peerID) {
  return peerID.slice(0, 4).toUpperCase();
}

