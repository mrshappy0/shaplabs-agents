/**
 * Discord Interactions Route Handler  ( /api/discord )
 *
 * Registered as a custom Mastra API route. Discord POSTs every slash command
 * and button click here. We verify the Ed25519 signature (required by Discord),
 * then dispatch to the correct handler.
 *
 * Interaction types handled:
 *   1 — PING               (signature verification health check from Discord)
 *   2 — APPLICATION_COMMAND   /docker-check
 *   3 — MESSAGE_COMPONENT   apply_one:{runId}:{containerName}
 *                           apply_all:{runId}
 *
 * Discord interactions must be acknowledged within 3 seconds.
 * Long-running work (agent / workflow) runs fire-and-forget in setImmediate.
 *
 * Security:
 *   - Ed25519 signature verified on every request via Web Crypto API (no extra deps)
 *   - DISCORD_PUBLIC_KEY env var holds the app's public key from Discord Developer Portal
 */

import type { Mastra } from '@mastra/core/mastra';
import { getPending, deletePending, removeContainerFromPending } from '../tools/discord-pending';
import { editInteractionResponse, followupMessage } from '../tools/discord-bot';
import { GATEWAY_RESOURCE_ID, gatewayThreadId } from '../discord-gateway';
import { DOCKER_CHECK_PROMPT } from '../agents/docker-manager-agent';

// ── Ed25519 signature verification ────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(hex.length / 2);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function verifyDiscordSignature(
  publicKey: string,
  signature: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const keyBytes  = hexToBytes(publicKey);
    const sigBytes  = hexToBytes(signature);
    const message   = encoder.encode(timestamp + body);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );

    return await crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, message);
  } catch (err) {
    console.error('[discord-route] signature verification threw:', err);
    return false;
  }
}

// ── Response helpers ──────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Interaction type constants ────────────────────────────────────────────────

const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

const ResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4, // immediate response
  DEFERRED_CHANNEL_MESSAGE: 5,    // ack slash command — reply later via webhook
} as const;

const EPHEMERAL = 64; // message flag — only visible to the user who triggered

// ── Button handlers (fire-and-forget) ────────────────────────────────────────

