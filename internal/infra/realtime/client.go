package realtime

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"we_cam/internal/infra/observability"
)

const (
	websocketPongWait   = 70 * time.Second
	websocketPingPeriod = 30 * time.Second
	websocketWriteWait  = 10 * time.Second
)

type Client struct {
	id             string
	roomCode       string
	conn           *websocket.Conn
	hub            *Hub
	writeMu        sync.Mutex
	isOwner        bool
	isApproved     bool
	lobbyRequested bool
	guestToken     string
	displayName    string
}

func NewClient(roomCode string, conn *websocket.Conn, hub *Hub, isOwner bool, guestToken string, isGuestApproved bool) *Client {
	return &Client{
		id:         randomID(),
		roomCode:   roomCode,
		conn:       conn,
		hub:        hub,
		isOwner:    isOwner,
		isApproved: isOwner || isGuestApproved,
		guestToken: guestToken,
	}
}

func (c *Client) Run() {
	defer func() {
		c.hub.unregister(c)
		_ = c.conn.Close()
	}()

	c.conn.SetReadLimit(64 * 1024)
	_ = c.conn.SetReadDeadline(time.Now().Add(websocketPongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(websocketPongWait))
	})

	stopPing := make(chan struct{})
	defer close(stopPing)
	go c.keepAlive(stopPing)

	for {
		var message signalMessage
		if err := c.conn.ReadJSON(&message); err != nil {
			c.hub.logger.Info("client websocket closed", "room", c.roomCode, "client", c.id, "error", err)
			return
		}
		observability.IncWebsocketMessages()
		message.From = c.id
		c.hub.logger.Debug("signal received", "room", c.roomCode, "from", c.id, "to", message.To, "type", message.Type)
		c.hub.handle(c, message)
	}
}

func (c *Client) send(message signalMessage) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(websocketWriteWait))
	if err := c.conn.WriteJSON(message); err != nil {
		log.Printf("send signal message: %v", err)
		_ = c.conn.Close()
		return err
	}
	return nil
}

func (c *Client) keepAlive(stop <-chan struct{}) {
	ticker := time.NewTicker(websocketPingPeriod)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			c.writeMu.Lock()
			_ = c.conn.SetWriteDeadline(time.Now().Add(websocketWriteWait))
			err := c.conn.WriteMessage(websocket.PingMessage, nil)
			c.writeMu.Unlock()
			if err != nil {
				_ = c.conn.Close()
				return
			}
		case <-stop:
			return
		}
	}
}

func randomID() string {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(buffer)
}
