package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

const MaxRoomParticipants = 10

type Hub struct {
	mu       sync.RWMutex
	rooms    map[string]*liveRoom
	activity RoomActivity
	logger   *slog.Logger
}

type RoomActivity interface {
	MarkOccupied(ctx context.Context, code string) error
	MarkEmpty(ctx context.Context, code string) error
	ApproveGuest(ctx context.Context, roomCode string, guestToken string) error
	RevokeGuest(ctx context.Context, roomCode string, guestToken string) error
}

type liveRoom struct {
	participants map[*Client]struct{}
	pending      map[*Client]struct{}
}

type signalMessage struct {
	Type  string          `json:"type"`
	From  string          `json:"from,omitempty"`
	To    string          `json:"to,omitempty"`
	Peers []string        `json:"peers,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

type peerInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func NewHub(activity RoomActivity) *Hub {
	return &Hub{
		rooms:    make(map[string]*liveRoom),
		activity: activity,
		logger:   slog.Default(),
	}
}

func (h *Hub) Serve(writer http.ResponseWriter, request *http.Request, roomCode string, isOwner bool, guestToken string, isGuestApproved bool) {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}

	conn, err := upgrader.Upgrade(writer, request, nil)
	if err != nil {
		h.logger.Warn("websocket upgrade failed", "room", roomCode, "error", err)
		return
	}

	client := NewClient(roomCode, conn, h, isOwner, guestToken, isGuestApproved)
	peers, err := h.register(client)
	if errors.Is(err, ErrRoomFull) {
		h.logger.Warn("room full", "room", roomCode, "limit", MaxRoomParticipants)
		_ = conn.WriteJSON(signalMessage{Type: "room-full"})
		_ = conn.Close()
		return
	}
	if client.isApproved {
		_ = client.send(signalMessage{Type: "ready", From: client.id, Peers: peers, Data: mustJSON(map[string]any{
			"owner": client.isOwner,
			"peers": h.peerInfos(roomCode),
			"name":  clientName(client),
		})})
	} else {
		_ = client.send(signalMessage{Type: "waiting", From: client.id})
	}
	client.Run()
}

var ErrRoomFull = errors.New("room is full")

func (h *Hub) register(client *Client) ([]string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.rooms[client.roomCode] == nil {
		h.rooms[client.roomCode] = &liveRoom{
			participants: make(map[*Client]struct{}),
			pending:      make(map[*Client]struct{}),
		}
	}

	room := h.rooms[client.roomCode]
	if client.isOwner {
		client.displayName = "Criador"
		for existingClient := range room.participants {
			if existingClient.isOwner {
				existingClient.isOwner = false
				_ = existingClient.send(signalMessage{Type: "owner-replaced"})
			}
		}
	}

	if len(room.participants) >= MaxRoomParticipants {
		return nil, ErrRoomFull
	}

	if !client.isApproved {
		room.pending[client] = struct{}{}
		h.sendPendingListLocked(client.roomCode)
		return nil, nil
	}

	peers := make([]string, 0, len(room.participants))
	for existingClient := range room.participants {
		peers = append(peers, existingClient.id)
	}

	room.participants[client] = struct{}{}
	h.markOccupied(client.roomCode)
	h.logger.Info(
		"client joined room",
		"room", client.roomCode,
		"client", client.id,
		"participants", len(room.participants),
		"limit", MaxRoomParticipants,
	)
	h.broadcast(client, signalMessage{Type: "peer-joined", From: client.id, Data: mustJSON(map[string]any{"name": clientName(client)})})
	return peers, nil
}

func (h *Hub) unregister(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.rooms[client.roomCode]
	if room == nil {
		return
	}
	_, wasParticipant := room.participants[client]
	delete(room.participants, client)
	delete(room.pending, client)
	if len(room.participants) == 0 && len(room.pending) == 0 {
		delete(h.rooms, client.roomCode)
		h.markEmpty(client.roomCode)
		h.logger.Info("client left room", "room", client.roomCode, "client", client.id, "participants", 0)
		return
	}
	h.logger.Info("client left room", "room", client.roomCode, "client", client.id, "participants", len(room.participants))
	if wasParticipant {
		h.broadcast(client, signalMessage{Type: "peer-left", From: client.id})
	}
	h.sendPendingListLocked(client.roomCode)
}

func (h *Hub) broadcast(sender *Client, message signalMessage) {
	room := h.rooms[sender.roomCode]
	if room == nil {
		return
	}
	for client := range room.participants {
		if client == sender {
			continue
		}
		if message.To != "" && message.To != client.id {
			continue
		}
		_ = client.send(message)
	}
}

func (h *Hub) handle(client *Client, message signalMessage) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if client.isOwner {
		switch message.Type {
		case "approve":
			h.approveLocked(client, message.To)
			return
		case "kick":
			h.kickLocked(client, message.To)
			return
		}
	}

	if client.isApproved && message.Type == "participant-info" {
		client.displayName = stringFromJSON(message.Data, "name")
		h.broadcast(client, signalMessage{Type: "peer-info", From: client.id, Data: mustJSON(map[string]any{"name": clientName(client)})})
		return
	}

	if !client.isApproved {
		if message.Type == "lobby-info" {
			client.displayName = stringFromJSON(message.Data, "name")
			h.sendPendingListLocked(client.roomCode)
		}
		return
	}

	h.broadcast(client, message)
}

func (h *Hub) approveLocked(owner *Client, pendingID string) {
	room := h.rooms[owner.roomCode]
	if room == nil {
		return
	}
	for pendingClient := range room.pending {
		if pendingClient.id != pendingID {
			continue
		}
		if len(room.participants) >= MaxRoomParticipants {
			_ = pendingClient.send(signalMessage{Type: "room-full"})
			return
		}
		delete(room.pending, pendingClient)
		pendingClient.isApproved = true
		h.approveGuest(owner.roomCode, pendingClient.guestToken)
		peers := make([]string, 0, len(room.participants))
		for existingClient := range room.participants {
			peers = append(peers, existingClient.id)
		}
		room.participants[pendingClient] = struct{}{}
		h.markOccupied(owner.roomCode)
		_ = pendingClient.send(signalMessage{Type: "approved", From: pendingClient.id, Peers: peers, Data: mustJSON(map[string]any{
			"peers": h.peerInfosLocked(room, pendingClient),
			"name":  clientName(pendingClient),
		})})
		h.broadcast(pendingClient, signalMessage{Type: "peer-joined", From: pendingClient.id, Data: mustJSON(map[string]any{"name": clientName(pendingClient)})})
		h.sendPendingListLocked(owner.roomCode)
		return
	}
}

func (h *Hub) kickLocked(owner *Client, clientID string) {
	room := h.rooms[owner.roomCode]
	if room == nil {
		return
	}
	for pendingClient := range room.pending {
		if pendingClient.id == clientID {
			delete(room.pending, pendingClient)
			_ = pendingClient.send(signalMessage{Type: "rejected"})
			_ = pendingClient.conn.Close()
			h.sendPendingListLocked(owner.roomCode)
			return
		}
	}
	for participant := range room.participants {
		if participant.id == clientID && participant != owner {
			delete(room.participants, participant)
			h.revokeGuest(owner.roomCode, participant.guestToken)
			_ = participant.send(signalMessage{Type: "kicked"})
			_ = participant.conn.Close()
			h.broadcast(participant, signalMessage{Type: "peer-left", From: participant.id})
			if len(room.participants) == 0 && len(room.pending) == 0 {
				h.markEmpty(owner.roomCode)
			}
			return
		}
	}
}

func (h *Hub) sendPendingListLocked(roomCode string) {
	room := h.rooms[roomCode]
	if room == nil {
		return
	}
	pending := make([]map[string]string, 0, len(room.pending))
	for client := range room.pending {
		name := client.displayName
		if name == "" {
			name = "Convidado " + client.id[:4]
		}
		pending = append(pending, map[string]string{"id": client.id, "name": name})
	}
	for client := range room.participants {
		if client.isOwner {
			_ = client.send(signalMessage{Type: "pending-list", Data: mustJSON(map[string]any{"pending": pending})})
		}
	}
}

func mustJSON(value any) json.RawMessage {
	payload, _ := json.Marshal(value)
	return payload
}

func stringFromJSON(data json.RawMessage, key string) string {
	var payload map[string]string
	if err := json.Unmarshal(data, &payload); err != nil {
		return ""
	}
	return payload[key]
}

func clientName(client *Client) string {
	if client.displayName != "" {
		return client.displayName
	}
	if client.isOwner {
		return "Criador"
	}
	return "Convidado " + client.id[:4]
}

func (h *Hub) peerInfos(roomCode string) []peerInfo {
	h.mu.RLock()
	defer h.mu.RUnlock()

	room := h.rooms[roomCode]
	if room == nil {
		return nil
	}
	return h.peerInfosLocked(room, nil)
}

func (h *Hub) peerInfosLocked(room *liveRoom, exclude *Client) []peerInfo {
	peers := make([]peerInfo, 0, len(room.participants))
	for client := range room.participants {
		if client == exclude {
			continue
		}
		peers = append(peers, peerInfo{ID: client.id, Name: clientName(client)})
	}
	return peers
}

func (h *Hub) markOccupied(roomCode string) {
	if h.activity == nil {
		return
	}
	if err := h.activity.MarkOccupied(context.Background(), roomCode); err != nil {
		h.logger.Warn("mark room occupied failed", "room", roomCode, "error", err)
	}
}

func (h *Hub) markEmpty(roomCode string) {
	if h.activity == nil {
		return
	}
	if err := h.activity.MarkEmpty(context.Background(), roomCode); err != nil {
		h.logger.Warn("mark room empty failed", "room", roomCode, "error", err)
	}
}

func (h *Hub) approveGuest(roomCode string, guestToken string) {
	if h.activity == nil || guestToken == "" {
		return
	}
	if err := h.activity.ApproveGuest(context.Background(), roomCode, guestToken); err != nil {
		h.logger.Warn("approve guest failed", "room", roomCode, "error", err)
	}
}

func (h *Hub) revokeGuest(roomCode string, guestToken string) {
	if h.activity == nil || guestToken == "" {
		return
	}
	if err := h.activity.RevokeGuest(context.Background(), roomCode, guestToken); err != nil {
		h.logger.Warn("revoke guest failed", "room", roomCode, "error", err)
	}
}
