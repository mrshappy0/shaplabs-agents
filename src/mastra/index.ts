
import { Mastra } from '@mastra/core/mastra';
import { MastraJwtAuth } from '@mastra/auth';
import { PinoLogger } from '@mastra/loggers';
import { storage } from './storage';
import { Observability, DefaultExporter, SensitiveDataFilter } from '@mastra/observability';
import { serve } from '@mastra/inngest';
import { inngest } from './inngest';
import { createDiscordRouteHandler } from './server/discord-route';
import { startDiscordGateway } from './discord-gateway';
import { weatherWorkflow } from './workflows/weather-workflow';
import { scheduledWorkflow } from './workflows/scheduled-workflow';
import { dockerCheckWorkflow } from './workflows/docker-check-workflow';
import { dockerApplyUpdatesWorkflow } from './workflows/docker-apply-updates-workflow';
import { dockerCronWorkflow } from './workflows/docker-cron-workflow';
// import { dockerCronTestWorkflow } from './workflows/docker-cron-test-workflow';
import { weatherAgent } from './agents/weather-agent';
import { dockerClassifierAgent } from './agents/docker-classifier-agent';
import { dockerManagerAgent } from './agents/docker-manager-agent';
import { toolCallAppropriatenessScorer, completenessScorer, translationScorer } from './scorers/weather-scorer';

export const mastra = new Mastra({
  workflows: { weatherWorkflow, scheduledWorkflow, dockerCheckWorkflow, dockerApplyUpdatesWorkflow, dockerCronWorkflow,
    // dockerCronTestWorkflow: Runs the Docker Manager Agent every two minutes — enable for testing
    // dockerCronTestWorkflow
  },
  agents: { weatherAgent, dockerClassifierAgent, dockerManagerAgent },
  server: {
    host: '0.0.0.0',
    auth: new MastraJwtAuth({
      secret: process.env.MASTRA_JWT_SECRET!,
      public: ['/api/discord', '/api/inngest'],
    }),
    apiRoutes: [
      {
        path: '/api/inngest',
        method: 'ALL' as const,
        createHandler: async ({ mastra }: { mastra: Mastra }) => serve({ mastra, inngest }),
      },
      {
        path: '/api/discord',
        method: 'POST' as const,
        createHandler: async ({ mastra }: { mastra: Mastra }) => createDiscordRouteHandler(mastra),
      },
    ],
  },
  scorers: { toolCallAppropriatenessScorer, completenessScorer, translationScorer },
  storage,
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

startDiscordGateway(mastra);
