ifneq (,$(wildcard .env))
include .env
export
endif

.DEFAULT_GOAL := dev

.PHONY: dev run db-up db-down migrate-up migrate-down sqlc test

dev: db-up migrate-up run

run:
	go run ./cmd/wecam

db-up:
	docker compose up -d postgres

db-down:
	docker compose down

migrate-up:
	docker compose run --rm migrate -path /migrations -database "$(DOCKER_DATABASE_URL)" up

migrate-down:
	docker compose run --rm migrate -path /migrations -database "$(DOCKER_DATABASE_URL)" down

sqlc:
	sqlc generate

test:
	go test ./...
