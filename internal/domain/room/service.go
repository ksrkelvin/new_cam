package room

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrRoomNotFound = errors.New("room not found")

const EmptyRoomTTL = 60 * time.Minute

type Service struct {
	repository Repository
}

func NewService(repository Repository) *Service {
	return &Service{repository: repository}
}

func (s *Service) Create(ctx context.Context, name string) (Room, error) {
	normalizedName := NormalizeName(name)
	for range 5 {
		room, err := s.repository.Create(ctx, generateUUID(), normalizedName, generateToken())
		if err == nil {
			return room, nil
		}
	}
	return Room{}, errors.New("could not create a unique room code")
}

func (s *Service) Join(ctx context.Context, code string) (Room, error) {
	normalized := NormalizeCode(code)
	if normalized == "" {
		return Room{}, ErrRoomNotFound
	}
	foundRoom, err := s.repository.FindByCode(ctx, normalized)
	if err != nil {
		return Room{}, err
	}
	if foundRoom.LastEmptyAt != nil && time.Since(*foundRoom.LastEmptyAt) >= EmptyRoomTTL {
		_ = s.repository.Delete(ctx, foundRoom.Code)
		return Room{}, ErrRoomNotFound
	}
	return foundRoom, nil
}

func (s *Service) MarkOccupied(ctx context.Context, code string) error {
	return s.repository.MarkOccupied(ctx, NormalizeCode(code))
}

func (s *Service) MarkEmpty(ctx context.Context, code string) error {
	return s.repository.MarkEmpty(ctx, NormalizeCode(code))
}

func (s *Service) ApproveGuest(ctx context.Context, roomCode string, guestToken string) error {
	if strings.TrimSpace(guestToken) == "" {
		return nil
	}
	return s.repository.ApproveGuest(ctx, NormalizeCode(roomCode), guestToken)
}

func (s *Service) RevokeGuest(ctx context.Context, roomCode string, guestToken string) error {
	if strings.TrimSpace(guestToken) == "" {
		return nil
	}
	return s.repository.RevokeGuest(ctx, NormalizeCode(roomCode), guestToken)
}

func (s *Service) IsGuestApproved(ctx context.Context, roomCode string, guestToken string) (bool, error) {
	if strings.TrimSpace(guestToken) == "" {
		return false, nil
	}
	return s.repository.IsGuestApproved(ctx, NormalizeCode(roomCode), guestToken)
}

func NormalizeCode(code string) string {
	return strings.ToLower(strings.TrimSpace(code))
}

func NormalizeName(name string) string {
	normalized := strings.TrimSpace(name)
	if normalized == "" {
		return "Sala sem nome"
	}
	if len([]rune(normalized)) > 80 {
		return string([]rune(normalized)[:80])
	}
	return normalized
}

func generateUUID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		panic(fmt.Sprintf("read random bytes: %v", err))
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buffer[0:4], buffer[4:6], buffer[6:8], buffer[8:10], buffer[10:])
}

func generateToken() string {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		panic(fmt.Sprintf("read random bytes: %v", err))
	}
	return hex.EncodeToString(buffer)
}
