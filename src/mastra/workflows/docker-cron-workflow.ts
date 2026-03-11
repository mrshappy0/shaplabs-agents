import { z } from 'zod';
import { init, createStep } from '@mastra/inngest';
import { inngest } from '../inngest';
import { GATEWAY_RESOURCE_ID, gatewayThreadId } from '../discord-gateway';
import { DOCKER_CHECK_PROMPT } from '../agents/docker-manager-agent';
import { postMessage } from '../tools/discord-bot';

const { createWorkflow } = init(inngest);

/** Discord message limit is 2000 chars. Break at newlines where possible. */
function chunkMessage(text: string, max = 1990): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    const slice = remaining.slice(0, max);
    const lastNewline = slice.lastIndexOf('\n');
    const breakAt = lastNewline > max / 2 ? lastNewline : max;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

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

    // Post the agent's text response to Discord — the dockerCheckWorkflow
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
  inputData: { prompt: DOCKER_CHECK_PROMPT },
})
  .then(runDockerManagerStep)
  .commit();


