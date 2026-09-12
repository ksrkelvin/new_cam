package httpserver

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"we_cam/internal/domain/room"
)

type RoomHandler struct {
	service *room.Service
}

func NewRoomHandler(service *room.Service) *RoomHandler {
	return &RoomHandler{service: service}
}

func (h *RoomHandler) Home(ctx *gin.Context) {
	ctx.HTML(http.StatusOK, "home.html", gin.H{"Error": ""})
}

func (h *RoomHandler) Create(ctx *gin.Context) {
	createdRoom, err := h.service.Create(ctx.Request.Context())
	if err != nil {
		ctx.HTML(http.StatusInternalServerError, "home.html", gin.H{"Error": "Nao foi possivel criar a sala."})
		return
	}
	ctx.Redirect(http.StatusSeeOther, "/rooms/"+createdRoom.Code)
}

func (h *RoomHandler) Join(ctx *gin.Context) {
	joinedRoom, err := h.service.Join(ctx.Request.Context(), ctx.PostForm("code"))
	if errors.Is(err, room.ErrRoomNotFound) {
		ctx.HTML(http.StatusNotFound, "home.html", gin.H{"Error": "Sala nao encontrada."})
		return
	}
	if err != nil {
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
		ctx.HTML(http.StatusInternalServerError, "home.html", gin.H{"Error": "Erro ao abrir sala."})
		return
	}
	ctx.HTML(http.StatusOK, "room.html", gin.H{"Room": joinedRoom})
}
