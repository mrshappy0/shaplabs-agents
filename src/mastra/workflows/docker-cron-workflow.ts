import { z } from 'zod';
import { init, createStep } from '@mastra/inngest';
import { inngest } from '../inngest';
import { GATEWAY_RESOURCE_ID, gatewayThreadId } from '../discord-gateway';
import { DOCKER_CHECK_PROMPT } from '../agents/docker-manager-agent';

const { createWorkflow } = init(inngest);

// Pull the agent through the Mastra instance so observability/tracing is captured
const runDockerManagerStep = createStep({
  id: 'Docker Update Manager',
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  execute: async ({ inputData, mastra }) => {
    const agent = mastra?.getAgent('dockerManagerAgent');
    const channelId = process.env.DISCORD_CHANNEL_ID ?? 'default';
    const result = await agent.generate(inputData.prompt, {
      memory: {
        resource: GATEWAY_RESOURCE_ID,
        thread: gatewayThreadId(channelId),
      },
    });
    return { text: result.text };
  },
});

export const dockerCronWorkflow = createWorkflow({
  id: 'docker-cron-workflow',
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  // Run every day at 12:00 PM MST (19:00 UTC)
  cron: '0 19 * * *',
  inputData: { prompt: DOCKER_CHECK_PROMPT },
})
  .then(runDockerManagerStep)
  .commit();


