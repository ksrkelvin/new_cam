package observability

import (
	"fmt"
	"net/http"
	"sync/atomic"
)

var websocketConnectionsTotal atomic.Uint64
var websocketDisconnectsTotal atomic.Uint64
var websocketMessagesTotal atomic.Uint64
var roomsActive atomic.Int64
var participantsActive atomic.Int64
var lobbyPending atomic.Int64
var guestsApprovedTotal atomic.Uint64
var guestsRejectedTotal atomic.Uint64
var guestsKickedTotal atomic.Uint64
var clientLogsTotal atomic.Uint64

func IncWebsocketConnections() {
	websocketConnectionsTotal.Add(1)
}

func IncWebsocketDisconnects() {
	websocketDisconnectsTotal.Add(1)
}

func IncWebsocketMessages() {
	websocketMessagesTotal.Add(1)
}

func SetRoomsActive(value int) {
	roomsActive.Store(int64(value))
}

func SetParticipantsActive(value int) {
	participantsActive.Store(int64(value))
}

func SetLobbyPending(value int) {
	lobbyPending.Store(int64(value))
}

func IncGuestsApproved() {
	guestsApprovedTotal.Add(1)
}

func IncGuestsRejected() {
	guestsRejectedTotal.Add(1)
}

func IncGuestsKicked() {
	guestsKickedTotal.Add(1)
}

func IncClientLogs() {
	clientLogsTotal.Add(1)
}

func Handler(writer http.ResponseWriter, _ *http.Request) {
	writer.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	writeCounter(writer, "wecam_websocket_connections_total", "Total websocket connections accepted.", websocketConnectionsTotal.Load())
	writeCounter(writer, "wecam_websocket_disconnects_total", "Total websocket disconnects.", websocketDisconnectsTotal.Load())
	writeCounter(writer, "wecam_websocket_messages_total", "Total websocket messages received.", websocketMessagesTotal.Load())
	writeGauge(writer, "wecam_rooms_active", "Rooms currently active in memory.", roomsActive.Load())
	writeGauge(writer, "wecam_participants_active", "Participants currently connected.", participantsActive.Load())
	writeGauge(writer, "wecam_lobby_pending", "Guests currently waiting for approval.", lobbyPending.Load())
	writeCounter(writer, "wecam_guests_approved_total", "Total guests approved by owners.", guestsApprovedTotal.Load())
	writeCounter(writer, "wecam_guests_rejected_total", "Total guests rejected before joining.", guestsRejectedTotal.Load())
	writeCounter(writer, "wecam_guests_kicked_total", "Total guests removed from rooms.", guestsKickedTotal.Load())
	writeCounter(writer, "wecam_client_logs_total", "Total browser logs received.", clientLogsTotal.Load())
}

func writeCounter(writer http.ResponseWriter, name string, help string, value uint64) {
	fmt.Fprintf(writer, "# HELP %s %s\n", name, help)
	fmt.Fprintf(writer, "# TYPE %s counter\n", name)
	fmt.Fprintf(writer, "%s %d\n", name, value)
}

func writeGauge(writer http.ResponseWriter, name string, help string, value int64) {
	fmt.Fprintf(writer, "# HELP %s %s\n", name, help)
	fmt.Fprintf(writer, "# TYPE %s gauge\n", name)
	fmt.Fprintf(writer, "%s %d\n", name, value)
}
