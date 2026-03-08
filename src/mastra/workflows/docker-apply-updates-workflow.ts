/**
 * Docker Apply Updates Workflow
 *
 * Companion to docker-check-workflow.ts. While the check workflow discovers
 * and classifies available updates, *this* workflow actually applies them.
 *
 * Designed to chain directly from the check workflow's output — the
 * `containers` input matches the shape of `dockerReportSchema.safeToUpdate`
 * so you can pass that array in without any transformation.
 *
 * Steps
 * ─────
 *   Step 1  preflightCheckStep   → Re-fetches registry digests to confirm each
 *                                   container still needs an update. Stale entries
 *                                   (already updated, or registry error) are
 *                                   separated out so we never blindly restart.
 *
 *   Step 2  applyUpdatesStep     → Calls the Unraid GraphQL mutation for each
 *                                   confirmed container, one at a time (serial).
 *                                   Serial execution is intentional — Unraid queues
 *                                   image pulls and parallel calls can cause races.
 *
 *   Step 3  verifyUpdatesStep    → Re-checks registry digests for every container
 *                                   that was updated. Confirms local imageId now
 *                                   matches the remote digest (true success signal).
 *
 * Safe-by-default
 * ───────────────
 *   • Top-level `dryRun` flag skips all mutations (steps 1 & 3 still run).
 *   • Preflight re-check means a stale report from hours ago won't cause a
 *     spurious restart.
 *   • Serial application lets Unraid handle each pull/restart cleanly.
 */

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { listDockerContainers, checkRegistryUpdates, updateDockerContainer, type ListDockerContainersOutput, type CheckRegistryUpdatesOutput } from '../tools/docker-tools';
import { notifyApplyReport } from '../tools/discord-tools';

// ── Shared input item schema ──────────────────────────────────────────────────
//
// Intentionally a subset of dockerReportSchema.safeToUpdate — only the fields
// this workflow actually needs. Extra fields (notes, changesSummary, etc.) are
// safely ignored via z.object() strict-off defaults.

const updateCandidateSchema = z.object({
  containerName: z.string().describe('Exact container name as shown in Unraid'),
  currentVersion: z.string().optional().describe('Currently running version or tag (informational only)'),
  latestVersion: z.string().optional().describe('Expected latest version (informational only)'),
});

export type UpdateCandidate = z.infer<typeof updateCandidateSchema>;

// ── Step result schemas ───────────────────────────────────────────────────────

const confirmedContainerSchema = z.object({
  containerName: z.string(),
  dockerId: z.string().describe('Docker container ID (PrefixedID) from list-docker-containers — passed as containerId to the GraphQL mutation'),
  image: z.string().describe('Full image name without tag — passed to the update mutation'),
  tag: z.string().describe('Image tag — passed to the update mutation'),
  localDigest: z.string(),
  remoteDigest: z.string(),
});

const skippedContainerSchema = z.object({
  containerName: z.string(),
  reason: z.string(),
});

const updateResultSchema = z.object({
  containerName: z.string(),
  success: z.boolean(),
  message: z.string(),
  error: z.string().optional(),
});

const verificationSchema = z.object({
  containerName: z.string(),
  verified: z.boolean(),
  localDigest: z.string().optional(),
  remoteDigest: z.string().optional(),
  note: z.string().optional(),
});

// ── Final report schema ───────────────────────────────────────────────────────

export const applyUpdatesReportSchema = z.object({
  appliedAt: z.string().describe('ISO 8601 timestamp when the workflow completed'),
  dryRun: z.boolean(),
  summary: z.object({
    requested: z.number().int(),
    confirmed: z.number().int().describe('Still needed an update at preflight time'),
    skipped: z.number().int().describe('Already up to date or preflight error'),
    succeeded: z.number().int(),
    failed: z.number().int(),
    verified: z.number().int().describe('Confirmed by post-update registry check'),
    unverified: z.number().int().describe('Updated but digest not yet confirmed (Unraid may still be pulling)'),
    headline: z.string(),
  }),
  succeeded: z.array(updateResultSchema),
  failed: z.array(updateResultSchema),
  skipped: z.array(skippedContainerSchema),
  verification: z.array(verificationSchema),
});

export type ApplyUpdatesReport = z.infer<typeof applyUpdatesReportSchema>;

// ── Step 1: Preflight re-check ────────────────────────────────────────────────

