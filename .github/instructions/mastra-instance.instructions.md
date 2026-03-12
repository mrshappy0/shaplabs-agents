---
applyTo: "src/mastra/index.ts"
---

# Mastra Instance (`src/mastra/index.ts`)

> Source of truth: `node_modules/@mastra/core/dist/docs/references/reference-configuration.md`

## What this file is

`src/mastra/index.ts` is the mandatory entry point that `mastra dev` and `mastra build` scan for. It must export a named `mastra` constant as the `Mastra` instance.

```typescript
import { Mastra } from '@mastra/core';

export const mastra = new Mastra({
  // options...
});
```

## All top-level constructor options

| Option | Type | Purpose |
|--------|------|---------|
| `agents` | `Record<string, Agent>` | Register named agent instances |
| `workflows` | `Record<string, Workflow>` | Register named workflow instances |
| `tools` | `Record<string, Tool>` | Register tools for use across agents |
| `mcpServers` | `Record<string, MCPServerBase>` | Register MCP servers to expose to clients |
| `memory` | `Record<string, MastraMemory>` | Shared memory instances (most users set memory on agents directly) |
| `scorers` | `Record<string, Scorer>` | Shared scorer instances (most users set scorers on agents directly) |
| `processors` | `Record<string, Processor>` | Shared input/output processor instances |
| `storage` | `MastraStorage` | Storage adapter — required for memory and observability |
| `logger` | `IMastraLogger \| false` | Logging implementation; defaults to `ConsoleLogger` INFO in dev, WARN in prod |
| `observability` | `ObservabilityEntrypoint` | Tracing and telemetry configuration |
| `server` | `ServerConfig` | HTTP server options — port, host, custom routes, middleware, auth |
| `deployer` | `MastraDeployer` | Cloud deployment provider (Netlify, Vercel, etc.) |
| `gateways` | `Record<string, MastraModelGateway>` | Custom LLM provider gateways |
| `vectors` | `Record<string, MastraVector>` | Vector stores for RAG / semantic recall |

## `server` option (not a folder — a config object)

`server` configures the HTTP layer. Handler implementations should live outside `src/mastra/` (e.g., in `src/server/`) and be imported here.

```typescript
import { Mastra } from '@mastra/core';
import { registerApiRoute } from '@mastra/core/server';
import { myHandler } from '../server/my-route';

export const mastra = new Mastra({
  server: {
    port: 4111,           // default
    host: '0.0.0.0',
    apiRoutes: [
      registerApiRoute('/api/my-endpoint', {
        method: 'POST',
        handler: myHandler,
      }),
    ],
    middleware: [
      async (c, next) => {
        // global middleware
        await next();
      },
    ],
    auth: new MastraJwtAuth({ secret: process.env.JWT_SECRET! }),
  },
});
```

## Storage

Storage is required for agent memory and observability tracing. Pass a storage adapter at the `Mastra` instance level so all agents share it by default.

```typescript
import { LibSQLStore } from '@mastra/libsql';

storage: new LibSQLStore({
  id: 'mastra-storage',
  url: 'file:./mastra.db',      // local dev
  // url: process.env.DB_URL,   // production (Turso, etc.)
})
```

When running `mastra dev` alongside another process (e.g., Next.js), use an **absolute path** to ensure both processes share the same database file — relative paths resolve against each process's working directory.

## Observability

```typescript
import { Observability, DefaultExporter, SensitiveDataFilter } from '@mastra/observability';

observability: new Observability({
  configs: {
    default: {
      serviceName: 'my-app',
      exporters: [
        new DefaultExporter(), // persists traces to storage (visible in Mastra Studio)
      ],
      spanOutputProcessors: [
        new SensitiveDataFilter(), // redacts passwords, tokens, keys from spans
      ],
    },
  },
})
```

`DefaultExporter` requires a configured `storage`. For high-traffic production, prefer ClickHouse for the observability domain via composite storage.

## Logger

```typescript
import { PinoLogger } from '@mastra/loggers';

logger: new PinoLogger({ name: 'MyApp', level: 'info' })
// Set to false to disable logging entirely
```

Default: `ConsoleLogger` at INFO in development, WARN in production.

## Side effects in index.ts

Only start long-running processes (e.g., WebSocket gateways) **after** the `mastra` instance is exported, so Mastra Studio and the dev server can import the instance without side effects blocking startup.

```typescript
export const mastra = new Mastra({ ... });

// Start gateway after export
startMyGateway(mastra);
```
