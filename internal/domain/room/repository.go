package room

import "context"

type Repository interface {
	Create(ctx context.Context, code string) (Room, error)
	FindByCode(ctx context.Context, code string) (Room, error)
}