async function handleApplyOne(
  mastra: Mastra,
  appId: string,
  token: string,
  runId: string,
  containerName: string,
): Promise<void> {
  const pending = getPending(runId);

  if (!pending) {
    await editInteractionResponse(appId, token, {
      content: `⚠️ Pending state for run \`${runId}\` not found — it may have expired (24h) or already been applied.`,
    });
    return;
  }

  const target = pending.containers.find(c => c.containerName === containerName);
  if (!target) {
    await editInteractionResponse(appId, token, {
      content: `⚠️ Container \`${containerName}\` not found in run \`${runId}\`.`,
    });
    return;
  }

  await editInteractionResponse(appId, token, {
    content: `🔄 Applying **${containerName}**... check the channel for results.`,
  });

  // Remove this container from pending before launching the workflow so that
  // a second click on the same button can't trigger a duplicate apply.
  removeContainerFromPending(runId, containerName);

  try {
    const workflow = mastra.getWorkflow('dockerApplyUpdatesWorkflow');
    const run = await workflow.createRun();
    await run.start({
      inputData: {
        containers: [{ containerName: target.containerName }],
        dryRun: false,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await followupMessage(appId, token, {
      content: `❌ Apply failed for **${containerName}**: ${msg}`,
      flags: EPHEMERAL,
    });
  }
}

async function handleApplyAll(
  mastra: Mastra,
  appId: string,
  token: string,
  runId: string,
): Promise<void> {
  const pending = getPending(runId);

  if (!pending || pending.containers.length === 0) {
    await editInteractionResponse(appId, token, {
      content: `⚠️ No pending containers for run \`${runId}\`. May have expired or already been applied.`,
    });
    return;
  }

  const names = pending.containers.map(c => `**${c.containerName}**`).join(', ');
  await editInteractionResponse(appId, token, {
    content: `🔄 Applying all review-first containers: ${names}... check the channel for results.`,
  });

  // Consume the pending state so it can't be double-applied
  deletePending(runId);

  try {
    const workflow = mastra.getWorkflow('dockerApplyUpdatesWorkflow');
    const run = await workflow.createRun();
    await run.start({
      inputData: {
        containers: pending.containers.map(c => ({ containerName: c.containerName })),
        dryRun: false,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await followupMessage(appId, token, {
      content: `❌ Apply all failed: ${msg}`,
      flags: EPHEMERAL,
    });
  }
}

async function handleDockerCheck(
  mastra: Mastra,
): Promise<void> {
  try {
    const agent = mastra.getAgent('dockerManagerAgent');
    const channelId = process.env.DISCORD_CHANNEL_ID ?? 'default';
    await agent.generate(DOCKER_CHECK_PROMPT, {
      memory: {
        resource: GATEWAY_RESOURCE_ID,
        thread: gatewayThreadId(channelId),
      },
    });
  } catch (err) {
    console.error('[discord-route] docker-check agent error:', err);
  }
}

// ── Route factory ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (c: any) => Promise<Response>;

export function createDiscordRouteHandler(mastra: Mastra): AnyHandler {
  return async (c): Promise<Response> => {
    const publicKey = process.env.DISCORD_PUBLIC_KEY;
    const appId     = process.env.DISCORD_APP_ID;

    if (!publicKey || !appId) {
      console.error('[discord-route] DISCORD_PUBLIC_KEY or DISCORD_APP_ID not set');
      return jsonResponse({ error: 'Server misconfiguration' }, 500);
    }

    // c is a Hono Context — get the raw Fetch API Request from it
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const req: Request = c.req.raw as Request;

    // ── Signature verification ──────────────────────────────────────────────
    const signature = req.headers.get('X-Signature-Ed25519') ?? '';
    const timestamp  = req.headers.get('X-Signature-Timestamp') ?? '';
    const body = await req.text();

    const valid = await verifyDiscordSignature(publicKey, signature, timestamp, body);
    if (!valid) {
      console.warn('[discord-route] rejected request with invalid signature');
      return new Response('Invalid request signature', { status: 401 });
    }

    // ── Parse ───────────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let interaction: any;
    try {
      interaction = JSON.parse(body) as unknown;
    } catch {
      return new Response('Bad JSON', { status: 400 });
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { type, data, token } = interaction;

    // ── PING ────────────────────────────────────────────────────────────────
    if (type === InteractionType.PING) {
      return jsonResponse({ type: ResponseType.PONG });
    }

    // ── /docker-check ───────────────────────────────────────────────────────
    if (type === InteractionType.APPLICATION_COMMAND && data?.name === 'docker-check') {
      setImmediate(() => {
        handleDockerCheck(mastra).catch(err =>
          console.error('[discord-route] docker-check error:', err),
        );
      });

      return jsonResponse({
        type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: '🔍 Running Docker update check... results will appear in the channel shortly.',
          flags: EPHEMERAL,
        },
      });
    }

    // ── Button clicks ───────────────────────────────────────────────────────
    if (type === InteractionType.MESSAGE_COMPONENT) {
      const customId: string = (data?.custom_id as string) ?? '';

      if (customId.startsWith('apply_all:')) {
        const runId = customId.slice('apply_all:'.length);

        setImmediate(() => {
          handleApplyAll(mastra, appId, token as string, runId).catch(err =>
            console.error('[discord-route] apply_all error:', err),
          );
        });

        return jsonResponse({
          type: ResponseType.DEFERRED_CHANNEL_MESSAGE,
          data: { flags: EPHEMERAL },
        });
      }

      if (customId.startsWith('apply_one:')) {
        const rest = customId.slice('apply_one:'.length);
        const colonIdx = rest.indexOf(':');
        const runId = rest.slice(0, colonIdx);
        const containerName = rest.slice(colonIdx + 1);

        setImmediate(() => {
          handleApplyOne(mastra, appId, token as string, runId, containerName).catch(err =>
            console.error('[discord-route] apply_one error:', err),
          );
        });

        return jsonResponse({
          type: ResponseType.DEFERRED_CHANNEL_MESSAGE,
          data: { flags: EPHEMERAL },
        });
      }
    }

    return jsonResponse({ error: 'Unknown interaction type' }, 400);
  };
}
