import { z } from 'zod';
import { init, createStep } from '@mastra/inngest';
import { inngest } from '../inngest';
import { GATEWAY_RESOURCE_ID, gatewayThreadId } from '../../server/discord-gateway';
import { DOCKER_CHECK_PROMPT } from '../agents/docker-manager-agent';
import { postMessage, chunkMessage } from '../../utils/discord-bot';

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

    // Post the agent's text response to Discord — the dockerUpdateCycleWorkflow
    // already posts rich embeds, but the agent's summary/conversation text
    // was previously lost because nothing sent it to the channel.
    const text = result.text?.trim();
    if (text && channelId !== 'default') {
      for (const chunk of chunkMessage(text)) {
        await postMessage(channelId, { content: chunk });
      }
    }

    return { text: result.text };
  },
});

export const dockerCronWorkflow = createWorkflow({
  id: 'docker-cron-workflow',
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  // Run every day at 12:00 PM MDT / 11:00 AM MST (18:00 UTC)
  cron: '0 18 * * *',
  // Temporary: run every 10 minutes for debugging
  // cron: '*/10 * * * *',
  inputData: { prompt: DOCKER_CHECK_PROMPT },
})
  .then(runDockerManagerStep)
  .commit();


