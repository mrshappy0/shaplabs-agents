/**
 * Discord notification utilities for Mastra workflows.
 *
 * Uses Discord's Webhook Execute API directly — no extra package needed.
 * Set DISCORD_WEBHOOK_URL in your .env to enable notifications.
 *
 * Reference: https://discord.com/developers/docs/resources/webhook#execute-webhook
 */

import type { z } from 'zod';
import type { dockerReportSchema } from '../workflows/docker-update-workflow';
import type { applyUpdatesReportSchema } from '../workflows/docker-apply-updates-workflow';

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

interface DiscordWebhookPayload {
  username?: string;
  avatar_url?: string;
  embeds: DiscordEmbed[];
}

// ── Colors ────────────────────────────────────────────────────────────────────

const COLOR_GREEN  = 0x00b894; // all good
const COLOR_YELLOW = 0xfdcb6e; // warnings / review needed
const COLOR_RED    = 0xd63031; // failures

// ── Low-level sender ──────────────────────────────────────────────────────────

export async function sendDiscordWebhook(payload: DiscordWebhookPayload): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.warn('[discord] DISCORD_WEBHOOK_URL is not set — skipping notification');
    return;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord webhook failed: ${res.status} ${res.statusText} — ${text}`);
  }
}

// ── Truncation helper ─────────────────────────────────────────────────────────

/** Discord field values are capped at 1024 chars. */
function trunc(s: string, max = 1024): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

// ── Update-check report formatter ─────────────────────────────────────────────

/**
 * Builds and sends a Discord embed for the docker-update-workflow output.
 * Colour:
 *   green  = no review / no errors
 *   yellow = some review-first or compose-pin updates
 *   red    = registry errors present
 */
export async function notifyUpdateReport(report: DockerReport): Promise<void> {
  const { summary, safeToUpdate, reviewFirst, registryErrors, skip } = report;

  // Pick embed colour.
  // Compose pin updates (even image-changed ones) are intentionally excluded from
  // Discord — they live in the structured workflow output for the agent but are too
  // noisy for a notification channel. Color is therefore driven only by actionable items.
  let color = COLOR_GREEN;
  if (registryErrors.length > 0) color = COLOR_RED;
  else if (reviewFirst.length > 0) color = COLOR_YELLOW;

  const fields: DiscordEmbed['fields'] = [];

  // Safe to update
  if (safeToUpdate.length > 0) {
    const lines = safeToUpdate
      .map(c => `• **${c.containerName}** \`${c.currentVersion}\` → \`${c.latestVersion}\`\n  ${c.changesSummary}`)
      .join('\n');
    fields.push({ name: `🟢 Safe to Update (${safeToUpdate.length})`, value: trunc(lines) });
  }

  // Review first
  if (reviewFirst.length > 0) {
    const lines = reviewFirst
      .map(c => {
        const warnings = c.warnings.map(w => `  ⚠ ${w}`).join('\n');
        return `• **${c.containerName}** \`${c.currentVersion}\` → \`${c.latestVersion}\`\n${warnings}`;
      })
      .join('\n');
    fields.push({ name: `🟡 Review First (${reviewFirst.length})`, value: trunc(lines) });
  }

  // Skip
  if (skip.length > 0) {
    const lines = skip.map(c => `• **${c.containerName}** — ${c.reason}`).join('\n');
    fields.push({ name: `⏭ Skipped (${skip.length})`, value: trunc(lines) });
  }

  // Registry errors
  if (registryErrors.length > 0) {
    const lines = registryErrors.map(c => `• **${c.containerName}** — ${c.error}`).join('\n');
    fields.push({ name: `❌ Registry Errors (${registryErrors.length})`, value: trunc(lines) });
  }

  await sendDiscordWebhook({
    username: 'Docker Manager',
    embeds: [{
      title: '🐳 Docker Update Check',
      description: summary.headline,
      color,
      fields,
      footer: { text: `Checked at ${summary.checkedAt}` },
      timestamp: summary.checkedAt,
    }],
  });
}

// ── Apply-updates report formatter ────────────────────────────────────────────

/**
 * Builds and sends a Discord embed for the docker-apply-updates-workflow output.
 * Colour:
 *   green  = all succeeded + verified
 *   yellow = some unverified
 *   red    = any failures
 */
export async function notifyApplyReport(report: ApplyReport): Promise<void> {
  const { summary, succeeded, failed, skipped, verification, appliedAt, dryRun } = report;

  const color = failed.length > 0
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

  await sendDiscordWebhook({
    username: 'Docker Manager',
    embeds: [{
      title: `🐳 Docker Updates Applied${titleSuffix}`,
      description: summary.headline,
      color,
      fields,
      footer: { text: `Completed at ${appliedAt}` },
      timestamp: appliedAt,
    }],
  });
}
