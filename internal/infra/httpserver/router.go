package httpserver

import (
	"html/template"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"we_cam/internal/domain/room"
	"we_cam/internal/infra/config"
	"we_cam/internal/infra/database"
	"we_cam/internal/infra/observability"
	"we_cam/internal/infra/realtime"
)

func NewRouter(cfg config.Config, pool *pgxpool.Pool) http.Handler {
	gin.SetMode(gin.ReleaseMode)

	router := gin.New()
	router.Use(gin.Logger(), gin.Recovery())

	templates := template.Must(template.ParseGlob("web/templates/*.html"))
	router.SetHTMLTemplate(templates)
	router.Use(func(ctx *gin.Context) {
		if strings.HasPrefix(ctx.Request.URL.Path, "/static/") {
			ctx.Header("Cache-Control", "no-store, max-age=0")
		}
		ctx.Next()
	})
	router.Static("/static", "web/static")
	router.StaticFile("/brand-logo.png", "web/7b2097c3-bb06-4ea8-beff-32926a1e87ce.png")
	router.StaticFile("/favicon.png", "web/7b2097c3-bb06-4ea8-beff-32926a1e87ce.png")
	router.StaticFile("/room-create-bg.png", "web/11e5e664-bd50-4efe-90cf-67661cc8d608.png")
	router.StaticFile("/room-call-bg.png", "web/08ce0f1d-bfc1-48f4-9c97-a616342cda13.png")
	router.GET("/metrics", gin.WrapH(http.HandlerFunc(observability.Handler)))
	router.POST("/client-logs", ClientLog)

	roomService := room.NewService(database.NewRoomRepository(pool))
	handler := NewRoomHandler(roomService)
	hub := realtime.NewHub(roomService)

	router.GET("/", handler.Home)
	router.POST("/rooms", handler.Create)
	router.POST("/rooms/join", handler.Join)
	router.GET("/rooms/:code", handler.Show)
	router.GET("/ws/rooms/:code", func(ctx *gin.Context) {
		code := room.NormalizeCode(ctx.Param("code"))
		joinedRoom, err := roomService.Join(ctx.Request.Context(), code)
		if err != nil {
			ctx.Status(http.StatusNotFound)
			return
		}
		ownerToken, _ := ctx.Cookie(ownerCookieName(code))
		guestToken := ctx.Query("guest_token")
		guestApproved, err := roomService.IsGuestApproved(ctx.Request.Context(), joinedRoom.Code, guestToken)
		if err != nil {
			ctx.Status(http.StatusInternalServerError)
			return
		}
		hub.Serve(ctx.Writer, ctx.Request, joinedRoom.Code, ownerToken == joinedRoom.OwnerToken, guestToken, guestApproved)
	})

	return router
}
