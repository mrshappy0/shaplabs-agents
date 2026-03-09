/**
 * Discord Gateway — real-time message listener
 *
 * Connects to the Discord WebSocket Gateway so the bot can receive messages
 * in the configured channel and respond via the dockerManagerAgent.
 *
 * All three triggers (gateway chat, /docker-check slash command, cron schedule)
 * use the same resourceId + threadId so the agent's rolling memory window is
 * shared. A cron check at noon is still in context when you type "update Radarr"
 * in the evening (as long as it's within the last 10 messages).
 *
 * Required env vars:
 *   DISCORD_BOT_TOKEN   — Bot token from Discord Developer Portal
 *   DISCORD_CHANNEL_ID  — Channel the bot listens and posts in
 *
 * Required Discord Developer Portal setting (or messages will be empty):
 *   Bot → Privileged Gateway Intents → Message Content Intent  ← must be ON
 *
 * Intents used:
 *   GUILDS           (1 << 0)  =     1
 *   GUILD_MESSAGES   (1 << 9)  =   512
 *   MESSAGE_CONTENT  (1 << 15) = 32768
 */

import type { Mastra } from '@mastra/core/mastra';
import { postMessage } from './tools/discord-bot';

const INTENTS = 1 | 512 | 32768;

// ── Shared thread coordinates ─────────────────────────────────────────────────
// Export so discord-route.ts and docker-cron-workflow.ts can import the same values.

export const GATEWAY_RESOURCE_ID = 'discord';

export function gatewayThreadId(channelId: string): string {
  return `discord-${channelId}-chat`;
}

// ── Message chunking ──────────────────────────────────────────────────────────

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

// ── Message handler ───────────────────────────────────────────────────────────

async function handleUserMessage(
  mastra: Mastra,
  channelId: string,
  content: string,
): Promise<void> {
  const agent = mastra.getAgent('dockerManagerAgent');

  const result = await agent.generate(content, {
    memory: {
      resource: GATEWAY_RESOURCE_ID,
      thread: gatewayThreadId(channelId),
    },
  });

  const text = result.text?.trim();
  if (!text) return;

  for (const chunk of chunkMessage(text)) {
    await postMessage(channelId, { content: chunk });
  }
}

// ── Gateway connection ────────────────────────────────────────────────────────

export function startDiscordGateway(mastra: Mastra): void {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;

  if (!token || !channelId) {
    console.warn(
      '[discord-gateway] DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID not set — gateway not started',
    );
    return;
  }

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastSeq: number | null = null;

  // Discord close codes that signal a permanent error — retrying is pointless
  // and could mask a misconfiguration (bad token, invalid intents, etc.).
  const NON_RESUMABLE_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

  function connect(): void {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');

    ws.addEventListener('open', () => {
      console.log('[discord-gateway] WebSocket opened');
    });

    ws.addEventListener('message', async (event) => {
      let payload: { op: number; d?: unknown; t?: string; s?: number | null };
      try {
        // Node 22's built-in WebSocket may deliver event.data as a Blob
        const raw = typeof event.data === 'string'
          ? event.data
          : typeof (event.data as Blob)?.text === 'function'
            ? await (event.data as Blob).text()
            : String(event.data);
        payload = JSON.parse(raw) as typeof payload;
      } catch (err) {
        console.error('[discord-gateway] Failed to parse message:', typeof event.data, err);
        return;
      }

      const { op, d, t, s } = payload;
      if (s != null) lastSeq = s;

      // op 10 — HELLO: start heartbeating and identify
      if (op === 10) {
        const { heartbeat_interval } = d as { heartbeat_interval: number };

        // Send one heartbeat immediately then on interval
        ws.send(JSON.stringify({ op: 1, d: lastSeq }));
        heartbeatTimer = setInterval(() => {
          ws.send(JSON.stringify({ op: 1, d: lastSeq }));
        }, heartbeat_interval);

        // IDENTIFY
        ws.send(
          JSON.stringify({
            op: 2,
            d: {
              token,
              intents: INTENTS,
              properties: {
                os: 'linux',
                browser: 'mastra-discord-gateway',
                device: 'mastra-discord-gateway',
              },
            },
          }),
        );
        return;
      }

      // op 0 — Dispatch events
      if (op === 0) {
        if (t === 'READY') {
          const { user } = d as { user: { username: string; discriminator: string } };
          console.log(`[discord-gateway] Connected as ${user.username}#${user.discriminator}`);
          return;
        }

        if (t === 'MESSAGE_CREATE') {
          const msg = d as {
            channel_id: string;
            author: { id: string; bot?: boolean };
            content?: string;
          };

          // Only handle our configured channel, ignore bots and empty messages
          if (msg.channel_id !== channelId) return;
          if (msg.author.bot) return;
          const text = msg.content?.trim();
          if (!text) return;

          setImmediate(() => {
            handleUserMessage(mastra, channelId, text).catch((err) =>
              console.error('[discord-gateway] handleUserMessage error:', err),
            );
          });
        }
      }
    });

    ws.addEventListener('close', (event) => {
      const code = (event as CloseEvent).code;
      const reason = (event as CloseEvent).reason;
      console.log(`[discord-gateway] WebSocket closed: code=${code} reason=${reason}`);
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (NON_RESUMABLE_CLOSE_CODES.has(code)) {
        console.error(
          `[discord-gateway] WebSocket closed with non-resumable code ${code} — NOT reconnecting. ` +
          'Check DISCORD_BOT_TOKEN and Gateway Intent settings in the Discord Developer Portal.',
        );
        return;
      }
      console.warn(`[discord-gateway] WebSocket closed (code ${code}) — reconnecting in 5s`);
      setTimeout(connect, 5000);
    });

    ws.addEventListener('error', (err) => {
      console.error('[discord-gateway] WebSocket error:', err);
    });
  }

  connect();
}
