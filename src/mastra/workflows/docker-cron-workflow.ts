import { z } from 'zod';
import { init, createStep } from '@mastra/inngest';
import { inngest } from '../inngest';

const { createWorkflow } = init(inngest);

// Pull the agent through the Mastra instance so observability/tracing is captured
const runDockerManagerStep = createStep({
  id: 'Docker Update Manager',
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  execute: async ({ inputData, mastra }) => {
    const agent = mastra?.getAgent('dockerManagerAgent');
    const result = await agent.generate(inputData.prompt);
    return { text: result.text };
  },
});

export const dockerCronWorkflow = createWorkflow({
  id: 'docker-cron-workflow',
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  // Run every day at 12:00 PM MST (19:00 UTC)
  cron: '0 19 * * *',
  inputData: { prompt: 'Do your thing boss' },
})
  .then(runDockerManagerStep)
  .commit();


