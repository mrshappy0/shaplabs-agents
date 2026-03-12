---
applyTo: "**"
---

# Mastra Project Setup & Conventions

> Source of truth: `node_modules/@mastra/core/dist/docs/` — always verify APIs against embedded docs before writing code.

## Package manager

Mastra works with npm, pnpm, yarn, or bun. Whichever is chosen, use it consistently across the project — do not mix.

## Node.js requirement

Mastra requires **Node.js 20 or later**. Earlier versions will produce "command not found" errors for the `mastra` CLI binary.

## TypeScript configuration (required)

Mastra requires ESM module mode. CommonJS (`"module": "CommonJS"`) will fail at runtime.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- `"module": "ES2022"` and `"moduleResolution": "bundler"` are mandatory — do not change these.
- `"noEmit": true` keeps TypeScript as a type-checker only; Mastra handles its own build.

## Required package.json scripts

```json
{
  "scripts": {
    "dev": "mastra dev",
    "build": "mastra build"
  }
}
```

- `mastra dev` — starts the Mastra development server with Mastra Studio at `http://localhost:4111`
- `mastra build` — produces a production Hono server in `.mastra/`

## Environment variables

- Keep a `.env.example` committed to source control with all required variable names (no values).
- Keep the actual `.env` in `.gitignore` — never commit secrets.
- Mastra auto-detects provider API keys by convention (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_KEY`).

## Model string format

Always use `"provider/model-name"`. Never pass a bare model name.

```typescript
model: "openai/gpt-4o"
model: "anthropic/claude-3-5-sonnet-20241022"
model: "google/gemini-2.5-pro"
```

## Core packages

| Package | Purpose |
|---------|---------|
| `@mastra/core` | Required. Agents, Workflows, Tools, Mastra instance, MCP |
| `@mastra/memory` | Agent memory (message history, working memory, semantic recall) |
| `@mastra/libsql` | LibSQL/Turso storage adapter |
| `@mastra/loggers` | `PinoLogger` and other structured loggers |
| `@mastra/evals` | Scorers and `runEvals` for CI evaluation |
| `@mastra/observability` | Tracing, telemetry exporters, `SensitiveDataFilter` |
| `@mastra/mcp` | `MCPClient` and `MCPServer` |
| `@mastra/inngest` | Inngest workflow runner integration |
| `@mastra/auth` | Auth providers (JWT, Clerk, Supabase, Firebase, Auth0, WorkOS) |

## Zod

Mastra uses [Zod](https://zod.dev) extensively for tool input/output schemas, workflow step schemas, and structured agent output. Install `zod@^4` alongside `@mastra/core`.

## Gitignore conventions

The following should always be gitignored:

```
.env
.mastra/       # build output
*.db           # local SQLite databases (e.g. mastra.db)
```

## API verification discipline

Mastra APIs change frequently between versions. **Never rely on training-data memory for Mastra APIs.**
Before writing any Mastra code, verify against embedded docs:

```bash
# See what docs are available for the installed version
ls node_modules/@mastra/core/dist/docs/references/

# Read a specific doc
cat node_modules/@mastra/core/dist/docs/references/reference-configuration.md
```
