---
applyTo: "src/mastra/**"
---

# Mastra Folder Structure

> Source of truth: embedded docs in `node_modules/@mastra/core/dist/docs/` — always check there before writing Mastra code.

## What `src/mastra/` is

`src/mastra/` is the **Mastra entry point** — the directory scanned by `mastra dev` / `mastra build`. It must contain only the primitives and config files that Mastra recognises. Everything else belongs outside it.

## Mastra-recognised primitives (folders inside `src/mastra/`)

| Folder | What goes here |
|--------|---------------|
| `agents/` | `Agent` instances — autonomous AI actors with instructions, a model, optional tools and memory |
| `workflows/` | `createWorkflow()` pipelines — structured, deterministic multi-step sequences |
| `tools/` | `createTool()` functions — typed, schema-validated capabilities agents call to reach external systems |
| `mcp/` | `MCPClient` / `MCPServer` instances — connect to or expose tools via the Model Context Protocol |
| `scorers/` | `createScorer()` definitions — quantified eval metrics for agent output quality |
| `public/` | Static assets — copied verbatim into `.mastra/output/` at build time, served at runtime |

## Required files inside `src/mastra/`

| File | Purpose |
|------|---------|
| `index.ts` | **Mandatory.** Exports the `Mastra` instance (`export const mastra = new Mastra({...})`). Registers agents, workflows, tools, storage, logger, server config, etc. |

Any additional top-level files (e.g., `storage.ts`) should be thin config/adapter files imported by `index.ts` — not application logic.

## What Mastra's `server` option is (and isn't)

`server` is a **constructor option** on `new Mastra({})`, not a folder primitive. It configures:

- `port` / `host` — HTTP server binding
- `apiRoutes` — custom Hono route handlers registered via `registerApiRoute()` from `@mastra/core/server`
- `middleware` — global request interceptors
- `auth` — authentication provider (JWT, Clerk, Supabase, Firebase, Auth0, WorkOS, …)
- `build` — Swagger UI, deploy options

Route *handler implementations* should live **outside** `src/mastra/` and be imported into `index.ts`. Mastra's docs say: "Routes can live in the same file as the Mastra instance but separating them helps keep configuration concise."

## What does NOT belong in `src/mastra/`

Do not add these inside `src/mastra/`:

- HTTP route handler implementations (Hono handlers, Express middleware)
- WebSocket / real-time gateway code
- Third-party webhook or bot infrastructure (Discord, Slack, Telegram, etc.)
- Generic utility/helper modules
- One-shot operational scripts
- Application business logic unrelated to a Mastra primitive

## Recommended repo-level layout

Mastra does not prescribe the layout outside `src/mastra/`, but the following is consistent with their guidance and keeps the Mastra directory pure:

```
<project-root>/
├── src/
│   ├── mastra/                  ← Mastra primitives ONLY (scanned by mastra dev/build)
│   │   ├── index.ts             ← export const mastra = new Mastra({...})
│   │   ├── agents/              ← Agent instances
│   │   ├── workflows/           ← createWorkflow() pipelines
│   │   ├── tools/               ← createTool() functions
│   │   ├── mcp/                 ← MCPClient / MCPServer instances
│   │   ├── scorers/             ← createScorer() definitions
│   │   └── public/              ← static assets served at runtime
│   │
│   ├── server/                  ← (app-specific) custom API route handlers,
│   │                               WebSocket gateways, webhook receivers
│   ├── utils/                   ← shared helpers used across src/
│   └── scripts/                 ← one-off operational scripts (CLI tools, seed data, etc.)
│
├── .env                         ← environment variables (never committed)
├── .env.example                 ← template for .env
├── package.json
└── tsconfig.json
```

## Registering custom routes correctly

Implement handlers in `src/server/`, import them into `src/mastra/index.ts`:

```typescript
// src/mastra/index.ts
import { Mastra } from '@mastra/core';
import { registerApiRoute } from '@mastra/core/server';
import { myRouteHandler } from '../server/my-route';

export const mastra = new Mastra({
  server: {
    apiRoutes: [
      registerApiRoute('/api/my-endpoint', {
        method: 'POST',
        handler: myRouteHandler,
      }),
    ],
  },
});
```

## TypeScript requirements

Mastra requires ES2022 module mode — CommonJS will fail at runtime.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler"
  }
}
```

## Model string format

Always use `"provider/model-name"` — never pass a bare model name:

```typescript
model: "openai/gpt-4o"
model: "anthropic/claude-3-5-sonnet-20241022"
model: "google/gemini-2.5-pro"
```

## Key rule summary

> If it is not an `Agent`, `Workflow`, `Tool`, `MCPClient`/`MCPServer`, `Scorer`, or a static asset — it does not belong inside `src/mastra/`.
