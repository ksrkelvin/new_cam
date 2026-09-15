package realtime

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"we_cam/internal/infra/observability"
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
	music        musicState
	initiative   initiativeState
}

type musicState struct {
	VideoID   string  `json:"videoId"`
	Playing   bool    `json:"playing"`
	Position  float64 `json:"position"`
	UpdatedAt int64   `json:"updatedAt"`
	Revision  int64   `json:"revision"`
}

type diceRoll struct {
	Roller     string `json:"roller"`
	Expression string `json:"expression"`
	Count      int    `json:"count"`
	Sides      int    `json:"sides"`
	Modifier   int    `json:"modifier"`
	Rolls      []int  `json:"rolls"`
	Total      int    `json:"total"`
	RolledAt   int64  `json:"rolledAt"`
}

type initiativeState struct {
	Entries []initiativeEntry `json:"entries"`
	Turn    int               `json:"turn"`
}

type initiativeEntry struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Score int    `json:"score"`
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
	observability.IncWebsocketConnections()
	peers, err := h.register(client)
	if errors.Is(err, ErrRoomFull) {
		h.logger.Warn("room full", "room", roomCode, "limit", MaxRoomParticipants)
		_ = conn.WriteJSON(signalMessage{Type: "room-full"})
		_ = conn.Close()
		return
	}
	if client.isApproved {
		_ = client.send(signalMessage{Type: "ready", From: client.id, Peers: peers, Data: mustJSON(map[string]any{
			"owner":      client.isOwner,
			"peers":      h.peerInfos(roomCode),
			"name":       clientName(client),
			"music":      h.musicState(roomCode),
			"initiative": h.initiativeState(roomCode),
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
		h.updateMetricsLocked()
		h.sendPendingListLocked(client.roomCode)
		return nil, nil
	}

	peers := make([]string, 0, len(room.participants))
	for existingClient := range room.participants {
		peers = append(peers, existingClient.id)
	}

	room.participants[client] = struct{}{}
	h.markOccupied(client.roomCode)
	h.updateMetricsLocked()
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
	observability.IncWebsocketDisconnects()
	if len(room.participants) == 0 && len(room.pending) == 0 {
		delete(h.rooms, client.roomCode)
		h.markEmpty(client.roomCode)
		h.updateMetricsLocked()
		h.logger.Info("client left room", "room", client.roomCode, "client", client.id, "participants", 0)
		return
	}
	h.logger.Info("client left room", "room", client.roomCode, "client", client.id, "participants", len(room.participants))
	if wasParticipant {
		h.broadcast(client, signalMessage{Type: "peer-left", From: client.id})
	}
	h.updateMetricsLocked()
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
		case "music-set", "music-play", "music-pause", "music-seek":
			h.handleMusicLocked(client, message)
			return
		case "initiative-add", "initiative-remove", "initiative-pass":
			h.handleInitiativeLocked(client, message)
			return
		}
	}

	if message.Type == "music-set" || message.Type == "music-play" || message.Type == "music-pause" || message.Type == "music-seek" {
		return
	}
	if message.Type == "initiative-add" || message.Type == "initiative-remove" || message.Type == "initiative-pass" {
		return
	}

	if client.isApproved && message.Type == "dice-roll" {
		h.handleDiceRollLocked(client, message)
		return
	}

	if client.isApproved && message.Type == "participant-info" {
		client.displayName = stringFromJSON(message.Data, "name")
		h.broadcast(client, signalMessage{Type: "peer-info", From: client.id, Data: mustJSON(map[string]any{"name": clientName(client)})})
		return
	}

	if !client.isApproved {
		if message.Type == "lobby-info" {
			client.displayName = stringFromJSON(message.Data, "name")
			client.lobbyRequested = true
			h.updateMetricsLocked()
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
		observability.IncGuestsApproved()
		peers := make([]string, 0, len(room.participants))
		for existingClient := range room.participants {
			peers = append(peers, existingClient.id)
		}
		room.participants[pendingClient] = struct{}{}
		h.markOccupied(owner.roomCode)
		h.updateMetricsLocked()
		_ = pendingClient.send(signalMessage{Type: "approved", From: pendingClient.id, Peers: peers, Data: mustJSON(map[string]any{
			"peers":      h.peerInfosLocked(room, pendingClient),
			"name":       clientName(pendingClient),
			"music":      h.musicStatePayloadLocked(room),
			"initiative": h.initiativeStatePayloadLocked(room),
		})})
		h.broadcast(pendingClient, signalMessage{Type: "peer-joined", From: pendingClient.id, Data: mustJSON(map[string]any{"name": clientName(pendingClient)})})
		h.sendPendingListLocked(owner.roomCode)
		return
	}
}

func (h *Hub) handleInitiativeLocked(owner *Client, message signalMessage) {
	room := h.rooms[owner.roomCode]
	if room == nil {
		return
	}

	switch message.Type {
	case "initiative-add":
		name, score, ok := initiativeEntryFromJSON(message.Data)
		if !ok || name == "" || score < -100 || score > 200 {
			return
		}
		if len(name) > 40 {
			name = name[:40]
		}
		room.initiative.Entries = append(room.initiative.Entries, initiativeEntry{
			ID:    randomID(),
			Name:  name,
			Score: score,
		})
		sortInitiativeEntries(room.initiative.Entries)
		room.initiative.Turn = clampInitiativeTurn(room.initiative.Turn, len(room.initiative.Entries))
	case "initiative-remove":
		id := stringFromJSON(message.Data, "id")
		for index, entry := range room.initiative.Entries {
			if entry.ID != id {
				continue
			}
			room.initiative.Entries = append(room.initiative.Entries[:index], room.initiative.Entries[index+1:]...)
			if index < room.initiative.Turn {
				room.initiative.Turn--
			}
			room.initiative.Turn = clampInitiativeTurn(room.initiative.Turn, len(room.initiative.Entries))
			break
		}
	case "initiative-pass":
		if len(room.initiative.Entries) == 0 {
			room.initiative.Turn = 0
			break
		}
		room.initiative.Turn = (room.initiative.Turn + 1) % len(room.initiative.Entries)
	}
	h.broadcastInitiativeLocked(room)
}

func (h *Hub) broadcastInitiativeLocked(room *liveRoom) {
	state := h.initiativeStatePayloadLocked(room)
	for client := range room.participants {
		_ = client.send(signalMessage{Type: "initiative-state", Data: mustJSON(state)})
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
			observability.IncGuestsRejected()
			_ = pendingClient.send(signalMessage{Type: "rejected"})
			_ = pendingClient.conn.Close()
			h.sendPendingListLocked(owner.roomCode)
			return
		}
	}
	for participant := range room.participants {
		if participant.id == clientID && participant != owner {
			delete(room.participants, participant)
			observability.IncGuestsKicked()
			h.revokeGuest(owner.roomCode, participant.guestToken)
			_ = participant.send(signalMessage{Type: "kicked"})
			_ = participant.conn.Close()
			h.broadcast(participant, signalMessage{Type: "peer-left", From: participant.id})
			if len(room.participants) == 0 && len(room.pending) == 0 {
				h.markEmpty(owner.roomCode)
			}
			h.updateMetricsLocked()
			return
		}
	}
}

func (h *Hub) handleMusicLocked(owner *Client, message signalMessage) {
	room := h.rooms[owner.roomCode]
	if room == nil {
		return
	}

	state := h.musicStatePayloadLocked(room)
	switch message.Type {
	case "music-set":
		videoID := stringFromJSON(message.Data, "videoId")
		if !validYouTubeVideoID(videoID) {
			return
		}
		state.VideoID = videoID
		state.Playing = true
		state.Position = 0
	case "music-play":
		if state.VideoID == "" {
			return
		}
		state.Position = positionFromJSON(message.Data, state.Position)
		state.Playing = true
	case "music-pause":
		if state.VideoID == "" {
			return
		}
		state.Position = positionFromJSON(message.Data, state.Position)
		state.Playing = false
	case "music-seek":
		if state.VideoID == "" {
			return
		}
		state.Position = positionFromJSON(message.Data, state.Position)
	}

	if state.Position < 0 {
		state.Position = 0
	}
	state.UpdatedAt = time.Now().UnixMilli()
	state.Revision++
	room.music = state
	h.broadcastMusicLocked(room)
}

func (h *Hub) broadcastMusicLocked(room *liveRoom) {
	state := h.musicStatePayloadLocked(room)
	for client := range room.participants {
		_ = client.send(signalMessage{Type: "music-state", Data: mustJSON(state)})
	}
}

func (h *Hub) handleDiceRollLocked(client *Client, message signalMessage) {
	room := h.rooms[client.roomCode]
	if room == nil {
		return
	}
	roll, ok := rollDiceFromJSON(message.Data)
	if !ok {
		_ = client.send(signalMessage{Type: "dice-error", Data: mustJSON(map[string]string{"message": "Escolha uma quantidade de 1 a 20 e um dado valido."})})
		return
	}
	roll.Roller = clientName(client)
	roll.RolledAt = time.Now().UnixMilli()
	for participant := range room.participants {
		_ = participant.send(signalMessage{Type: "dice-result", From: client.id, Data: mustJSON(roll)})
	}
}

func (h *Hub) musicState(roomCode string) musicState {
	h.mu.RLock()
	defer h.mu.RUnlock()

	room := h.rooms[roomCode]
	if room == nil {
		return musicState{}
	}
	return h.musicStatePayloadLocked(room)
}

func (h *Hub) initiativeState(roomCode string) initiativeState {
	h.mu.RLock()
	defer h.mu.RUnlock()

	room := h.rooms[roomCode]
	if room == nil {
		return initiativeState{}
	}
	return h.initiativeStatePayloadLocked(room)
}

func (h *Hub) initiativeStatePayloadLocked(room *liveRoom) initiativeState {
	state := initiativeState{
		Entries: append([]initiativeEntry(nil), room.initiative.Entries...),
		Turn:    clampInitiativeTurn(room.initiative.Turn, len(room.initiative.Entries)),
	}
	return state
}

func (h *Hub) musicStatePayloadLocked(room *liveRoom) musicState {
	state := room.music
	if state.Playing && state.UpdatedAt > 0 {
		now := time.Now().UnixMilli()
		state.Position += float64(now-state.UpdatedAt) / 1000
		state.UpdatedAt = now
	}
	return state
}

func (h *Hub) sendPendingListLocked(roomCode string) {
	room := h.rooms[roomCode]
	if room == nil {
		return
	}
	pending := make([]map[string]string, 0, len(room.pending))
	for client := range room.pending {
		if !client.lobbyRequested {
			continue
		}
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

func positionFromJSON(data json.RawMessage, fallback float64) float64 {
	var payload map[string]float64
	if err := json.Unmarshal(data, &payload); err != nil {
		return fallback
	}
	position, ok := payload["position"]
	if !ok {
		return fallback
	}
	return position
}

func initiativeEntryFromJSON(data json.RawMessage) (string, int, bool) {
	var payload struct {
		Name  string `json:"name"`
		Score int    `json:"score"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return "", 0, false
	}
	return strings.TrimSpace(payload.Name), payload.Score, true
}

func sortInitiativeEntries(entries []initiativeEntry) {
	for i := 1; i < len(entries); i++ {
		current := entries[i]
		j := i - 1
		for j >= 0 && entries[j].Score < current.Score {
			entries[j+1] = entries[j]
			j--
		}
		entries[j+1] = current
	}
}

func clampInitiativeTurn(turn int, count int) int {
	if count <= 0 || turn < 0 {
		return 0
	}
	if turn >= count {
		return count - 1
	}
	return turn
}

func validYouTubeVideoID(videoID string) bool {
	if len(videoID) != 11 {
		return false
	}
	for _, character := range videoID {
		if character >= 'a' && character <= 'z' {
			continue
		}
		if character >= 'A' && character <= 'Z' {
			continue
		}
		if character >= '0' && character <= '9' {
			continue
		}
		if character == '_' || character == '-' {
			continue
		}
		return false
	}
	return true
}

var diceExpressionPattern = regexp.MustCompile(`(?i)^/?r?\s*(?:(\d*)d)?(\d+)(?:\s*([+-])\s*(\d+))?$`)

func rollDiceFromJSON(data json.RawMessage) (diceRoll, bool) {
	var payload struct {
		Count      int    `json:"count"`
		Sides      int    `json:"sides"`
		Modifier   int    `json:"modifier"`
		Expression string `json:"expression"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return diceRoll{}, false
	}
	if payload.Count > 0 || payload.Sides > 0 {
		return rollDiceParts(payload.Count, payload.Sides, payload.Modifier)
	}
	return rollDice(payload.Expression)
}

func rollDice(expression string) (diceRoll, bool) {
	cleanExpression := strings.TrimSpace(expression)
	matches := diceExpressionPattern.FindStringSubmatch(cleanExpression)
	if matches == nil {
		return diceRoll{}, false
	}

	count := 1
	if matches[1] != "" {
		parsedCount, err := strconv.Atoi(matches[1])
		if err != nil {
			return diceRoll{}, false
		}
		count = parsedCount
	}

	sides, err := strconv.Atoi(matches[2])
	if err != nil {
		return diceRoll{}, false
	}

	modifier := 0
	if matches[4] != "" {
		parsedModifier, err := strconv.Atoi(matches[4])
		if err != nil {
			return diceRoll{}, false
		}
		if matches[3] == "-" {
			parsedModifier *= -1
		}
		modifier = parsedModifier
	}

	return rollDiceParts(count, sides, modifier)
}

func rollDiceParts(count int, sides int, modifier int) (diceRoll, bool) {
	if count < 1 || count > 20 || !validDiceSides(sides) || modifier < -1000 || modifier > 1000 {
		return diceRoll{}, false
	}

	rolls := make([]int, 0, count)
	total := modifier
	for range count {
		value, ok := secureDieRoll(sides)
		if !ok {
			return diceRoll{}, false
		}
		rolls = append(rolls, value)
		total += value
	}

	return diceRoll{
		Expression: formatDiceExpression(count, sides, modifier),
		Count:      count,
		Sides:      sides,
		Modifier:   modifier,
		Rolls:      rolls,
		Total:      total,
	}, true
}

func validDiceSides(sides int) bool {
	switch sides {
	case 4, 6, 8, 10, 12, 20, 100:
		return true
	default:
		return false
	}
}

func secureDieRoll(sides int) (int, bool) {
	value, err := rand.Int(rand.Reader, big.NewInt(int64(sides)))
	if err != nil {
		return 0, false
	}
	return int(value.Int64()) + 1, true
}

func formatDiceExpression(count int, sides int, modifier int) string {
	expression := strconv.Itoa(count) + "d" + strconv.Itoa(sides)
	if modifier > 0 {
		expression += "+" + strconv.Itoa(modifier)
	}
	if modifier < 0 {
		expression += strconv.Itoa(modifier)
	}
	return expression
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

func (h *Hub) updateMetricsLocked() {
	rooms := len(h.rooms)
	participants := 0
	pending := 0
	for _, room := range h.rooms {
		participants += len(room.participants)
		for client := range room.pending {
			if client.lobbyRequested {
				pending++
			}
		}
	}
	observability.SetRoomsActive(rooms)
	observability.SetParticipantsActive(participants)
	observability.SetLobbyPending(pending)
}
