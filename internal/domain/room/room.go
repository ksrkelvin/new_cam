package room

import "time"

type Room struct {
	ID        int64
	Code      string
	CreatedAt time.Time
}
