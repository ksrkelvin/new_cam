package room

import "context"

type Repository interface {
	Create(ctx context.Context, code string, name string, ownerToken string) (Room, error)
	FindByCode(ctx context.Context, code string) (Room, error)
	Delete(ctx context.Context, code string) error
	MarkOccupied(ctx context.Context, code string) error
	MarkEmpty(ctx context.Context, code string) error
	ApproveGuest(ctx context.Context, roomCode string, guestToken string) error
	RevokeGuest(ctx context.Context, roomCode string, guestToken string) error
	IsGuestApproved(ctx context.Context, roomCode string, guestToken string) (bool, error)
}
