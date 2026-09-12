package realtime

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

const MaxRoomParticipants = 10

type Hub struct {
	mu     sync.RWMutex
	rooms  map[string]map[*Client]struct{}
	logger *slog.Logger
}

type signalMessage struct {
	Type  string          `json:"type"`
	From  string          `json:"from,omitempty"`
	To    string          `json:"to,omitempty"`
	Peers []string        `json:"peers,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

func NewHub() *Hub {
	return &Hub{
		rooms:  make(map[string]map[*Client]struct{}),
		logger: slog.Default(),
	}
}

func (h *Hub) Serve(writer http.ResponseWriter, request *http.Request, roomCode string) {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}

	conn, err := upgrader.Upgrade(writer, request, nil)
	if err != nil {
		h.logger.Warn("websocket upgrade failed", "room", roomCode, "error", err)
		return
	}

	client := NewClient(roomCode, conn, h)
	peers, err := h.register(client)
	if errors.Is(err, ErrRoomFull) {
		h.logger.Warn("room full", "room", roomCode, "limit", MaxRoomParticipants)
		_ = conn.WriteJSON(signalMessage{Type: "room-full"})
		_ = conn.Close()
		return
	}
	_ = client.send(signalMessage{Type: "ready", From: client.id, Peers: peers})
	client.Run()
}

var ErrRoomFull = errors.New("room is full")

func (h *Hub) register(client *Client) ([]string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.rooms[client.roomCode] == nil {
		h.rooms[client.roomCode] = make(map[*Client]struct{})
	}

	clients := h.rooms[client.roomCode]
	if len(clients) >= MaxRoomParticipants {
		return nil, ErrRoomFull
	}

	peers := make([]string, 0, len(clients))
	for existingClient := range clients {
		peers = append(peers, existingClient.id)
	}

	h.rooms[client.roomCode][client] = struct{}{}
	h.logger.Info(
		"client joined room",
		"room", client.roomCode,
		"client", client.id,
		"participants", len(h.rooms[client.roomCode]),
		"limit", MaxRoomParticipants,
	)
	h.broadcast(client, signalMessage{Type: "peer-joined", From: client.id})
	return peers, nil
}

func (h *Hub) unregister(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	clients := h.rooms[client.roomCode]
	if clients == nil {
		return
	}
	delete(clients, client)
	if len(clients) == 0 {
		delete(h.rooms, client.roomCode)
		h.logger.Info("client left room", "room", client.roomCode, "client", client.id, "participants", 0)
		return
	}
	h.logger.Info("client left room", "room", client.roomCode, "client", client.id, "participants", len(clients))
	h.broadcast(client, signalMessage{Type: "peer-left", From: client.id})
}

func (h *Hub) broadcast(sender *Client, message signalMessage) {
	clients := h.rooms[sender.roomCode]
	for client := range clients {
		if client == sender {
			continue
		}
		if message.To != "" && message.To != client.id {
			continue
		}
		_ = client.send(message)
	}
}
