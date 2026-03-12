/**
 * Discord notification utilities for Mastra workflows.
 *
 * Uses the Discord Bot API (Authorization: Bot ...) so we can post messages
 * AND handle slash command / button interactions. The old webhook approach
 * was outbound-only; the bot token replaces it entirely.
 *
 * Required env vars:
 *   DISCORD_BOT_TOKEN   — Bot → Token in Discord Developer Portal
 *   DISCORD_APP_ID      — Application ID (top of the General Information page)
 *   DISCORD_CHANNEL_ID  — Channel where the bot posts results
 *   DISCORD_PUBLIC_KEY  — Public Key from General Information (for sig verification)
 */

import type { z } from 'zod';
import type { dockerReportSchema } from '../mastra/workflows/docker-update-cycle-workflow';
import type { applyUpdatesReportSchema } from '../mastra/workflows/docker-apply-updates-workflow';
import { postMessage, buildApprovalComponents } from './discord-bot';
import { savePending, pruneExpired } from './discord-pending';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DockerReport = z.infer<typeof dockerReportSchema>;
export type ApplyReport = z.infer<typeof applyUpdatesReportSchema>;

interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

// ── Colors ────────────────────────────────────────────────────────────────────

const COLOR_GREEN  = 0x00b894;
const COLOR_YELLOW = 0xfdcb6e;
const COLOR_RED    = 0xd63031;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Discord field values are capped at 1024 chars. */
function trunc(s: string, max = 1024): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

function channelId(): string {
  const id = process.env.DISCORD_CHANNEL_ID;
  if (!id) throw new Error('DISCORD_CHANNEL_ID is not set');
  return id;
}

async function send(embed: DiscordEmbed, components?: object[]): Promise<void> {
  const ch = channelId();
  const payload: Record<string, unknown> = { embeds: [embed] };
  if (components) payload.components = components;
  await postMessage(ch, payload);
}

// ── Update-check report formatter ─────────────────────────────────────────────

/**
 * Posts the update-check embed to Discord.
 *
 * Colour logic:
 *   green  = nothing actionable (even if there are digest-pin rebuilds)
 *   yellow = review-first containers need user approval
 *   red    = registry errors
 *
 * Compose pin updates are intentionally excluded from Discord — they're too
 * noisy. They remain in the structured workflow output for the agent.
 *
 * If review-first containers exist, a follow-up message with approval buttons
 * is posted and the pending state is saved to SQLite for later lookup.
 */
export async function notifyUpdateReport(report: DockerReport): Promise<void> {
  const { summary, safeToUpdate, reviewFirst, registryErrors, skip } = report;

  let color = COLOR_GREEN;
  if (registryErrors.length > 0) color = COLOR_RED;
  else if (reviewFirst.length > 0) color = COLOR_YELLOW;

  const fields: DiscordEmbed['fields'] = [];

  if (safeToUpdate.length > 0) {
    const lines = safeToUpdate
      .map(c => `• **${c.containerName}** \`${c.currentVersion}\` → \`${c.latestVersion}\`\n  ${c.changesSummary}`)
      .join('\n');
    fields.push({ name: `🟢 Safe to Update (${safeToUpdate.length})`, value: trunc(lines) });
  }

  if (reviewFirst.length > 0) {
    const lines = reviewFirst
      .map(c => {
        const warns = c.warnings.map(w => `  ⚠ ${w}`).join('\n');
        return `• **${c.containerName}** \`${c.currentVersion}\` → \`${c.latestVersion}\`\n${warns}`;
      })
      .join('\n');
    fields.push({ name: `🟡 Review First (${reviewFirst.length})`, value: trunc(lines) });
  }

  if (skip.length > 0) {
    const lines = skip.map(c => `• **${c.containerName}** — ${c.reason}`).join('\n');
    fields.push({ name: `⏭ Skipped (${skip.length})`, value: trunc(lines) });
  }

  if (registryErrors.length > 0) {
    const lines = registryErrors.map(c => `• **${c.containerName}** — ${c.error}`).join('\n');
    fields.push({ name: `❌ Registry Errors (${registryErrors.length})`, value: trunc(lines) });
  }

  await send({
    title: '🐳 Docker Update Check',
    description: summary.headline,
    color,
    fields,
    footer: { text: `Checked at ${summary.checkedAt}` },
    timestamp: summary.checkedAt,
  });

  // If there are review-first containers, post a follow-up with approval buttons
  // and persist the pending state so button clicks can retrieve these containers later.
  if (reviewFirst.length > 0) {
    const runId = `run-${Date.now()}`;
    const ch = channelId();

    const pending = reviewFirst.map(c => ({
      containerName: c.containerName,
      currentVersion: c.currentVersion,
      latestVersion: c.latestVersion,
      warnings: c.warnings,
    }));

    savePending(runId, ch, pending);
    pruneExpired();

    await send(
      {
        title: '🟡 Approval Required',
        description:
          'The containers below need manual review before updating. ' +
          'Click to apply individual containers or use **Apply All**. ' +
          `This prompt expires in **24 hours** (run \`${runId}\`).`,
        color: COLOR_YELLOW,
      },
      buildApprovalComponents(runId, pending),
    );
  }
}

// ── Apply-updates report formatter ────────────────────────────────────────────

/**
 * Posts the apply-updates result embed to Discord.
 *
 * Colour:
 *   green  = all succeeded + verified
 *   yellow = some unverified (Unraid still pulling)
 *   red    = any failures
 */
export async function notifyApplyReport(report: ApplyReport): Promise<void> {
  const { summary, succeeded, failed, skipped, verification, appliedAt, dryRun } = report;

  const color =
    failed.length > 0
      ? COLOR_RED
      : summary.unverified > 0
        ? COLOR_YELLOW
        : COLOR_GREEN;

  const fields: DiscordEmbed['fields'] = [];

  if (succeeded.length > 0) {
    const lines = succeeded.map(c => `• **${c.containerName}** — ${c.message}`).join('\n');
    fields.push({ name: `✅ Succeeded (${succeeded.length})`, value: trunc(lines) });
  }

  if (failed.length > 0) {
    const lines = failed.map(c => `• **${c.containerName}** — ${c.error ?? c.message}`).join('\n');
    fields.push({ name: `❌ Failed (${failed.length})`, value: trunc(lines) });
  }

  if (skipped.length > 0) {
    const lines = skipped.map(c => `• **${c.containerName}** — ${c.reason}`).join('\n');
    fields.push({ name: `⏭ Skipped at Preflight (${skipped.length})`, value: trunc(lines) });
  }

  if (verification.length > 0) {
    const lines = verification
      .map(c => `${c.verified ? '✅' : '⏳'} **${c.containerName}**`)
      .join('\n');
    fields.push({ name: '🔍 Verification', value: trunc(lines) });
  }

  const titleSuffix = dryRun ? ' (Dry Run)' : '';

  await send({
    title: `🐳 Docker Updates Applied${titleSuffix}`,
    description: summary.headline,
    color,
    fields,
    footer: { text: `Completed at ${appliedAt}` },
    timestamp: appliedAt,
  });
}
