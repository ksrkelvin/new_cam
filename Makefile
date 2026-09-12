ifneq (,$(wildcard .env))
include .env
export
endif

.PHONY: run db-up db-down migrate-up migrate-down sqlc test

run:
	go run ./cmd/wecam

db-up:
	docker compose up -d postgres

db-down:
	docker compose down

migrate-up:
	migrate -path db/migrations -database "$(DATABASE_URL)" up

migrate-down:
	migrate -path db/migrations -database "$(DATABASE_URL)" down

sqlc:
	sqlc generate

test:
	go test ./...
