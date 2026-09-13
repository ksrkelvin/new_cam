DROP TABLE IF EXISTS room_approved_guests;
ALTER TABLE rooms DROP COLUMN last_empty_at;
ALTER TABLE rooms DROP COLUMN owner_token;
