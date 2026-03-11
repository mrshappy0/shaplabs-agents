import { z } from 'zod';
import { init, createStep } from '@mastra/inngest';
import { inngest } from '../inngest';
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

const runDockerManagerStep = createStep({
  id: 'Docker Update Manager (Test)',
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  execute: async ({ inputData, mastra }) => {
    const agent = mastra?.getAgent('dockerManagerAgent');
    const channelId = process.env.DISCORD_CHANNEL_ID;
    const result = await agent.generate(inputData.prompt);

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
