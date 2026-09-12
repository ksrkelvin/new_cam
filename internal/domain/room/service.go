package room

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
)

var ErrRoomNotFound = errors.New("room not found")

type Service struct {
	repository Repository
}

func NewService(repository Repository) *Service {
	return &Service{repository: repository}
}

func (s *Service) Create(ctx context.Context) (Room, error) {
	for range 5 {
		room, err := s.repository.Create(ctx, generateCode())
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
	return s.repository.FindByCode(ctx, normalized)
}

func NormalizeCode(code string) string {
	return strings.ToUpper(strings.TrimSpace(code))
}

func generateCode() string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	buffer := make([]byte, 6)
	if _, err := rand.Read(buffer); err != nil {
		panic(fmt.Sprintf("read random bytes: %v", err))
	}
	for index, value := range buffer {
		buffer[index] = alphabet[int(value)%len(alphabet)]
	}
	return string(buffer)
}
