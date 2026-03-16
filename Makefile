SHELL        := /bin/bash
.DEFAULT_GOAL := help

# ── Configuration ──────────────────────────────────────────────────────────────

REGISTRY    ?= ghcr.io/aaravshah
TAG         ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo latest)
COMPOSE      = docker compose
DB_URL      ?= postgresql://taskfire:taskfire@localhost:5432/taskfire

# ── Formatting helpers ────────────────────────────────────────────────────────

BOLD   := \033[1m
RESET  := \033[0m
GREEN  := \033[32m
YELLOW := \033[33m
CYAN   := \033[36m

.PHONY: help dev build push migrate logs stop clean test \
        infra worker-dev api-dev dashboard-dev install \
        test-worker test-api lint ps

# ── Help ──────────────────────────────────────────────────────────────────────

help:
	@echo ""
	@echo "  $(BOLD)Taskfire$(RESET)"
	@echo ""
	@echo "  $(CYAN)Development$(RESET)"
	@echo "    make dev          Start all services in development mode"
	@echo "    make infra        Start only Redis + Postgres (for local dev)"
	@echo "    make worker-dev   Run Go worker locally (requires infra)"
	@echo "    make api-dev      Run Node.js API locally (requires infra)"
	@echo "    make dashboard-dev Run React dashboard locally"
	@echo "    make install      Install all Node.js dependencies"
	@echo ""
	@echo "  $(CYAN)Docker$(RESET)"
	@echo "    make build        Build all Docker images"
	@echo "    make push         Push images to $(REGISTRY)"
	@echo "    make stop         Stop all running services"
	@echo "    make clean        Remove all containers, volumes and images"
	@echo ""
	@echo "  $(CYAN)Database$(RESET)"
	@echo "    make migrate      Run Postgres schema migrations"
	@echo ""
	@echo "  $(CYAN)Observability$(RESET)"
	@echo "    make logs         Tail logs from all services"
	@echo "    make ps           Show running containers"
	@echo ""
	@echo "  $(CYAN)Testing$(RESET)"
	@echo "    make test         Run all tests (worker + API)"
	@echo "    make test-worker  Run Go worker tests"
	@echo "    make test-api     Run Node.js API tests"
	@echo "    make lint         Lint all source trees"
	@echo ""

# ── Development ───────────────────────────────────────────────────────────────

dev:
	@echo "$(GREEN)▶  Starting all services in development mode…$(RESET)"
	$(COMPOSE) up --build --remove-orphans

infra:
	@echo "$(GREEN)▶  Starting infrastructure (Redis + Postgres)…$(RESET)"
	$(COMPOSE) up -d redis postgres
	@echo "$(YELLOW)   Waiting for services to be healthy…$(RESET)"
	@$(COMPOSE) exec postgres sh -c \
		'until pg_isready -U taskfire; do sleep 1; done' 2>/dev/null || true

worker-dev: infra
	@echo "$(GREEN)▶  Running Go worker locally…$(RESET)"
	cd worker && go run ./main.go

api-dev: infra
	@echo "$(GREEN)▶  Running Node.js API locally…$(RESET)"
	cd api && npm run dev

dashboard-dev:
	@echo "$(GREEN)▶  Running React dashboard locally…$(RESET)"
	cd dashboard && npm run dev

install:
	@echo "$(GREEN)▶  Installing Node.js dependencies…$(RESET)"
	cd api       && npm ci
	cd dashboard && npm ci

# ── Build ─────────────────────────────────────────────────────────────────────

build:
	@echo "$(GREEN)▶  Building all Docker images (tag: $(TAG))…$(RESET)"
	$(COMPOSE) build --parallel \
		--build-arg BUILD_TAG=$(TAG)

build-worker:
	@echo "$(GREEN)▶  Building Go worker binary…$(RESET)"
	cd worker && CGO_ENABLED=0 GOOS=linux \
		go build -ldflags="-s -w -X main.version=$(TAG)" \
		-o bin/taskfire-worker ./main.go

# ── Push ──────────────────────────────────────────────────────────────────────

push: build
	@echo "$(GREEN)▶  Pushing images to $(REGISTRY) (tag: $(TAG))…$(RESET)"
	docker tag taskfire-worker:latest    $(REGISTRY)/taskfire-worker:$(TAG)
	docker tag taskfire-api:latest       $(REGISTRY)/taskfire-api:$(TAG)
	docker tag taskfire-dashboard:latest $(REGISTRY)/taskfire-dashboard:$(TAG)
	docker push $(REGISTRY)/taskfire-worker:$(TAG)
	docker push $(REGISTRY)/taskfire-api:$(TAG)
	docker push $(REGISTRY)/taskfire-dashboard:$(TAG)
	@echo "$(GREEN)✓  Images pushed successfully$(RESET)"

# ── Database ──────────────────────────────────────────────────────────────────

migrate:
	@echo "$(GREEN)▶  Running Postgres schema migrations…$(RESET)"
	@if ! command -v psql &>/dev/null; then \
		echo "$(YELLOW)   psql not found locally — running via Docker…$(RESET)"; \
		$(COMPOSE) exec -T postgres psql -U taskfire -d taskfire \
			-f /docker-entrypoint-initdb.d/init.sql; \
	else \
		psql "$(DB_URL)" -f postgres/init.sql; \
	fi
	@echo "$(GREEN)✓  Migrations applied$(RESET)"

# ── Logs ──────────────────────────────────────────────────────────────────────

logs:
	$(COMPOSE) logs -f --tail=100

worker-logs:
	$(COMPOSE) logs -f --tail=100 worker

api-logs:
	$(COMPOSE) logs -f --tail=100 api

# ── Control ───────────────────────────────────────────────────────────────────

stop:
	@echo "$(YELLOW)▶  Stopping all services…$(RESET)"
	$(COMPOSE) stop

ps:
	$(COMPOSE) ps

# ── Cleanup ───────────────────────────────────────────────────────────────────

clean:
	@echo "$(YELLOW)▶  Removing containers, volumes and orphans…$(RESET)"
	$(COMPOSE) down -v --remove-orphans
	@echo "$(YELLOW)▶  Removing built Go binaries…$(RESET)"
	rm -rf worker/bin
	@echo "$(GREEN)✓  Clean complete$(RESET)"

# ── Tests ─────────────────────────────────────────────────────────────────────

test: test-worker test-api
	@echo "$(GREEN)✓  All tests passed$(RESET)"

test-worker:
	@echo "$(GREEN)▶  Running Go worker tests…$(RESET)"
	cd worker && go test -v -race -count=1 ./...

test-api:
	@echo "$(GREEN)▶  Running Node.js API tests…$(RESET)"
	cd api && npm test

# ── Lint ──────────────────────────────────────────────────────────────────────

lint:
	@echo "$(GREEN)▶  Linting Go worker…$(RESET)"
	cd worker && go vet ./...
	@echo "$(GREEN)▶  Linting Node.js API…$(RESET)"
	cd api && npm run lint 2>/dev/null || true
	@echo "$(GREEN)▶  Linting React dashboard…$(RESET)"
	cd dashboard && npm run lint 2>/dev/null || true
	@echo "$(GREEN)✓  Lint complete$(RESET)"
