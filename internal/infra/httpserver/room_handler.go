package httpserver

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"we_cam/internal/domain/room"
	"we_cam/internal/infra/config"
)

type RoomHandler struct {
	service        *room.Service
	iceServersJSON string
}

func NewRoomHandler(service *room.Service, cfg config.Config) *RoomHandler {
	return &RoomHandler{service: service, iceServersJSON: normalizedICEServersJSON(cfg.ICEServersJSON)}
}

func (h *RoomHandler) Home(ctx *gin.Context) {
	ctx.HTML(http.StatusOK, "home.html", gin.H{"Error": ""})
}

func (h *RoomHandler) Create(ctx *gin.Context) {
	createdRoom, err := h.service.Create(ctx.Request.Context(), ctx.PostForm("name"))
	if err != nil {
		slog.Error("create room failed", "error", err)
		ctx.HTML(http.StatusInternalServerError, "home.html", gin.H{"Error": "Nao foi possivel criar a sala."})
		return
	}
	setOwnerCookie(ctx, createdRoom.Code, createdRoom.OwnerToken)
	ctx.Redirect(http.StatusSeeOther, "/rooms/"+createdRoom.Code)
}

func (h *RoomHandler) Join(ctx *gin.Context) {
	joinedRoom, err := h.service.Join(ctx.Request.Context(), ctx.PostForm("code"))
	if errors.Is(err, room.ErrRoomNotFound) {
		ctx.HTML(http.StatusNotFound, "home.html", gin.H{"Error": "Sala nao encontrada."})
		return
	}
	if err != nil {
		slog.Error("join room failed", "error", err)
		ctx.HTML(http.StatusInternalServerError, "home.html", gin.H{"Error": "Erro ao procurar sala."})
		return
	}
	ctx.Redirect(http.StatusSeeOther, "/rooms/"+joinedRoom.Code)
}

func (h *RoomHandler) Show(ctx *gin.Context) {
	joinedRoom, err := h.service.Join(ctx.Request.Context(), ctx.Param("code"))
	if errors.Is(err, room.ErrRoomNotFound) {
		ctx.HTML(http.StatusNotFound, "home.html", gin.H{"Error": "Sala nao encontrada."})
		return
	}
	if err != nil {
		slog.Error("show room failed", "error", err)
		ctx.HTML(http.StatusInternalServerError, "home.html", gin.H{"Error": "Erro ao abrir sala."})
		return
	}
	ownerToken, _ := ctx.Cookie(ownerCookieName(joinedRoom.Code))
	ctx.HTML(http.StatusOK, "room.html", gin.H{
		"Room":           joinedRoom,
		"IsOwner":        ownerToken == joinedRoom.OwnerToken,
		"ICEServersJSON": h.iceServersJSON,
	})
}

func normalizedICEServersJSON(rawJSON string) string {
	var servers []map[string]any
	if err := json.Unmarshal([]byte(rawJSON), &servers); err != nil || len(servers) == 0 {
		slog.Warn("invalid ICE_SERVERS_JSON, using default STUN", "error", err)
		return `[{"urls":"stun:stun.l.google.com:19302"}]`
	}
	normalized, err := json.Marshal(servers)
	if err != nil {
		slog.Warn("marshal ICE_SERVERS_JSON failed, using default STUN", "error", err)
		return `[{"urls":"stun:stun.l.google.com:19302"}]`
	}
	return string(normalized)
}

func setOwnerCookie(ctx *gin.Context, roomCode string, ownerToken string) {
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     ownerCookieName(roomCode),
		Value:    ownerToken,
		Path:     "/",
		Expires:  time.Now().Add(30 * 24 * time.Hour),
		MaxAge:   30 * 24 * 60 * 60,
		SameSite: http.SameSiteLaxMode,
	})
}

func ownerCookieName(roomCode string) string {
	return "wecam_owner_" + roomCode
}
