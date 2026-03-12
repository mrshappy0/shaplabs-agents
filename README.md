# homelab-mastra

A [Mastra](https://mastra.ai/) AI agent that manages Docker container updates on an Unraid homelab server and communicates via a dedicated Discord channel.

## What it does

- **Checks for Docker updates** — queries the Unraid GraphQL API, checks Docker Hub / GHCR registries, fetches GitHub release notes
- **Classifies each update** — an LLM agent reads changelogs and decides: `safeToUpdate` (auto-applies), `reviewFirst` (needs your approval), or `skip` (pre-release/draft)
- **Posts results to Discord** — colour-coded embeds with per-container approval buttons for anything flagged for review
- **Listens to your messages** — you can have a natural language conversation with the agent directly in the Discord channel; it remembers the last check and can apply updates on your say-so
- **Runs on a schedule** — Inngest cron fires daily at 12:00 PM MST; safe updates apply automatically, review items appear in Discord waiting for you

## Quick start

```bash
# 1. Install dependencies
pnpm install

# 2. Copy and fill in env vars
cp .env.example .env
# edit .env — see docs/setup.md for what each var does

# 3. Start the Inngest dev server (separate terminal)
npx inngest-cli@latest dev -u http://localhost:4111/api/inngest

# 4. Start Mastra
pnpm dev
```

Mastra Studio opens at [http://localhost:4111](http://localhost:4111). In production (Docker), Studio is at `/studio` and requires a JWT bearer token — see [docs/setup.md §Studio access](docs/setup.md#studio-access).

For Discord to reach your local server you need Tailscale Funnel running — see [docs/setup.md](docs/setup.md#tailscale-funnel).

## Register Discord slash commands

Run once (or any time you add or change a command):

```bash
# Dev bot — guild-scoped, instant
make register-guild

# Prod bot (Unraid) — guild-scoped, instant (recommended)
TOKEN=<unraid-bot-token> APP_ID=<unraid-app-id> make register-prod-guild

# Prod bot (Unraid) — global, ~1h propagation
TOKEN=<unraid-bot-token> APP_ID=<unraid-app-id> make register-global
```

> **Tip:** Use the GitHub Copilot prompt for prod registration — open Command Palette → `Chat: Run Prompt` → **Register Prod Discord Slash Commands**. It walks you through credentials, shows the exact command, and waits for your approval before running.

> **Before registering:** The bot must be invited to the server first via the OAuth2 URL Generator — otherwise you'll get `403 Forbidden: Missing Access`. See [docs/setup.md §Discord setup](docs/setup.md#2-discord-setup).

Available slash commands:

| Command | What it does |
|---|---|
| `/docker-check` | Triggers a full update check + auto-applies safe updates |
| `/clear` | Deletes all messages in the channel and resets bot memory |

You can also just **type in the channel** — the bot reads every message and responds like a chat interface.

## Project layout

```
src/mastra/
  index.ts                    # Mastra instance, routes, gateway startup
  discord-gateway.ts          # Discord WebSocket listener (chat interface)
  storage.ts                  # LibSQL (SQLite) storage adapter
  agents/
    docker-classifier-agent.ts  # Classifies update risk from changelogs (no tools)
    docker-manager-agent.ts     # Orchestrates check + apply workflows, talks to user
    weather-agent.ts            # Example agent (not used in production)
  workflows/
    docker-update-workflow.ts   # 5-step check: list → registry → merge → changelog → classify
    docker-apply-updates-workflow.ts  # 3-step apply: preflight → update → verify
    docker-cron-workflow.ts     # Inngest cron wrapper (daily at 19:00 UTC)
  tools/
    docker-tools.ts             # Unraid API, Docker registry, GitHub release tools
    discord-tools.ts            # Discord embed formatters (update report, apply report)
    discord-bot.ts              # Discord REST API helpers (post, edit, buttons)
    discord-pending.ts          # Pending approval state (JSON file, 24h TTL)
  server/
    discord-route.ts            # Hono route: verifies Discord signatures, handles interactions
  scripts/
    register-discord-commands.ts  # One-shot slash command registration
```

## Build & Deploy

A `Makefile` drives the build and release workflow. Run `make help` to see all targets.

### Building and pushing the image

```bash
make push    # multi-platform build (arm64 + amd64) → Docker Hub
make build   # local build only (faster, for dev/testing)
```

`make push` is the step you run from Mac after any code change. The image (`o0atomos0o/mastra-app:latest`) is multi-platform so it runs on both Mac (ARM64) and Unraid (AMD64). After pushing, restart the stack on Unraid (Compose Manager → Restart) to pull the new image.

### Registering slash commands

See the [Register Discord slash commands](#register-discord-slash-commands) section above.

### Planned: GitHub Actions CI/CD

The goal is a `.github/workflows/deploy.yml` that automatically runs on push to `main`:

1. `make push` — build and publish the multi-platform image to Docker Hub
2. Trigger Unraid to pull the new image (webhook or Compose Manager restart)
3. `make register-global` — re-register Unraid bot slash commands with prod credentials

Until then, run `make push` locally and restart the Unraid stack manually.

## Deploying to Unraid

A `Dockerfile` and `docker-compose.yml` are included. Inngest runs as a sidecar container; data is persisted to `/mnt/user/appdata/mastra` on the host. The image is published to Docker Hub — no repo clone needed on Unraid.

**Workflow:**
1. Build and push from Mac: `make push`
2. Add the stack in Unraid → Compose Manager (paste `docker-compose.yml`, without `override.yml`)
3. Place your `.env` at `/boot/config/plugins/compose.manager/projects/mastra-app/.env`
4. Start the stack
5. Enable Tailscale Funnel on Unraid: `tailscale funnel --bg --https=8443 4111`
6. Set the Discord **Interactions Endpoint URL** to `https://<unraid-tailscale-hostname>:8443/api/discord`

See [docs/setup.md](docs/setup.md#running-on-unraid-docker-compose) for the full guide.

A `docker-compose.override.yml` is included for local Mac testing — Docker Compose auto-merges it and uses `./data` instead of the Unraid path.

## Further reading

- [docs/setup.md](docs/setup.md) — full setup guide for every service and Docker deployment
- [docs/architecture.md](docs/architecture.md) — how all the pieces connect
