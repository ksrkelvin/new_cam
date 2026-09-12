package database

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"we_cam/internal/domain/room"
	"we_cam/internal/infra/database/db"
)

type RoomRepository struct {
	queries *db.Queries
}

func NewRoomRepository(pool db.DBTX) *RoomRepository {
	return &RoomRepository{queries: db.New(pool)}
}

func (r *RoomRepository) Create(ctx context.Context, code string) (room.Room, error) {
	model, err := r.queries.CreateRoom(ctx, code)
	if err != nil {
		return room.Room{}, err
	}
	return toDomainRoom(model), nil
}

func (r *RoomRepository) FindByCode(ctx context.Context, code string) (room.Room, error) {
	model, err := r.queries.FindRoomByCode(ctx, code)
	if errors.Is(err, pgx.ErrNoRows) {
		return room.Room{}, room.ErrRoomNotFound
	}
	if err != nil {
		return room.Room{}, err
	}
	return toDomainRoom(model), nil
}

func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func toDomainRoom(model db.Room) room.Room {
	return room.Room{
		ID:        model.ID,
		Code:      model.Code,
		CreatedAt: model.CreatedAt,
	}
}
