import { z } from 'zod';
import { init, createStep } from '@mastra/inngest';
import { inngest } from '../inngest';
import { DOCKER_CHECK_PROMPT } from '../agents/docker-manager-agent';
import { postMessage, chunkMessage } from '../../utils/discord-bot';
import { GATEWAY_RESOURCE_ID, gatewayThreadId } from '../../server/discord-gateway';

const { createWorkflow } = init(inngest);

const runDockerManagerStep = createStep({
  id: 'Docker Update Manager (Test)',
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  execute: async ({ inputData, mastra }) => {
    const agent = mastra?.getAgent('dockerManagerAgent');
    const channelId = process.env.DISCORD_CHANNEL_ID;
    const result = await agent.generate(inputData.prompt, {
      memory: {
        resource: GATEWAY_RESOURCE_ID,
        thread: gatewayThreadId(channelId ?? 'default'),
      },
    });

    const text = result.text?.trim();
    if (text && channelId) {
      for (const chunk of chunkMessage(text)) {
        await postMessage(channelId, { content: chunk });
      }
    }

    return { text: result.text };
  },
});

export const dockerCronTestWorkflow = createWorkflow({
  id: 'docker-cron-test-workflow',
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  // Run every 2 minutes for testing
  cron: '*/2 * * * *',
  inputData: { prompt: DOCKER_CHECK_PROMPT },
})
  .then(runDockerManagerStep)
  .commit();
