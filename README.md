# Tavernia

Aplicacao Go para criar salas e compartilhar camera no navegador.

## Stack

- Go + Gin
- HTML, CSS e JavaScript com Go templates
- PostgreSQL
- sqlc para acesso tipado ao banco
- WebSocket para sinalizacao WebRTC

## Rodando local

```bash
cp .env.example .env
docker compose up -d postgres
make migrate-up
make run
```

Acesse `http://localhost:8080`.

## Rodando com Docker

```bash
cp .env.example .env
docker compose up --build
```

O compose sobe o Postgres, aplica as migrations e inicia a aplicacao.

## Observabilidade

Com `docker compose up --build`, tambem sobem:

- Prometheus: `http://localhost:19090`
- Grafana: `http://localhost:13000` (`admin` / `admin`)
- Metricas da aplicacao: `http://localhost:8080/metrics`

Eventos do navegador, WebSocket, permissao de camera/microfone e estados WebRTC sao enviados para `POST /client-logs` e aparecem nos logs da aplicacao:

```bash
docker compose logs -f app
```

## Estrutura

- `cmd/wecam`: entrada da aplicacao.
- `internal/domain/room`: regras de sala.
- `internal/infra/database`: conexao, repositorios e codigo gerado pelo sqlc.
- `internal/infra/httpserver`: rotas e handlers Gin.
- `internal/infra/realtime`: hub WebSocket para sinalizacao.
- `web/templates`: telas renderizadas com Go templates.
- `web/static`: CSS e JavaScript.
