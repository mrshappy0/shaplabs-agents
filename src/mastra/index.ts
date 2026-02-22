
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { Observability, DefaultExporter, SensitiveDataFilter } from '@mastra/observability';
import { weatherWorkflow } from './workflows/weather-workflow';
import { scheduledWorkflow } from './workflows/scheduled-workflow';
import { weatherAgent } from './agents/weather-agent';
import { dockerUpdateAgent, WORKING_MEMORY_TEMPLATE } from './agents/docker-update-agent';
import { toolCallAppropriatenessScorer, completenessScorer, translationScorer } from './scorers/weather-scorer';

export const mastra = new Mastra({
  workflows: { weatherWorkflow, scheduledWorkflow },
  agents: { weatherAgent, dockerUpdateAgent },
  scorers: { toolCallAppropriatenessScorer, completenessScorer, translationScorer },
  storage: new LibSQLStore({
    id: "mastra-storage",
    // stores observability, scores, ... into persistent file storage
    url: "file:./mastra.db",
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new DefaultExporter(), // Persists traces to storage for Mastra Studio
          // new CloudExporter(), // Sends traces to Mastra Cloud (if MASTRA_CLOUD_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});

/**
 * Resets working memory to the default template for all threads
 * belonging to the docker-update-agent. Only runs when both
 * NODE_ENV=development and RESET_WORKING_MEMORY=true are set.
 */
async function resetWorkingMemory() {
  if (process.env.NODE_ENV !== 'development' || process.env.RESET_WORKING_MEMORY !== 'true') {
    return;
  }

  try {
    const agent = mastra.getAgent('dockerUpdateAgent');
    const memory = await agent.getMemory();
    if (!memory) {
      console.log('[startup] No memory configured on agent');
      return;
    }
    const { threads } = await memory.listThreads({ perPage: false });
    if (threads.length === 0) {
      console.log('[startup] No threads found — working memory is fresh');
      return;
    }
    for (const thread of threads) {
      await memory.updateWorkingMemory({
        threadId: thread.id,
        resourceId: thread.resourceId,
        workingMemory: WORKING_MEMORY_TEMPLATE,
      });
    }
    console.log(`[startup] Reset working memory to template across ${threads.length} thread(s)`);
  } catch (err) {
    console.warn('[startup] Could not reset working memory:', err);
  }
}

resetWorkingMemory();
