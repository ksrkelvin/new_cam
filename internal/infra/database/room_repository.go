package database

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"we_cam/internal/domain/room"
	"we_cam/internal/infra/database/db"
)

type RoomRepository struct {
	queries *db.Queries
}

func NewRoomRepository(pool db.DBTX) *RoomRepository {
	return &RoomRepository{queries: db.New(pool)}
}

func (r *RoomRepository) Create(ctx context.Context, code string, name string, ownerToken string) (room.Room, error) {
	model, err := r.queries.CreateRoom(ctx, db.CreateRoomParams{Code: code, Name: name, OwnerToken: ownerToken})
	if err != nil {
		return room.Room{}, err
	}
	return createRoomRowToDomain(model), nil
}

func (r *RoomRepository) FindByCode(ctx context.Context, code string) (room.Room, error) {
	model, err := r.queries.FindRoomByCode(ctx, code)
	if errors.Is(err, pgx.ErrNoRows) {
		return room.Room{}, room.ErrRoomNotFound
	}
	if err != nil {
		return room.Room{}, err
	}
	return findRoomRowToDomain(model), nil
}

func (r *RoomRepository) Delete(ctx context.Context, code string) error {
	return r.queries.DeleteRoom(ctx, code)
}

func (r *RoomRepository) MarkOccupied(ctx context.Context, code string) error {
	return r.queries.MarkRoomOccupied(ctx, code)
}

func (r *RoomRepository) MarkEmpty(ctx context.Context, code string) error {
	return r.queries.MarkRoomEmpty(ctx, code)
}

func (r *RoomRepository) ApproveGuest(ctx context.Context, roomCode string, guestToken string) error {
	return r.queries.ApproveRoomGuest(ctx, db.ApproveRoomGuestParams{RoomCode: roomCode, GuestToken: guestToken})
}

func (r *RoomRepository) RevokeGuest(ctx context.Context, roomCode string, guestToken string) error {
	return r.queries.RevokeRoomGuest(ctx, db.RevokeRoomGuestParams{RoomCode: roomCode, GuestToken: guestToken})
}

func (r *RoomRepository) IsGuestApproved(ctx context.Context, roomCode string, guestToken string) (bool, error) {
	return r.queries.IsRoomGuestApproved(ctx, db.IsRoomGuestApprovedParams{RoomCode: roomCode, GuestToken: guestToken})
}

func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func createRoomRowToDomain(model db.CreateRoomRow) room.Room {
	return room.Room{
		ID:          model.ID,
		Code:        model.Code,
		Name:        model.Name,
		OwnerToken:  model.OwnerToken,
		LastEmptyAt: timePtr(model.LastEmptyAt),
		CreatedAt:   timeValue(model.CreatedAt),
	}
}

func findRoomRowToDomain(model db.FindRoomByCodeRow) room.Room {
	return room.Room{
		ID:          model.ID,
		Code:        model.Code,
		Name:        model.Name,
		OwnerToken:  model.OwnerToken,
		LastEmptyAt: timePtr(model.LastEmptyAt),
		CreatedAt:   timeValue(model.CreatedAt),
	}
}

func timePtr(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	return &value.Time
}

func timeValue(value pgtype.Timestamptz) time.Time {
	if !value.Valid {
		return time.Time{}
	}
	return value.Time
}
