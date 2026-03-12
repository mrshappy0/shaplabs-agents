/**
 * Discord Bot REST API helpers.
 *
 * All outbound Discord communication goes through here. Uses the bot token
 * (Authorization: Bot ...) rather than the old webhook approach, which lets
 * us post messages, edit them, and handle interactions.
 *
 * Required env vars:
 *   DISCORD_BOT_TOKEN   — from Discord Developer Portal → your app → Bot
 *   DISCORD_APP_ID      — your application's numeric ID
 *   DISCORD_CHANNEL_ID  — the channel where the bot posts results
 */

const DISCORD_API = 'https://discord.com/api/v10';

// ── Message chunking ──────────────────────────────────────────────────────────

/** Discord message limit is 2000 chars. Break at newlines where possible. */
export function chunkMessage(text: string, max = 1990): string[] {
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

// ── Button custom_id conventions ──────────────────────────────────────────────
//
//   apply_one:{runId}:{containerName}
//   apply_all:{runId}

export function makeApplyOneId(runId: string, containerName: string): string {
  return `apply_one:${runId}:${containerName}`;
}

export function makeApplyAllId(runId: string): string {
  return `apply_all:${runId}`;
}

// ── Request helpers ───────────────────────────────────────────────────────────

function botHeaders(): Record<string, string> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bot ${token}`,
  };
}

async function checkOk(res: Response, label: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new Error(`[discord-bot] ${label} failed: ${res.status} ${res.statusText} — ${text}`);
  }
}

// ── Posting ───────────────────────────────────────────────────────────────────

/** Post a new message to a channel. Returns the message object (including `id`). */
export async function postMessage(
  channelId: string,
  payload: object,
): Promise<{ id: string; channel_id: string }> {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: botHeaders(),
    body: JSON.stringify(payload),
  });
  await checkOk(res, 'postMessage');
  return res.json() as Promise<{ id: string; channel_id: string }>;
}

/** Edit an existing channel message. */
export async function editMessage(
  channelId: string,
  messageId: string,
  payload: object,
): Promise<void> {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: botHeaders(),
    body: JSON.stringify(payload),
  });
  await checkOk(res, 'editMessage');
}

// ── Interaction responses ─────────────────────────────────────────────────────

/**
 * Edit the original response to a deferred interaction.
 * Uses the interaction webhook (no bot token needed here — uses interaction token).
 */
export async function editInteractionResponse(
  applicationId: string,
  interactionToken: string,
  payload: object,
): Promise<void> {
  const res = await fetch(
    `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  await checkOk(res, 'editInteractionResponse');
}

/**
 * Post a followup message to an interaction.
 * Useful for sending additional content after the initial response.
 */
export async function followupMessage(
  applicationId: string,
  interactionToken: string,
  payload: object,
): Promise<void> {
  const res = await fetch(`${DISCORD_API}/webhooks/${applicationId}/${interactionToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await checkOk(res, 'followupMessage');
}

// ── Approval button helpers ───────────────────────────────────────────────────

interface ReviewContainer {
  containerName: string;
  currentVersion: string;
  latestVersion: string;
  warnings: string[];
}

/**
 * Build a Discord components row with one "Apply [name]" button per container
 * plus a single "Apply All" button.
 *
 * Discord limits: 5 buttons per row, 5 rows per message (25 buttons total).
 * We put Apply-All on the first row, then individual containers after.
 * If there are more than 9 individual containers (4 in row 1, 5 in row 2) we truncate — edge case.
 */
export function buildApprovalComponents(
  runId: string,
  containers: ReviewContainer[],
): object[] {
  const rows: object[] = [];

  // Row 0: Apply All + first 4 individual buttons
  const firstRow: object[] = [
    {
      type: 2, // BUTTON
      style: 3, // SUCCESS (green)
      label: 'Apply All Review-First',
      custom_id: makeApplyAllId(runId),
      emoji: { name: '✅' },
    },
  ];

  const truncated = containers.slice(0, 4);
  for (const c of truncated) {
    firstRow.push({
      type: 2,
      style: 1, // PRIMARY (blue)
      label: c.containerName,
      custom_id: makeApplyOneId(runId, c.containerName),
    });
  }
  rows.push({ type: 1, components: firstRow }); // ACTION_ROW

  // If more than 4 containers, add a second row (up to 5 more)
  if (containers.length > 4) {
    const secondRow = containers.slice(4, 9).map((c) => ({
      type: 2,
      style: 1,
      label: c.containerName,
      custom_id: makeApplyOneId(runId, c.containerName),
    }));
    rows.push({ type: 1, components: secondRow });
  }

  return rows;
}

// ── Channel clear helpers ─────────────────────────────────────────────────────

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/** Fetch up to 100 messages from a channel, optionally paginating before a message ID. */
async function fetchChannelMessages(
  channelId: string,
  before?: string,
): Promise<{ id: string; timestamp: string }[]> {
  const params = new URLSearchParams({ limit: '100' });
  if (before) params.set('before', before);
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages?${params}`, {
    headers: botHeaders(),
  });
  await checkOk(res, 'fetchChannelMessages');
  return res.json() as Promise<{ id: string; timestamp: string }[]>;
}

/** Bulk-delete 2–100 messages that are all under 14 days old. */
async function bulkDeleteMessages(channelId: string, messageIds: string[]): Promise<void> {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages/bulk-delete`, {
    method: 'POST',
    headers: botHeaders(),
    body: JSON.stringify({ messages: messageIds }),
  });
  await checkOk(res, 'bulkDeleteMessages');
}

/** Delete a single message (required for messages older than 14 days). */
async function deleteSingleMessage(channelId: string, messageId: string): Promise<void> {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
    method: 'DELETE',
    headers: botHeaders(),
  });
  await checkOk(res, 'deleteSingleMessage');
}

/**
 * Delete all messages in a channel.
 * Bulk-deletes messages younger than 14 days; falls back to individual deletes
 * for older messages (rate-limited — expected to be rare in a homelab channel).
 * Returns the total number of messages deleted.
 */
export async function clearChannelMessages(channelId: string): Promise<number> {
  const cutoff = Date.now() - FOURTEEN_DAYS_MS;
  let deleted = 0;
  let before: string | undefined;

  for (;;) {
    const messages = await fetchChannelMessages(channelId, before);
    if (messages.length === 0) break;

    const recent = messages.filter(m => new Date(m.timestamp).getTime() > cutoff).map(m => m.id);
    const old    = messages.filter(m => new Date(m.timestamp).getTime() <= cutoff).map(m => m.id);

    // Bulk delete requires 2+ messages; handle the single-message edge case
    if (recent.length >= 2) {
      await bulkDeleteMessages(channelId, recent);
      deleted += recent.length;
    } else if (recent.length === 1) {
      await deleteSingleMessage(channelId, recent[0]);
      deleted += 1;
    }

    for (const id of old) {
      await deleteSingleMessage(channelId, id);
      deleted += 1;
    }

    if (messages.length < 100) break;
    before = messages[messages.length - 1].id;
  }

  return deleted;
}
