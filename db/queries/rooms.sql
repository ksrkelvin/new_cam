-- name: CreateRoom :one
INSERT INTO rooms (code)
VALUES ($1)
RETURNING id, code, created_at;

-- name: FindRoomByCode :one
SELECT id, code, created_at
FROM rooms
WHERE code = $1;
