import { z } from 'zod';
import { init, createStep } from '@mastra/inngest';
import { inngest } from '../inngest';

const { createWorkflow } = init(inngest);

const runDockerManagerStep = createStep({
  id: 'Docker Update Manager (Test)',
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  execute: async ({ inputData, mastra }) => {
    const agent = mastra?.getAgent('dockerManagerAgent');
    const result = await agent.generate(inputData.prompt);
    return { text: result.text };
  },
});

export const dockerCronTestWorkflow = createWorkflow({
  id: 'docker-cron-test-workflow',
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  // Run every 2 minutes for testing
  cron: '*/2 * * * *',
  inputData: { prompt: 'Do your thing boss' },
})
  .then(runDockerManagerStep)
  .commit();
