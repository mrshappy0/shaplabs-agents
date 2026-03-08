# Setup Guide

Everything you need to get the stack running from scratch. Follow the sections in order — each service depends on the previous one being configured.

## Prerequisites

- **Node.js ≥ 22.13** and **pnpm** installed
- An **Unraid** server with the [Unraid API](https://docs.unraid.net/unraid-api/introduction/) enabled
- A **Discord** account with Developer Mode on (User Settings → Advanced → Developer Mode)
- **Tailscale** installed on the machine running Mastra (for exposing the server to Discord)

---

## 1. Environment variables

```bash
cp .env.example .env
```

Fill in `.env`. Every variable is described below.

### OpenAI

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys). The classifier agent uses `gpt-4o-mini`; the manager agent uses `gpt-4o`. |

### Unraid API

| Variable | Description |
|---|---|
| `UNRAID_API_URL` | GraphQL endpoint: `http://<unraid-ip>/graphql` or `http://unraid.local/graphql`. If using Tailscale, use the Tailscale IP. |
| `UNRAID_API_KEY` | Create at **Unraid UI → Settings → Management Access → API Keys**. Give it a descriptive name like `mastra-bot`. |

### GitHub (optional but recommended)

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | Personal access token from [github.com/settings/tokens](https://github.com/settings/tokens). No scopes needed for public repos. Raises rate limit from 60 → 5000 req/hr. Without this, heavy checking sessions may hit the limit. |

### Docker Hub (optional)

| Variable | Description |
|---|---|
| `DOCKERHUB_USERNAME` | Docker Hub username. |
| `DOCKERHUB_TOKEN` | Access token from [hub.docker.com/settings/security](https://hub.docker.com/settings/security). Prevents `401 Unauthorized` on anonymous pulls for some images. |

### Discord bot

| Variable | Description |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token — see [Discord setup](#2-discord-setup) below. |
| `DISCORD_APP_ID` | Application ID from the Discord Developer Portal **General Information** page. |
| `DISCORD_PUBLIC_KEY` | Public Key from **General Information** — used to verify interaction signatures. |
| `DISCORD_CHANNEL_ID` | Right-click the target channel in Discord → **Copy Channel ID**. The bot posts here and listens for messages. |

### Mastra

| Variable | Description |
|---|---|
| `MASTRA_API_TOKEN` | A secret string you choose. Guards the Mastra REST API (`/api/*`). The Discord and Inngest routes are public — everything else requires `Authorization: Bearer <token>`. |

### Home Assistant MCP (optional)

| Variable | Description |
|---|---|
| `MCP_PROXY_PATH` | Path to the `mcp-proxy` binary if you're using the Home Assistant MCP integration. |
| `HOME_ASSISTANT_MCP_URL` | Your Home Assistant MCP server URL. |
| `HOME_ASSISTANT_ACCESS_TOKEN` | Long-lived Home Assistant access token. |

---

## 2. Discord setup

### Create the app and bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. Name it (e.g. "Mastra Bot"), create it
3. **General Information** tab → copy **Application ID** → `DISCORD_APP_ID`
4. **General Information** tab → copy **Public Key** → `DISCORD_PUBLIC_KEY`
5. **Bot** tab → **Reset Token** → copy it → `DISCORD_BOT_TOKEN`
6. **Bot** tab → **Privileged Gateway Intents** → turn on **Message Content Intent**
   > ⚠️ Without this, the bot receives message events but `content` is always empty — the chat interface won't work.

### Invite the bot to your server

1. **OAuth2 → URL Generator**
2. Scopes: `bot`, `applications.commands`
3. Bot Permissions: `Send Messages`, `Read Message History`, `Use Slash Commands`
4. Copy the generated URL, open it, and add the bot to your server

### Register slash commands

```bash
# Instant registration (guild-scoped — your server only)
# Right-click your server name → Copy Server ID to get DISCORD_GUILD_ID
DISCORD_GUILD_ID=<your-server-id> npx tsx src/scripts/register-discord-commands.ts

# Global registration (takes up to 1 hour)
npx tsx src/scripts/register-discord-commands.ts
```

### Set the interactions endpoint

Once Tailscale Funnel is running (next section), set the **Interactions Endpoint URL** in the Discord Developer Portal:

- **General Information → Interactions Endpoint URL**: `https://<your-funnel-hostname>/api/discord`

Discord will send a verification ping — the server must be running for this to succeed.

---

## 3. Tailscale Funnel

Tailscale Funnel exposes your local Mastra server to the public internet so Discord can POST interaction events to it. This replaces a traditional reverse proxy or cloud deployment for development.

```bash
# Expose Mastra (port 4111) via Funnel
tailscale funnel 4111
```

This gives you a stable public HTTPS URL like `https://<machine-name>.<tailnet>.ts.net`. Use that as your Discord Interactions Endpoint URL.

> **Note:** Funnel must be re-enabled after machine restarts. Consider adding it to your startup scripts.

To check the status:

```bash
tailscale funnel status
```

---

## 4. Inngest (cron scheduler)

Inngest drives the daily cron schedule and handles durable workflow execution.

```bash
# Install the Inngest CLI globally (once)
npm install -g inngest-cli

# Start the Inngest dev server (keep this running alongside Mastra)
npx inngest-cli@latest dev -u http://localhost:4111/api/inngest
```

The Inngest dev server UI opens at [http://localhost:8288](http://localhost:8288). You can inspect function runs, trigger workflows manually, and see cron schedules here.

The cron is configured in `src/mastra/workflows/docker-cron-workflow.ts`:

```
cron: '0 19 * * *'   →   Daily at 19:00 UTC (12:00 PM MST)
```

Change the cron expression there to adjust the schedule.

---

## 5. Running the full stack

Three processes need to be running:

```bash
# Terminal 1 — Inngest dev server
npx inngest-cli@latest dev -u http://localhost:4111/api/inngest

# Terminal 2 — Mastra (starts the agent server + Discord gateway WebSocket)
pnpm dev

# Terminal 3 — Tailscale Funnel (for Discord interactions)
tailscale funnel 4111
```

Once all three are up:
- `/docker-check` in Discord triggers a manual check
- Typing any message in the channel goes to the agent
- The daily cron fires automatically at 19:00 UTC

---

## Data files

The app writes two local files at the project root:

| File | Description |
|---|---|
| `mastra.db` | SQLite database (LibSQL). Stores agent memory threads, traces, and workflow state. |
| `discord-pending.json` | Pending approval state for review-first containers. Entries expire after 24 hours. |

Both are safe to delete to reset state. They are gitignored.

---

## Future: Running on Unraid

The goal is to run this as a Docker container on the same Unraid machine it manages. High-level plan:

1. **Build a Docker image** — `pnpm build` produces a `.build/` output; wrap it in a `node:22-alpine` image
2. **Run Inngest alongside** — either as a sidecar container or use Inngest Cloud (free tier) instead of the local dev server
3. **Tailscale in the container** — use a Tailscale auth key and the `tailscale/tailscale` sidecar or run `tailscaled` inside the container for Funnel
4. **Persist data** — mount a host path to `/app/mastra.db` and `/app/discord-pending.json` so state survives container restarts
5. **Env vars via Unraid template** — Unraid Community Applications templates support env var fields, so all secrets can be configured in the UI

This is not yet implemented — contributions welcome.
