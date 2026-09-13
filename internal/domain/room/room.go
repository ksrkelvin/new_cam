package room

import "time"

type Room struct {
	ID          int64
	Code        string
	OwnerToken  string
	LastEmptyAt *time.Time
	CreatedAt   time.Time
}
