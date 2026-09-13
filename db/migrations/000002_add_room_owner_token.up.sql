ALTER TABLE rooms ADD COLUMN IF NOT EXISTS owner_token TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS last_empty_at TIMESTAMPTZ DEFAULT now();

UPDATE rooms
SET owner_token = md5(random()::text || clock_timestamp()::text || id::text)
WHERE owner_token IS NULL;

ALTER TABLE rooms ALTER COLUMN owner_token SET NOT NULL;

CREATE TABLE IF NOT EXISTS room_approved_guests (
    room_code TEXT NOT NULL REFERENCES rooms (code) ON DELETE CASCADE,
    guest_token TEXT NOT NULL,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (room_code, guest_token)
);
