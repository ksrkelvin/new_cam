FROM golang:1.26-alpine AS build

WORKDIR /app

COPY go.mod go.sum* ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /bin/wecam ./cmd/wecam

FROM alpine:3.22

WORKDIR /app

COPY --from=build /bin/wecam /bin/wecam
COPY web ./web

EXPOSE 8080

CMD ["/bin/wecam"]
