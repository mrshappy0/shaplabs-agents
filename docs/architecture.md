# Architecture

How the pieces fit together.

## Overview

```
Discord Channel
    │
    ├─ User types a message ──────────────────────────────┐
    │                                                      ▼
    │                                          Discord Gateway (WebSocket)
    │                                          src/mastra/discord-gateway.ts
    │                                                      │
    ├─ User clicks /docker-check ─────────────────────────┤
    │                                                      │
    │  Discord POSTs to Tailscale Funnel URL               │
    │  (/api/discord)                                      │
    │       │                                              │
    │       ▼                                              │
    │  discord-route.ts                                    │
    │  (verifies Ed25519 sig)                              │
    │       │                                              │
    └───────┴──────────────────────────────────────────────┤
                                                           ▼
                                              dockerManagerAgent
                                              (gpt-4o, with Memory)
                                              Shared thread: discord-{channelId}-chat
                                                           │
                              ┌────────────────────────────┤
                              ▼                            ▼
                  dockerUpdateWorkflow         dockerApplyUpdatesWorkflow
                  (check for updates)          (apply confirmed updates)
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
               Unraid API  Docker    GitHub
               (GraphQL)  Registry  Releases
                              │
                              ▼
                  dockerClassifierAgent
                  (gpt-4o-mini, no tools)
                  reads changelogs → safe / reviewFirst / skip
                              │
                              ▼
                  Discord embed posted to channel
                  (buttons for reviewFirst items)

Inngest cron (daily 19:00 UTC)
    │
    └─▶ dockerCronWorkflow ──▶ dockerManagerAgent (same shared thread)
```

## Request flows

### Flow 1: User types a message in Discord

1. Discord Gateway (WebSocket, `discord-gateway.ts`) receives a `MESSAGE_CREATE` event
2. Filters: must be in `DISCORD_CHANNEL_ID`, must not be a bot, must have content
3. Calls `dockerManagerAgent.generate(message, { memory: { resource, thread } })`
4. Memory loads the last 20 messages from the shared thread — includes any recent check results
5. Agent replies; reply is posted back to the channel via the bot token

### Flow 2: `/docker-check` slash command

1. Discord POSTs to `https://<funnel>/api/discord`
2. `discord-route.ts` verifies the Ed25519 signature (required by Discord)
3. Responds immediately with a deferred message (Discord requires a response within 3 seconds)
4. Fires `handleDockerCheck` in `setImmediate` (fire-and-forget)
5. `dockerManagerAgent` runs `dockerUpdateWorkflow`, which:
   - **Step 1**: Lists all containers from Unraid GraphQL API
   - **Step 2**: Checks each against its Docker registry for a digest change
   - **Step 3**: Merges results — splits into: needs update, digest-pinned, up-to-date, errors
   - **Step 4**: Fetches GitHub release notes for containers that have updates
   - **Step 5**: `dockerClassifierAgent` reads changelogs and outputs structured JSON classification
6. Agent auto-applies `safeToUpdate` containers via `dockerApplyUpdatesWorkflow`
7. Posts results embed to Discord; if `reviewFirst` containers exist, posts approval buttons and saves state to `discord-pending.json`

### Flow 3: User clicks an approval button

1. Discord POSTs the button interaction to `/api/discord`
2. `discord-route.ts` decodes the `custom_id`: `apply_one:{runId}:{containerName}` or `apply_all:{runId}`
3. Looks up the pending state from `discord-pending.json` using `runId`
4. Fires `dockerApplyUpdatesWorkflow` for the selected container(s)
5. Apply workflow: preflight re-check → Unraid mutation → verification
6. Posts apply result embed to channel

### Flow 4: Inngest cron (daily)

1. Inngest fires `dockerCronWorkflow` at `0 19 * * *` (UTC)
2. Calls `dockerManagerAgent` with the same `resource`/`thread` as all other triggers
3. Full check + auto-apply + Discord report — identical to Flow 2

## Memory and conversation continuity

All four triggers share one Mastra Memory thread:

```
resource: 'discord'
thread:   'discord-{DISCORD_CHANNEL_ID}-chat'
```

This means:
- A cron check at noon writes its results into the thread
- When you type "update Radarr" at 3pm, the agent reads back and finds what the check found about Radarr
- `/docker-check` results are in the same window as chat messages
- The window is the last **20 messages** (configured in `docker-manager-agent.ts`)

## Security

| Concern | How it's handled |
|---|---|
| Discord interaction authenticity | Ed25519 signature verified on every POST to `/api/discord` using `DISCORD_PUBLIC_KEY` |
| Mastra REST API access | JWT auth (`MASTRA_JWT_SECRET`) — all `/api/*` routes require `Authorization: Bearer <jwt>` except `/api/discord` and `/api/inngest`. Studio is served at `/studio` (public SPA, but API calls still need the token). |
| Unraid API | API key only sent server-side; never exposed to Discord or the browser |
| Sensitive data in traces | `SensitiveDataFilter` redacts keys/tokens from Mastra observability traces |
| Discord pending state | `discord-pending.json` stored locally; entries expire after 24h; `runId` is a timestamp-based opaque ID |

## Key files

| File | Role |
|---|---|
| `src/mastra/index.ts` | Wires everything: Mastra instance, routes, gateway startup |
| `src/mastra/discord-gateway.ts` | Discord WebSocket Gateway — chat interface |
| `src/mastra/server/discord-route.ts` | Hono route handler for Discord slash commands and button interactions |
| `src/mastra/agents/docker-manager-agent.ts` | Primary agent: orchestrates workflows, talks to user, holds memory |
| `src/mastra/agents/docker-classifier-agent.ts` | LLM-only classifier: no tools, reads changelogs, outputs risk classification |
| `src/mastra/workflows/docker-update-workflow.ts` | 5-step check workflow (deterministic steps + one AI step) |
| `src/mastra/workflows/docker-apply-updates-workflow.ts` | 3-step apply workflow: preflight → mutate → verify |
| `src/mastra/workflows/docker-cron-workflow.ts` | Inngest cron wrapper (thin — just calls the manager agent) |
| `src/mastra/tools/docker-tools.ts` | All Unraid/registry/GitHub tool definitions |
| `src/mastra/tools/discord-tools.ts` | Discord embed builders for update and apply reports |
| `src/mastra/tools/discord-bot.ts` | Discord REST API helpers (postMessage, editMessage, buttons) |
| `src/mastra/tools/discord-pending.ts` | Read/write/expire pending approval state |
| `src/mastra/inngest/index.ts` | Inngest client configuration |
| `src/mastra/storage.ts` | LibSQL (SQLite) storage — memory threads, traces, workflow state |
| `src/scripts/register-discord-commands.ts` | One-shot slash command registration script |

## Technology choices

| Technology | Why |
|---|---|
| **Mastra** | Agent framework: handles LLM calls, Memory, tool routing, observability, workflow orchestration |
| **Inngest** | Durable cron scheduling and workflow execution with retries and a local dev UI |
| **LibSQL / SQLite** | Zero-config local storage for Memory and traces — file on disk, no separate DB process |
| **Discord Bot API + Gateway** | Bot token enables both slash commands (via HTTP interactions) and reading messages (via WebSocket Gateway) |
| **Tailscale Funnel** | Exposes the local server to Discord's webhook delivery without a cloud host or open firewall port |
| **Node.js built-in WebSocket** | Discord Gateway connection — no extra dependency needed on Node 22+ |
