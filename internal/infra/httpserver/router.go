package httpserver

import (
	"html/template"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"we_cam/internal/domain/room"
	"we_cam/internal/infra/config"
	"we_cam/internal/infra/database"
	"we_cam/internal/infra/realtime"
)

func NewRouter(cfg config.Config, pool *pgxpool.Pool) http.Handler {
	gin.SetMode(gin.ReleaseMode)

	router := gin.New()
	router.Use(gin.Logger(), gin.Recovery())

	templates := template.Must(template.ParseGlob("web/templates/*.html"))
	router.SetHTMLTemplate(templates)
	router.Static("/static", "web/static")

	roomService := room.NewService(database.NewRoomRepository(pool))
	handler := NewRoomHandler(roomService)
	hub := realtime.NewHub()

	router.GET("/", handler.Home)
	router.POST("/rooms", handler.Create)
	router.POST("/rooms/join", handler.Join)
	router.GET("/rooms/:code", handler.Show)
	router.GET("/ws/rooms/:code", func(ctx *gin.Context) {
		hub.Serve(ctx.Writer, ctx.Request, room.NormalizeCode(ctx.Param("code")))
	})

	_ = cfg
	return router
}
