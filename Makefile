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

.PHONY: deploy deploy-deps update destroy

CDK_APP = deployment/.venv/bin/python3 deployment/app.py

deploy: deploy-deps
	cdk deploy MudDemo --app "$(CDK_APP)" --require-approval never

deploy-deps:
	bash -c 'test -d deployment/.venv || python3 -m venv deployment/.venv && deployment/.venv/bin/pip install -q -r deployment/requirements.txt'

update:
ifdef SHA
	aws ssm send-command \
		--instance-ids "$$(aws ec2 describe-instances --filters 'Name=tag:Name,Values=mud-game' --query 'Reservations[].Instances[].InstanceId' --output text)" \
		--document-name 'AWS-RunShellScript' \
		--parameters "{\"commands\":[\"bash /opt/mud/deployment/scripts/update.sh $(SHA)\"]}"
else
	aws ssm send-command \
		--instance-ids "$$(aws ec2 describe-instances --filters 'Name=tag:Name,Values=mud-game' --query 'Reservations[].Instances[].InstanceId' --output text)" \
		--document-name 'AWS-RunShellScript' \
		--parameters '{"commands":["bash /opt/mud/deployment/scripts/update.sh"]}'
endif

destroy: deploy-deps
	cdk destroy MudDemo --app "$(CDK_APP)"
