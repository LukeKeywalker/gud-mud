.PHONY: up down logs test venv sync-client load

venv:
	@test -d .venv || python3 -m venv .venv
	.venv/bin/pip install -q -e "server[dev]"

test: venv
	.venv/bin/python -m pytest server/tests -v

sync-client:
	rm -rf client/static/game_core
	cp -r shared/game_core client/static/game_core

up: sync-client
	docker compose build
	docker compose up -d

down:
	docker compose down

reseed: sync-client
	docker compose down -v
	docker compose build
	docker compose up -d

logs:
	docker compose logs -f --tail=100

load:
	docker compose -f docker-compose.verify.yml exec -w /app/server server python -m loadtest.load $(LOAD_ARGS)
