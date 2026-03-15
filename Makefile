.PHONY: up down build dev logs ps worker-logs api-logs clean

## Start all services
up:
	docker compose up -d

## Stop all services
down:
	docker compose down

## Build all images
build:
	docker compose build --parallel

## Start infra (redis + postgres) for local development
infra:
	docker compose up -d redis postgres

## Run worker locally
worker-dev:
	cd worker && go run ./main.go

## Run API locally
api-dev:
	cd api && npm run dev

## Run dashboard locally
dashboard-dev:
	cd dashboard && npm run dev

## Install all dependencies
install:
	cd api && npm install
	cd dashboard && npm install

## Follow all logs
logs:
	docker compose logs -f

## Follow worker logs
worker-logs:
	docker compose logs -f worker

## Follow api logs
api-logs:
	docker compose logs -f api

## Show running containers
ps:
	docker compose ps

## Remove volumes (destructive)
clean:
	docker compose down -v --remove-orphans

## Run Go tests
test-worker:
	cd worker && go test ./...

## Build Go worker binary
build-worker:
	cd worker && go build -o bin/taskfire-worker ./main.go
