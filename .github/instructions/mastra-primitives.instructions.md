---
applyTo: "src/mastra/{agents,workflows,tools,mcp,scorers}/**"
---

# Mastra Primitives — Authoring Conventions

> Source of truth: `node_modules/@mastra/core/dist/docs/references/` — always verify APIs against embedded docs.

---

## Agents (`src/mastra/agents/`)

Agents are autonomous AI actors. They reason about a goal, decide which tools to call, and iterate until they produce a final answer.

### Minimal agent

```typescript
import { Agent } from '@mastra/core/agent';

export const myAgent = new Agent({
  id: 'my-agent',           // stable, kebab-case identifier
  name: 'My Agent',         // human-readable label
  instructions: 'You are a helpful assistant.',
  model: 'openai/gpt-4o',   // always "provider/model-name"
});
```

### With tools and memory

```typescript
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { myTool } from '../tools/my-tool';

export const myAgent = new Agent({
  id: 'my-agent',
  name: 'My Agent',
  instructions: 'You are a helpful assistant. Use myTool when ...',
  model: 'openai/gpt-4o',
  tools: { myTool },
  memory: new Memory({
    options: { lastMessages: 20 },
  }),
});
```

### Conventions

- One agent per file, named after the agent (e.g., `my-agent.ts` exports `myAgent`).
- Use `id` in `kebab-case`; use `name` for human display.
- Mention each tool's purpose in `instructions` so the model knows when to call it.
- Export any constants the rest of the app needs from the agent file (e.g., prompt strings).
- Use memory at the agent level unless you need shared memory across agents — in that case register on the `Mastra` instance.

### When to use an agent vs. a workflow

| Scenario | Use |
|----------|-----|
| Open-ended, requires reasoning and decision-making | **Agent** |
| Fixed sequence of steps with known data flow | **Workflow** |
| Multiple structured stages with branching / parallelism | **Workflow** |

---

## Tools (`src/mastra/tools/`)

Tools give agents capabilities beyond language generation — fetching APIs, querying databases, running code.

### Tool anatomy

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const myTool = createTool({
  id: 'my-tool',                        // stable, kebab-case
  description: 'Short, clear description of what this tool does and when to use it.',
  inputSchema: z.object({
    param: z.string().describe('Description of this parameter'),
  }),
  outputSchema: z.object({
    result: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { param } = inputData;
    // ... do work ...
    return { result: 'value' };
  },
});
```

### Conventions

- One logical concern per file (e.g., `weather-tool.ts`, `github-tools.ts`).
- Keep `description` focused on primary use case — the agent uses it to decide when to call the tool.
- Descriptive `inputSchema` field names help the agent provide correct arguments.
- All Zod schemas are required — both `inputSchema` and `outputSchema`.
- Tools are pure functions: no side effects beyond their declared purpose.

---

## Workflows (`src/mastra/workflows/`)

Workflows are deterministic, structured pipelines. Use them when you need precise control over step order, data flow, branching, and error handling.

### Step and workflow anatomy

```typescript
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const stepOne = createStep({
  id: 'step-one',
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ processed: z.string() }),
  execute: async ({ inputData }) => {
    return { processed: inputData.value.toUpperCase() };
  },
});

export const myWorkflow = createWorkflow({
  id: 'my-workflow',
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ processed: z.string() }),
})
  .then(stepOne)
  .commit();
```

### Running a workflow

```typescript
const workflow = mastra.getWorkflow('myWorkflow');
const run = await workflow.createRun();
await run.start({ inputData: { value: 'hello' } });
```

### Conventions

- Define steps in the same file as the workflow unless they are shared across multiple workflows.
- All steps must declare `inputSchema` and `outputSchema`.
- Workflows must call `.commit()` to finalise the pipeline.
- Register workflows on the `Mastra` instance in `src/mastra/index.ts`.
- Prefer workflows over agents for tasks with a known, repeatable structure.

### Workflow runners

By default, workflows run on the built-in execution engine. For managed infrastructure, runners like **Inngest** are supported via `@mastra/inngest`. Workflow logic stays the same — only the runner changes.

---

## MCP (`src/mastra/mcp/`)

MCP (Model Context Protocol) is an open standard for connecting agents to tools regardless of language or environment.

### MCPClient — consuming external tool servers

```typescript
import { MCPClient } from '@mastra/mcp';

export const myMcpClient = new MCPClient({
  servers: {
    myServer: {
      command: 'npx',
      args: ['-y', '@some/mcp-server'],
    },
  },
});
```

Pass `await myMcpClient.getTools()` to an agent's `tools` option to expose all MCP tools.

### MCPServer — exposing Mastra tools to MCP clients

```typescript
import { MCPServer } from '@mastra/mcp';

export const myMcpServer = new MCPServer({
  id: 'my-mcp-server',
  name: 'My MCP Server',
  version: '1.0.0',
  tools: { myTool },
});
```

Register on the `Mastra` instance as `mcpServers: { myMcpServer }`.

---

## Scorers (`src/mastra/scorers/`)

Scorers evaluate agent output quality with quantitative scores (0–1). Use them in CI with `runEvals` from `@mastra/core/evals`.

### Custom scorer

```typescript
import { createScorer } from '@mastra/core/evals';

export const myScorer = createScorer({
  id: 'my-scorer',
  description: 'Evaluates whether the output meets X criteria.',
  judge: async ({ input, output }) => {
    // return a score between 0 and 1
    return { score: output.includes('expected') ? 1 : 0 };
  },
});
```

### Built-in scorers

Mastra ships pre-built scorers in `@mastra/evals` — answer relevancy, faithfulness, hallucination, toxicity, bias, completeness, and more. Import and use them directly without a custom scorer file.

### Running in CI

```typescript
import { runEvals } from '@mastra/core/evals';

const result = await runEvals({
  data: [
    { input: 'What is 2+2?', groundTruth: { answer: '4' } },
  ],
  target: myAgent,
  scorers: [myScorer],
});

expect(result.scores['my-scorer']).toBeGreaterThan(0.8);
```

Use Vitest, Jest, or Mocha — any framework that supports ESM.
