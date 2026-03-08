IMAGE := o0atomos0o/mastra-app:latest

.PHONY: push build register-guild register-global help

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  push              Build multi-platform image (amd64 + arm64) and push to Docker Hub"
	@echo "  build             Build image locally for the current platform only (dev)"
	@echo "  register-guild    Register slash commands guild-scoped — instant (Mac dev bot)"
	@echo "                      Uses DISCORD_BOT_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID from .env"
	@echo "  register-global   Register slash commands globally — ~1h propagation (Unraid prod bot)"
	@echo "                      Pass credentials inline: TOKEN=... APP_ID=... make register-global"
	@echo ""
	@echo "Planned (not yet implemented):"
	@echo "  deploy            Push image + trigger Unraid stack restart via webhook"

# Build for both Mac (arm64) and Unraid (amd64) and push to Docker Hub
push:
	docker buildx build --platform linux/amd64,linux/arm64 -t $(IMAGE) --push .

# Build locally for the current machine only (faster, for dev testing)
build:
	docker compose build

# Register slash commands guild-scoped (instant) — Mac dev bot
# Reads credentials from .env automatically via dotenv in the script
register-guild:
	npx tsx src/scripts/register-discord-commands.ts

# Register slash commands globally (~1h propagation) — Unraid prod bot
# The bot must already be invited to the server via OAuth2 URL Generator first.
# Pass Unraid bot credentials inline so they don't overwrite your .env:
#   TOKEN=MTQ4M... APP_ID=1480302... make register-global
register-global:
	DISCORD_BOT_TOKEN=$(TOKEN) DISCORD_APP_ID=$(APP_ID) \
		npx tsx src/scripts/register-discord-commands.ts
