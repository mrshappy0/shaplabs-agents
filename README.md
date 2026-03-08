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

Mastra Studio opens at [http://localhost:4111](http://localhost:4111).

For Discord to reach your local server you need Tailscale Funnel running — see [docs/setup.md](docs/setup.md#tailscale-funnel).

## Register Discord slash commands

Run once (or any time you add a new command):

```bash
# Guild-scoped — instant, your server only
DISCORD_GUILD_ID=<your-server-id> npx tsx src/scripts/register-discord-commands.ts

# Global — takes up to 1 hour to propagate
npx tsx src/scripts/register-discord-commands.ts
```

Available slash commands:

| Command | What it does |
|---|---|
| `/docker-check` | Triggers a full update check + auto-applies safe updates |

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

## Further reading

- [docs/setup.md](docs/setup.md) — full setup guide for every service
- [docs/architecture.md](docs/architecture.md) — how all the pieces connect
