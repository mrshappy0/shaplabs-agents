# AGENTS.md

This document provides guidance for AI coding agents working in this repository.

## CRITICAL: Mastra Skill Required

**BEFORE doing ANYTHING with Mastra code or answering Mastra questions, load the Mastra skill FIRST.**

See [Mastra Skills section](#mastra-skills) for loading instructions.

## Project Overview

This is a **Mastra** homelab automation project written in TypeScript. It manages Docker container updates on an Unraid server and communicates through a dedicated Discord channel.

**Stack:** Mastra · Inngest (cron) · LibSQL/SQLite (storage) · Discord Bot API + Gateway · Tailscale Funnel · OpenAI (gpt-4o / gpt-4o-mini)

See [docs/architecture.md](docs/architecture.md) for how the pieces connect.
See [docs/setup.md](docs/setup.md) for environment variables and service configuration.

## Commands

Use these commands to interact with the project.

### Installation

```bash
pnpm install
```

### Development

Three processes must run simultaneously:

```bash
# Terminal 1 — Inngest dev server (cron + workflow runner)
npx inngest-cli@latest dev -u http://localhost:4111/api/inngest

# Terminal 2 — Mastra (agent server + Discord Gateway WebSocket)
pnpm dev

# Terminal 3 — Tailscale Funnel (exposes /api/discord to Discord's servers)
tailscale funnel 4111
```

Mastra Studio: [http://localhost:4111](http://localhost:4111)
Inngest UI: [http://localhost:8288](http://localhost:8288)

### Register Discord slash commands

```bash
# Dev bot — guild-scoped, instant (reads from .env)
make register-guild

# Prod bot — guild-scoped, instant (recommended)
TOKEN=<unraid-bot-token> APP_ID=<unraid-app-id> make register-prod-guild
```

Or use the GitHub Copilot prompt for prod: Command Palette → `Chat: Run Prompt` → **Register Prod Discord Slash Commands** — it asks for credentials, shows the exact command, and waits for approval.

Re-run whenever you add or change a slash command in `src/scripts/register-discord-commands.ts`. `DISCORD_GUILD_ID` is always read from `.env` — it's the same server for both bots.

### Build

In order to build a production-ready server, run the `build` script:

```bash
pnpm build
```

## Project Structure

Folders organize your agent's resources, like agents, tools, and workflows.

| Folder | Description |
|---|---|
| `src/mastra` | Entry point for all Mastra-related code and configuration. |
| `src/mastra/agents` | Define and configure your agents — their behavior, goals, and tools. |
| `src/mastra/workflows` | Define multi-step workflows that orchestrate agents and tools together. |
| `src/mastra/tools` | Create reusable tools that your agents can call. |
| `src/mastra/mcp` | (Optional) Implement custom MCP servers to share your tools with external agents. |
| `src/mastra/scorers` | (Optional) Define scorers for evaluating agent performance over time. |
| `src/mastra/public` | (Optional) Contents are copied into the `.build/output` directory during the build process, making them available for serving at runtime. |

### Top-level files

Top-level files define how your Mastra project is configured, built, and connected to its environment.

| File | Description |
|---|---|
| `src/mastra/index.ts` | Central entry point where you configure and initialize Mastra. |
| `.env.example` | Template for environment variables — copy and rename to `.env` to add your secret keys. |
| `package.json` | Defines project metadata, dependencies, and available npm scripts. |
| `tsconfig.json` | Configures TypeScript options such as path aliases, compiler settings, and build output. |

### This project's files

| Path | Description |
|---|---|
| `src/mastra/index.ts` | Mastra instance, server config, auth, custom routes, Discord gateway startup |
| `src/mastra/discord-gateway.ts` | Discord WebSocket Gateway — listens for messages, routes to agent |
| `src/mastra/storage.ts` | LibSQL (SQLite) storage adapter |
| `src/mastra/agents/` | `docker-manager-agent` (orchestrator, has Memory), `docker-classifier-agent` (LLM-only, no tools) |
| `src/mastra/workflows/` | `docker-update-workflow` (check), `docker-apply-updates-workflow` (apply), `docker-cron-workflow` (Inngest cron) |
| `src/mastra/tools/` | Docker/Unraid/GitHub tools, Discord embed builders, Discord REST helpers, pending approval state |
| `src/mastra/server/discord-route.ts` | Hono route: verifies Discord Ed25519 signatures, handles slash commands and button clicks |
| `src/mastra/inngest/index.ts` | Inngest client |
| `src/mastra/mcp/` | Optional Home Assistant MCP client |
| `src/scripts/register-discord-commands.ts` | One-shot Discord slash command registration |
| `docs/setup.md` | Full setup guide |
| `docs/architecture.md` | System architecture and request flows |

## Key conventions

- **Shared memory thread**: all triggers (chat, `/docker-check`, cron) use `resource: 'discord'` + `thread: 'discord-{channelId}-chat'` so the agent has continuous context across all entry points
- **Always verify Mastra APIs** against embedded docs (`node_modules/@mastra/*/dist/`) — APIs change frequently
- **`pnpm`** is the package manager (not `npm`)
- **`.env`** is never committed — copy `.env.example` and fill it in
- **`mastra.db`** and **`discord-pending.json`** are local runtime files at the project root — gitignored, safe to delete to reset state

## Mastra Skills

Skills are modular capabilities that extend agent functionalities. They provide pre-built tools, integrations, and workflows that agents can leverage to accomplish tasks more effectively.

This project has skills installed for the following agents:

- Github Copilot

### Loading Skills

1. **Load the Mastra skill FIRST** - Use `/mastra` command or Skill tool
2. **Never rely on cached knowledge** - Mastra APIs change frequently between versions
3. **Always verify against current docs** - The skill provides up-to-date documentation

**Why this matters:** Your training data about Mastra is likely outdated. Constructor signatures, APIs, and patterns change rapidly. Loading the skill ensures you use current, correct APIs.

Skills are automatically available to agents in your project once installed. Agents can access and use these skills without additional configuration.

## Resources

- [Mastra Documentation](https://mastra.ai/llms.txt)
- [Mastra .well-known skills discovery](https://mastra.ai/.well-known/skills/index.json)