const preflightCheckStep = createStep({
  id: 'preflight-check',
  description:
    'Re-fetches the live container list from Unraid and re-checks registry digests ' +
    'for each requested container. Separates containers that still need an update ' +
    '(confirmed) from those already up to date or unreachable (skipped). ' +
    'Deterministic — no AI.',
  inputSchema: z.object({
    containers: z.array(updateCandidateSchema),
    dryRun: z.boolean().optional(),
  }),
  outputSchema: z.object({
    confirmed: z.array(confirmedContainerSchema),
    skipped: z.array(skippedContainerSchema),
    dryRun: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    const { containers, dryRun = false } = inputData;

    // Fetch the live container list so we have current imageId values
    const liveList = (await listDockerContainers.execute!(
      { stateFilter: null },
      {},
    )) as ListDockerContainersOutput;

    if (liveList.error) {
      // Can't validate anything — skip all to avoid blind updates
      return {
        confirmed: [],
        skipped: containers.map((c) => ({
          containerName: c.containerName,
          reason: `Could not fetch live container list: ${liveList.error}`,
        })),
        dryRun,
      };
    }

    // Build lookup by name
    const liveMap = new Map(liveList.containers.map((c) => [c.name, c]));

    // Identify which containers exist and aren't digest-pinned
    const checkable: Array<{ candidate: UpdateCandidate; live: ListDockerContainersOutput['containers'][number] }> = [];
    const skipped: z.infer<typeof skippedContainerSchema>[] = [];

    for (const candidate of containers) {
      const live = liveMap.get(candidate.containerName);
      if (!live) {
        skipped.push({
          containerName: candidate.containerName,
          reason: 'Container not found on Unraid — may have been removed or renamed.',
        });
        continue;
      }
      if (live.digestPin) {
        skipped.push({
          containerName: candidate.containerName,
          reason:
            'Container is digest-pinned — it cannot be updated via the Unraid API. ' +
            'Update the upstream compose file instead.',
        });
        continue;
      }
      checkable.push({ candidate, live });
    }

    if (checkable.length === 0) {
      return { confirmed: [], skipped, dryRun };
    }

    const BATCH_SIZE = 20;
    const allRegistryResults: CheckRegistryUpdatesOutput['results'] = [];

    for (let i = 0; i < checkable.length; i += BATCH_SIZE) {
      const batch = checkable.slice(i, i + BATCH_SIZE);
      const result = (await checkRegistryUpdates.execute!(
        {
          containers: batch.map(({ live }) => ({
            image: live.image,
            tag: live.tag,
            localImageId: live.imageId,
          })),
        },
        {},
      )) as CheckRegistryUpdatesOutput;
      allRegistryResults.push(...result.results);
    }

    // Match registry results back to containers
    const registryMap = new Map(
      allRegistryResults.map((r) => [`${r.image}:${r.tag}`, r]),
    );

    const confirmed: z.infer<typeof confirmedContainerSchema>[] = [];

    for (const { candidate, live } of checkable) {
      const key = `${live.image}:${live.tag}`;
      const reg = registryMap.get(key);

      if (!reg) {
        skipped.push({
          containerName: candidate.containerName,
          reason: 'No registry result returned during preflight — skipping to be safe.',
        });
        continue;
      }
      if (reg.error) {
        skipped.push({
          containerName: candidate.containerName,
          reason: `Registry preflight error: ${reg.error}`,
        });
        continue;
      }
      if (!reg.updateAvailable) {
        skipped.push({
          containerName: candidate.containerName,
          reason:
            'Already up to date at preflight time — digest matches remote. ' +
            'The check report may have been stale.',
        });
        continue;
      }

      confirmed.push({
        containerName: candidate.containerName,
        dockerId: live.dockerId,
        image: live.image,
        tag: live.tag,
        localDigest: reg.localDigest,
        remoteDigest: reg.remoteDigest ?? '',
      });
    }

    return { confirmed, skipped, dryRun };
  },
});

// ── Step 2: Apply updates (serial) ───────────────────────────────────────────

const applyUpdatesStep = createStep({
  id: 'apply-updates',
  description:
    'Calls the Unraid GraphQL mutation for each confirmed container one at a time. ' +
    'Serial order is intentional — Unraid queues image pulls and parallel mutations ' +
    'can cause race conditions. Respects dryRun flag.',
  inputSchema: z.object({
    confirmed: z.array(confirmedContainerSchema),
    skipped: z.array(skippedContainerSchema),
    dryRun: z.boolean(),
  }),
  outputSchema: z.object({
    succeeded: z.array(updateResultSchema),
    failed: z.array(updateResultSchema),
    skipped: z.array(skippedContainerSchema),
    confirmedSnapshot: z.array(confirmedContainerSchema), // passed through for verify step
    dryRun: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    const { confirmed, skipped, dryRun } = inputData;

    const succeeded: z.infer<typeof updateResultSchema>[] = [];
    const failed: z.infer<typeof updateResultSchema>[] = [];

    // Serial — intentional. Do NOT convert to Promise.all.
    for (const container of confirmed) {
      type UpdateOutput = {
        containerName: string;
        success: boolean;
        message: string;
        error?: string;
      };

      const result = (await updateDockerContainer.execute!(
        {
          containerId: container.dockerId,
          containerName: container.containerName,
          image: container.image,
          tag: container.tag,
          dryRun,
        },
        {},
      )) as UpdateOutput;

      if (result.success) {
        succeeded.push({
          containerName: result.containerName,
          success: true,
          message: result.message,
        });
      } else {
        failed.push({
          containerName: result.containerName,
          success: false,
          message: result.message,
          error: result.error,
        });
      }

      // Brief pause between mutations to let Unraid process each request.
      // Unraid's Docker management is single-threaded at the daemon level.
      if (!dryRun) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    return {
      succeeded,
      failed,
      skipped,
      confirmedSnapshot: confirmed,
      dryRun,
    };
  },
});

// ── Step 3: Verify updates ────────────────────────────────────────────────────
//
// Re-checks registry digests for every container that received a successful
// update mutation. Because Unraid pulls images asynchronously, this step
// polls with retries before giving up. A container that is "unverified" is
// not necessarily broken — Unraid may still be pulling the image.

const VERIFY_RETRIES = 10;
const VERIFY_DELAY_MS = 30_000; // 30 s between retries — large images (e.g. ollama) can take several minutes
const VERIFY_INITIAL_WAIT_MS = 20_000; // 20 s initial wait before first check — no point polling immediately

const verifyUpdatesStep = createStep({
  id: 'verify-updates',
  description:
    'Re-checks registry digests for successfully updated containers to confirm ' +
    'Unraid pulled the new image. Waits 20 s before the first check, then polls ' +
    'up to 10 times with 30-second delays (up to ~5 minutes total). ' +
    'Containers still showing the old digest are marked unverified (Unraid ' +
    'may still be pulling). Produces the final ApplyUpdatesReport.',
  inputSchema: z.object({
    succeeded: z.array(updateResultSchema),
    failed: z.array(updateResultSchema),
    skipped: z.array(skippedContainerSchema),
    confirmedSnapshot: z.array(confirmedContainerSchema),
    dryRun: z.boolean(),
  }),
  outputSchema: applyUpdatesReportSchema,
  execute: async ({ inputData }) => {
    const { succeeded, failed, skipped, confirmedSnapshot, dryRun } = inputData;

    const succeededNames = new Set(succeeded.map((s) => s.containerName));
    const toVerify = confirmedSnapshot.filter((c) => succeededNames.has(c.containerName));

    const verification: z.infer<typeof verificationSchema>[] = [];

    if (dryRun || toVerify.length === 0) {
      // Nothing to check in dry-run mode or if no updates succeeded
      for (const c of toVerify) {
        verification.push({
          containerName: c.containerName,
          verified: dryRun,
          note: dryRun ? 'Dry run — skipped verification.' : 'No verification needed.',
        });
      }
    } else {
      // Poll until all containers show updated digests or retries are exhausted
      type RegistryOutput = {
        results: Array<{
          image: string;
          tag: string;
          updateAvailable: boolean;
          localDigest: string;
          remoteDigest?: string;
          error?: string;
        }>;
      };

      const pendingVerification = new Map(toVerify.map((c) => [c.containerName, c]));
      const verificationResults = new Map<string, z.infer<typeof verificationSchema>>();

      // Initial wait — give Unraid time to start the pull before we check
      await new Promise((resolve) => setTimeout(resolve, VERIFY_INITIAL_WAIT_MS));

      for (let attempt = 1; attempt <= VERIFY_RETRIES; attempt++) {
        if (pendingVerification.size === 0) break;

        const batch = Array.from(pendingVerification.values());

        const freshList = (await listDockerContainers.execute!(
          { stateFilter: null },
          {},
        )) as ListDockerContainersOutput;

        const freshMap = new Map(
          (freshList.containers ?? []).map((c) => [c.name, c]),
        );

        const checkTargets = batch
          .map((c) => {
            const fresh = freshMap.get(c.containerName);
            return fresh
              ? { name: c.containerName, image: fresh.image, tag: fresh.tag, imageId: fresh.imageId, expectedRemote: c.remoteDigest }
              : null;
          })
          .filter(Boolean) as Array<{ name: string; image: string; tag: string; imageId: string; expectedRemote: string }>;

        if (checkTargets.length === 0) break;

        const registryResult = (await checkRegistryUpdates.execute!(
          {
            containers: checkTargets.map((t) => ({
              image: t.image,
              tag: t.tag,
              localImageId: t.imageId,
            })),
          },
          {},
        )) as CheckRegistryUpdatesOutput;

        const resultMap = new Map(registryResult.results.map((r) => [`${r.image}:${r.tag}`, r]));

        for (const target of checkTargets) {
          const reg = resultMap.get(`${target.image}:${target.tag}`);

          if (reg && !reg.error && !reg.updateAvailable) {
            // Local digest matches remote — update confirmed
            verificationResults.set(target.name, {
              containerName: target.name,
              verified: true,
              localDigest: reg.localDigest,
              remoteDigest: reg.remoteDigest,
              note: `Verified on attempt ${attempt}/${VERIFY_RETRIES}.`,
            });
            pendingVerification.delete(target.name);
          }
        }

        if (pendingVerification.size > 0 && attempt < VERIFY_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, VERIFY_DELAY_MS));
        }
      }

      // Mark anything still pending as unverified
      for (const [name, container] of pendingVerification) {
        verificationResults.set(name, {
          containerName: name,
          verified: false,
          remoteDigest: container.remoteDigest,
          note:
            `Digest still differs after ${VERIFY_RETRIES} attempts. ` +
            'Unraid may still be pulling the image. Check the Unraid Docker tab.',
        });
      }

      for (const [, result] of verificationResults) {
        verification.push(result);
      }
    }

    // ── Build final report ────────────────────────────────────────────────────
    const verifiedCount = verification.filter((v) => v.verified).length;
    const unverifiedCount = verification.filter((v) => !v.verified).length;

    const headline = dryRun
      ? `[dry-run] Would update ${succeeded.length} container(s) — no changes made.`
      : [
          `Updated ${succeeded.length} container(s) successfully.`,
          failed.length > 0 ? `${failed.length} failed.` : null,
          skipped.length > 0 ? `${skipped.length} skipped (already current or preflight error).` : null,
          verifiedCount > 0 ? `${verifiedCount} digest-verified.` : null,
          unverifiedCount > 0 ? `${unverifiedCount} unverified (Unraid may still be pulling).` : null,
        ]
          .filter(Boolean)
          .join(' ');

    return {
      appliedAt: new Date().toISOString(),
      dryRun,
      summary: {
        requested: confirmedSnapshot.length + skipped.length,
        confirmed: confirmedSnapshot.length,
        skipped: skipped.length,
        succeeded: succeeded.length,
        failed: failed.length,
        verified: verifiedCount,
        unverified: unverifiedCount,
        headline,
      },
      succeeded,
      failed,
      skipped,
      verification,
    };
  },
});

// ── Discord notification step ─────────────────────────────────────────────────

const notifyDiscordStep = createStep({
  id: 'notify-discord',
  description: 'Posts the apply-updates report to Discord via webhook. Pass-through — the report is returned unchanged as the workflow output.',
  inputSchema: applyUpdatesReportSchema,
  outputSchema: applyUpdatesReportSchema,
  execute: async ({ inputData }) => {
    await notifyApplyReport(inputData);
    return inputData;
  },
});

// ── Workflow ──────────────────────────────────────────────────────────────────

export const dockerApplyUpdatesWorkflow = createWorkflow({
  id: 'docker-apply-updates-workflow',
  description:
    'Applies Docker container updates on Unraid. ' +
    'Step 1 re-checks registries (preflight guard against stale reports). ' +
    'Step 2 applies updates serially via Unraid GraphQL mutation. ' +
    'Step 3 verifies success by re-checking digests. ' +
    'Input containers array matches the safeToUpdate shape from docker-check-workflow ' +
    'so the two workflows chain naturally. Use dryRun: true to validate without changing anything.',
  inputSchema: z.object({
    containers: z
      .array(updateCandidateSchema)
      .describe(
        'Containers to update. Accepts the safeToUpdate array from docker-check-workflow directly. ' +
        'Only containerName is required — currentVersion and latestVersion are informational.',
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe('When true, runs preflight and verification but skips all Unraid mutations. Defaults to false.'),
  }),
  outputSchema: applyUpdatesReportSchema,
})
  .then(preflightCheckStep)
  .then(applyUpdatesStep)
  .then(verifyUpdatesStep)
  .then(notifyDiscordStep)
  .commit();
