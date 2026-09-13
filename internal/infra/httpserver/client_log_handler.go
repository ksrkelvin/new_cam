package httpserver

import (
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"

	"we_cam/internal/infra/observability"
)

type clientLogRequest struct {
	Room      string         `json:"room"`
	ClientID  string         `json:"clientId"`
	Level     string         `json:"level"`
	Event     string         `json:"event"`
	UserAgent string         `json:"userAgent"`
	Data      map[string]any `json:"data"`
}

func ClientLog(ctx *gin.Context) {
	var request clientLogRequest
	if err := ctx.ShouldBindJSON(&request); err != nil {
		ctx.Status(http.StatusBadRequest)
		return
	}

	observability.IncClientLogs()
	slog.Info(
		"browser event",
		"level", request.Level,
		"event", request.Event,
		"room", request.Room,
		"client_id", request.ClientID,
		"user_agent", request.UserAgent,
		"data", request.Data,
	)
	ctx.Status(http.StatusNoContent)
}
