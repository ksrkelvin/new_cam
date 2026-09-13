-- name: CreateRoom :one
INSERT INTO rooms (code, owner_token)
VALUES ($1, $2)
RETURNING id, code, owner_token, last_empty_at, created_at;

-- name: FindRoomByCode :one
SELECT id, code, owner_token, last_empty_at, created_at
FROM rooms
WHERE code = $1;

-- name: DeleteRoom :exec
DELETE FROM rooms
WHERE code = $1;

-- name: MarkRoomOccupied :exec
UPDATE rooms
SET last_empty_at = NULL
WHERE code = $1;

-- name: MarkRoomEmpty :exec
UPDATE rooms
SET last_empty_at = now()
WHERE code = $1;

-- name: ApproveRoomGuest :exec
INSERT INTO room_approved_guests (room_code, guest_token)
VALUES ($1, $2)
ON CONFLICT (room_code, guest_token) DO NOTHING;

-- name: IsRoomGuestApproved :one
SELECT EXISTS (
    SELECT 1
    FROM room_approved_guests
    WHERE room_code = $1 AND guest_token = $2
);

-- name: RevokeRoomGuest :exec
DELETE FROM room_approved_guests
WHERE room_code = $1 AND guest_token = $2;
