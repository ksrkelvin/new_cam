package realtime

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"sync"

	"github.com/gorilla/websocket"
)

type Client struct {
	id          string
	roomCode    string
	conn        *websocket.Conn
	hub         *Hub
	writeMu     sync.Mutex
	isOwner     bool
	isApproved  bool
	guestToken  string
	displayName string
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

	for {
		var message signalMessage
		if err := c.conn.ReadJSON(&message); err != nil {
			c.hub.logger.Info("client websocket closed", "room", c.roomCode, "client", c.id, "error", err)
			return
		}
		message.From = c.id
		c.hub.logger.Debug("signal received", "room", c.roomCode, "from", c.id, "to", message.To, "type", message.Type)
		c.hub.handle(c, message)
	}
}

func (c *Client) send(message signalMessage) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := c.conn.WriteJSON(message); err != nil {
		log.Printf("send signal message: %v", err)
		return err
	}
	return nil
}

func randomID() string {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(buffer)
}
