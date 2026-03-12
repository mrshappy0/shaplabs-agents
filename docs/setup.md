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
| `MASTRA_JWT_SECRET` | A 256-bit hex secret used to sign and verify JWT tokens. Generate one with `openssl rand -hex 32`. Guards all `/api/*` routes — the Discord and Inngest routes are public. See [Studio access](#studio-access) for how to generate a bearer token. |

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

> **This step is required before slash command registration.** Skipping it causes `403 Forbidden: Missing Access` when registering commands.

1. **OAuth2 → URL Generator** in the Discord Developer Portal
2. Scopes: `bot`, `applications.commands`
3. Bot Permissions: `Send Messages`, `Read Message History`, `Embed Links`, `Use Slash Commands`
4. Copy the generated URL, open it in a browser, and select your server

If you ever need to change permissions: regenerate the URL with the new permissions selected and visit it again — Discord updates the bot's role in your server immediately. You need to be a server admin to authorize new permissions; removing permissions can be done directly in Server Settings → Roles instead.

### Register slash commands

Use the Makefile targets — run any time you add or change a command:

```bash
# Dev bot — instant, guild-scoped
# Reads DISCORD_BOT_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID from .env
make register-guild

# Prod bot — instant, guild-scoped (recommended)
# Pass Unraid credentials inline; DISCORD_GUILD_ID is the same server, read from .env
TOKEN=<unraid-bot-token> APP_ID=<unraid-app-id> make register-prod-guild

# Prod bot — global (~1h propagation, only needed for public bots)
TOKEN=<unraid-bot-token> APP_ID=<unraid-app-id> make register-global
```

> **Easiest way for prod:** Use the GitHub Copilot prompt — open Command Palette → `Chat: Run Prompt` → **Register Prod Discord Slash Commands**. It asks for your token and app ID, shows the exact command, and waits for approval before executing.

Registration is idempotent — safe to re-run after adding or changing commands. Re-run any time you modify `src/scripts/register-discord-commands.ts`.

### Running two bots (dev vs prod)

This project supports two independent Discord apps:

| Bot | Scope | Channel | Command registration |
|---|---|---|---|
| Mac dev bot | Guild-scoped (instant) | Dev channel | `make register-guild` |
| Unraid prod bot | Guild-scoped (instant) | Prod channel | `TOKEN=... APP_ID=... make register-prod-guild` |

`DISCORD_GUILD_ID` is your Discord **server** ID — the same for both bots since they share the same server. Only the bot token and app ID differ between dev and prod.

Each bot only responds to its configured `DISCORD_CHANNEL_ID`, so even if both bots show `/docker-check` in the command picker, only the bot for that channel will act on it.

### Set the interactions endpoint

Once Tailscale Funnel is running (next section), set the **Interactions Endpoint URL** in the Discord Developer Portal:

- **General Information → Interactions Endpoint URL**: `https://<your-funnel-hostname>/api/discord`

Discord will send a verification ping — the server must be running for this to succeed.

---

## 3. Tailscale Funnel

Tailscale Funnel exposes your local Mastra server to the public internet so Discord can POST interaction events to it. This replaces a traditional reverse proxy or cloud deployment for development.

```bash
# Expose Mastra (port 4111) via Funnel (foreground — dev)
tailscale funnel 4111

# Persistent background service (production / Unraid)
tailscale funnel --bg 4111

# To stop
tailscale funnel --bg off 4111
```

This gives you a stable public HTTPS URL like `https://<machine-name>.<tailnet>.ts.net`. Use that as your Discord Interactions Endpoint URL.

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

## Studio access

Mastra Studio is a web dashboard for inspecting agents, memory threads, traces, and workflow runs. In **dev mode** (`pnpm dev`) it opens unauthenticated at [http://localhost:4111](http://localhost:4111). In **production** (Docker / `mastra start`) it is served at `/studio` and protected by JWT auth.

### Generating a JWT bearer token

You need a signed JWT to authenticate with the Studio UI and all protected API routes.

**1. Make sure `MASTRA_JWT_SECRET` is set** in your `.env`:

```bash
# Generate a secret (run once, copy the output into .env)
openssl rand -hex 32
```

**2. Generate a long-lived JWT** using Node.js:

```bash
node -e "
  const jwt = require('jsonwebtoken');
  const token = jwt.sign(
    { role: 'admin', sub: 'studio-user' },
    process.env.MASTRA_JWT_SECRET,
    { expiresIn: '365d' }
  );
  console.log(token);
"
```

> **Tip:** If `jsonwebtoken` isn't in your global node_modules, run `npx -y jsonwebtoken` first, or use the copy installed in the project's pnpm store:
> ```bash
> node -e "const jwt = require('$(pnpm store path)/v3/files/.../jsonwebtoken/...'); ..."
> ```
> The simplest approach: run `node` in the project directory (where `node_modules` exists) and `require('jsonwebtoken')` will resolve.

Copy the output token — it looks like `eyJhbGciOiJI...`.

### Configuring Studio to use the token

Studio runs as a browser SPA and stores its settings in `localStorage`, so you must configure each browser once:

1. Open Studio at `http://<host>:<port>/studio`
2. Click the **Settings** icon (gear) in the bottom-left corner
3. Under **Request Headers**, add a custom header:
   - **Header name:** `Authorization`
   - **Header value:** `Bearer <your-token>`
4. Save — Studio will reload and authenticate all API requests automatically

> The token persists in that browser's `localStorage`. If you clear site data or use a new browser, repeat steps 2–4.

### Docker / Unraid

In the Docker Compose deployment, Studio is available at `http://<unraid-ip>:4111/studio`. The `MASTRA_STUDIO_PATH` environment variable is set automatically by `docker-compose.yml` — no extra configuration needed. Follow the same steps above to generate a token and configure the browser.

---

## Data files

The app writes two local files at the project root:

| File | Description |
|---|---|
| `mastra.db` | SQLite database (LibSQL). Stores agent memory threads, traces, and workflow state. |
| `discord-pending.json` | Pending approval state for review-first containers. Entries expire after 24 hours. |

Both are safe to delete to reset state. They are gitignored.

---

## Running on Unraid (Docker Compose)

The image is published to Docker Hub (`o0atomos0o/mastra-app:latest`) and supports both `linux/amd64` (Unraid) and `linux/arm64` (Mac). No repo clone is needed on Unraid — Compose Manager pulls the image directly.

### Prerequisites

- Unraid's **Docker Compose** plugin (Community Applications → search "Compose Manager")
- Tailscale installed and authenticated on the Unraid host
- A filled-in `.env` file

### Steps

**1. Build and push the image from Mac** (do this whenever you change code):

```bash
make push
```

**2. Create the data directory on Unraid** (once):

```bash
mkdir -p /mnt/user/appdata/mastra
```

**3. Set up Compose Manager:**

- Unraid → Docker → **Compose Manager** → **Add New Stack**
- Name the stack exactly `mastra-app` (must match the Compose Manager project directory)
- Paste the contents of `docker-compose.yml` into the editor (**not** `docker-compose.override.yml` — that's for Mac only)
  - Clear any pre-populated content in the editor before pasting
- Save the stack

**4. Add your `.env` file** to the Compose Manager project directory:

```
/boot/config/plugins/compose.manager/projects/mastra-app/.env
```

(`DATABASE_URL`, `DISCORD_PENDING_PATH`, and `INNGEST_BASE_URL` are set automatically by `docker-compose.yml` — don't include them in `.env`.)

**5. Start the stack** in Compose Manager.

**6. Enable Tailscale Funnel** on the Unraid host (run once; persists across reboots):

```bash
# Note: port 443 is occupied by the Unraid WebGUI, so use 8443
tailscale funnel --bg --https=8443 4111
```

This gives you a stable public URL like `https://<unraid-hostname>.<tailnet>.ts.net:8443`.

**7. Set the Discord Interactions Endpoint URL:**

In the Discord Developer Portal → your Unraid app → **General Information → Interactions Endpoint URL**:

```
https://<unraid-tailscale-hostname>:8443/api/discord
```

Discord sends a verification ping — the stack must be running for it to succeed.

**8. Register slash commands for the Unraid bot** (from Mac):

```bash
TOKEN=<unraid-bot-token> APP_ID=<unraid-app-id> make register-prod-guild
```

Or use the GitHub Copilot prompt: Command Palette → `Chat: Run Prompt` → **Register Prod Discord Slash Commands** — it walks you through credentials and runs the command for you.

Remember to invite the bot to the server via OAuth2 URL Generator first (see [Discord setup](#2-discord-setup)).

### Updating to a new image

```bash
# 1. Build and push from Mac
make push

# 2. On Unraid — Compose Manager → mastra-app → Restart
#    (Compose Manager pulls the latest image on restart)
```

### Environment variables in Docker

These variables are automatically set by `docker-compose.yml` and override anything in `.env`:

| Variable | Value in Docker | Description |
|---|---|---|
| `DATABASE_URL` | `file:/data/mastra.db` | SQLite path inside the container |
| `DISCORD_PENDING_PATH` | `/data/discord-pending.json` | Pending approval state path |
| `INNGEST_BASE_URL` | `http://inngest:8288` | Points to the Inngest sidecar container |

The `/data` directory inside the container is mounted from `/mnt/user/appdata/mastra` on the host.

### Local Mac testing

A `docker-compose.override.yml` is included that overrides the image source to build from local source and uses `./data` for storage:

```bash
# On Mac — docker-compose.override.yml is auto-merged
make build      # builds local image
docker compose up
```

Create `./data/` first (or let Docker create it on first run).

---

## CI/CD (Makefile & planned GitHub Actions)

### Current workflow

All build and release operations are managed via `Makefile`. Run `make help` to see all targets.

| Target | What it does |
|---|---|
| `make push` | Build multi-platform image (arm64 + amd64) and push to Docker Hub |
| `make build` | Build locally for the current platform only (dev/testing) |
| `make register-guild` | Register slash commands guild-scoped — instant (Mac dev bot) |
| `make register-prod-guild` | Register slash commands guild-scoped — instant (Unraid prod bot) |
| `make register-global` | Register slash commands globally — ~1h propagation (rarely needed) |

**Typical deploy cycle:**
1. Make code changes
2. `make push` — builds and publishes the image
3. Compose Manager → Restart the `mastra-app` stack on Unraid
4. If slash commands changed: `TOKEN=... APP_ID=... make register-prod-guild`

> **Tip:** Use the GitHub Copilot prompt for prod registration — Command Palette → `Chat: Run Prompt` → **Register Prod Discord Slash Commands**.

### Planned: GitHub Actions

The goal is a `.github/workflows/deploy.yml` triggered on push to `main`:

```yaml
# Rough plan — not yet implemented
jobs:
  deploy:
    steps:
      - run: make push                          # build + push multi-platform image
      - run: <trigger Unraid stack restart>     # webhook or SSH
      - run: TOKEN=${{ secrets.UNRAID_DISCORD_BOT_TOKEN }}
               APP_ID=${{ secrets.UNRAID_DISCORD_APP_ID }}
               make register-prod-guild         # re-register slash commands (guild-scoped, instant)
```

Secrets needed in GitHub Actions: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `UNRAID_DISCORD_BOT_TOKEN`, `UNRAID_DISCORD_APP_ID`.
