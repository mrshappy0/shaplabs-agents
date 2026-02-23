/**
 * Docker Update Workflow v2 — workflow-first approach
 *
 * Compare to docker-update-workflow.ts (agent-first):
 *   Agent-first:  1 step → agent autonomously calls tools, discovers repos,
 *                 reasons about risk, writes a report. Black box.
 *
 *   Workflow-first (this file):
 *     Step 1  listContainersStep    → deterministic  (tool call)
 *     Step 2  checkRegistryStep     → deterministic  (tool call, batched)
 *     Step 3  mergeAndSplitStep     → deterministic  (pure logic, no I/O)
 *     Step 4  fetchChangelogsStep   → deterministic  (tool calls)
 *     Step 5  classifyUpdatesStep   → AI reasoning   (agent.generate, no tools)
 *
 * The agent only appears in the one step where LLM judgment is genuinely
 * needed: reading prose release notes and deciding safe / reviewFirst / skip.
 * Everything else is explicit, testable, and observable.
 */

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  listDockerContainers,
  checkRegistryUpdates,
  checkGithubReleases,
  checkUpstreamCompose,
  searchGithubRepos,
} from '../tools/docker-tools';

// ── Output schema ─────────────────────────────────────────────────────────────
// Defined here rather than in an agent file — the workflow owns this type now.

const containerUpdateItem = z.object({
  containerName: z.string().describe("Exact container name as shown in Unraid"),
  currentVersion: z.string().describe("Currently running version or tag (e.g. '3.4.1' or 'latest@sha256:...')"),
  latestVersion: z.string().describe("Latest available version or tag from the registry / GitHub"),
  changesSummary: z.string().describe("One-sentence summary of what changed in this release"),
  githubRepo: z.string().optional().describe("Upstream GitHub repo in owner/repo format, e.g. 'Radarr/Radarr'"),
});

export const dockerReportSchema = z.object({
  summary: z.object({
    checkedAt: z.string().describe("ISO 8601 timestamp when the check completed"),
    totalContainers: z.number().int().describe("Total containers returned by list-docker-containers"),
    upToDate: z.number().int().describe("Containers whose local digest matches the registry"),
    updatesAvailable: z.number().int().describe("Non-digest-pinned containers with a confirmed update"),
    composePinsToReview: z.number().int().describe("Digest-pinned containers whose upstream compose changed"),
    registryErrors: z.number().int().describe("Containers that could not be checked due to a registry error"),
    headline: z.string().describe("Human-readable one-liner, e.g. 'Checked 38/38: 2 safe updates, 1 review first'"),
  }),
  safeToUpdate: z.array(
    containerUpdateItem.extend({
      notes: z.string().optional().describe("Any optional context (e.g. 'pinned version tag — update via Unraid template')"),
    })
  ).describe("Updates confirmed safe to apply — patch/bugfix releases with no breaking changes"),
  reviewFirst: z.array(
    containerUpdateItem.extend({
      warnings: z.array(z.string()).describe("Specific things the user must check before updating — DB migrations, breaking config changes, etc."),
    })
  ).describe("Updates that need attention before applying — major bumps, migrations, deprecations"),
  skip: z.array(z.object({
    containerName: z.string(),
    latestVersion: z.string().optional().describe("Pre-release or problematic version string"),
    reason: z.string().describe("Why this update is being skipped: alpha/beta/RC, known issue, draft release, etc."),
  })).describe("Releases to skip — pre-release, draft, or flagged with known issues"),
  composePinUpdates: z.array(z.object({
    containerName: z.string().describe("The pinned container name in Unraid (e.g. 'immich_redis_vault')"),
    serviceName: z.string().describe("Service name in the upstream compose file (e.g. 'redis', 'database')"),
    parentProject: z.string().describe("GitHub repo that owns the compose file, e.g. 'immich-app/immich'"),
    imageChanged: z.boolean().describe("True when the upstream replaced the image entirely (e.g. redis → valkey)"),
    digestChanged: z.boolean().describe("True when the same image was rebuilt with a new digest"),
    currentImage: z.string().describe("The image currently pinned (e.g. 'redis:6.2-alpine')"),
    newImage: z.string().optional().describe("New image recommended by upstream — only present when imageChanged is true"),
    notes: z.string().describe("What action the user should take and any relevant migration context"),
    hasMigrationDocs: z.boolean().optional().describe("Whether the upstream release references migration documentation"),
  })).describe("Digest-pinned containers managed by an upstream compose file — cannot be updated via Unraid UI"),
  registryErrors: z.array(z.object({
    containerName: z.string(),
    error: z.string().describe("The registry error message"),
    fallbackAssessment: z.string().optional().describe("Best-effort assessment using runningVersion vs GitHub releases when registry failed"),
  })).describe("Containers that could not be registry-checked — listed separately so nothing is silently missed"),
  upToDate: z.array(z.string()).describe("Names of containers confirmed up to date — kept as a flat list to avoid noise"),
});

export type DockerReport = z.infer<typeof dockerReportSchema>;

// ── Shared schemas ────────────────────────────────────────────────────────────

const containerSchema = z.object({
  name: z.string(),
  image: z.string(),
  tag: z.string(),
  imageId: z.string(),
  digestPin: z.string().nullable(),
  runningVersion: z.string().nullable(),
  state: z.string(),
  status: z.string(),
  sourceUrl: z.string().nullable(),
});

type Container = z.infer<typeof containerSchema>;

const registryResultSchema = z.object({
  image: z.string(),
  tag: z.string(),
  updateAvailable: z.boolean(),
  localDigest: z.string(),
  remoteDigest: z.string().optional(),
  error: z.string().optional(),
});

const containerWithChangelogSchema = containerSchema.extend({
  remoteDigest: z.string().optional(),
  githubRepo: z.string().optional(),
  changelog: z.string().optional(),
  changelogError: z.string().optional(),
  latestVersion: z.string().optional(),
});

const digestPinnedWithComposeSchema = containerSchema.extend({
  composeOwner: z.string().optional(),
  composeRepo: z.string().optional(),
  composeCheck: z
    .object({
      latestVersion: z.string(),
      composeFound: z.boolean(),
      pinComparison: z.array(
        z.object({
          service: z.string(),
          upstreamImage: z.string(),
          yourImage: z.string().optional(),
          imageChanged: z.boolean(),
          upstreamDigest: z.string(),
          yourDigest: z.string().optional(),
          digestChanged: z.boolean(),
          summary: z.string(),
        }),
      ),
      breakingChanges: z.array(z.string()),
      error: z.string().optional(),
    })
    .optional(),
});

// ── Compose-managed project map ──────────────────────────────────────────────
//
// Only used for digest-pinned containers that are managed by an upstream
// compose file. GitHub repo lookup for changelog fetching is always done
// dynamically via searchGithubRepos.

/**
 * Known compose-managed projects: containers whose images are digest-pinned
 * inside an upstream compose file that the project maintains.
 * Key = the GitHub org/owner whose containers we recognise.
 */
const COMPOSE_MANAGED_PROJECTS: Record<string, { owner: string; repo: string; composePath: string }> = {
  'immich-app': { owner: 'immich-app', repo: 'immich', composePath: 'docker-compose.yml' },
};

// ── Step 1: List containers ───────────────────────────────────────────────────

const listContainersStep = createStep({
  id: 'list-containers',
  description: 'Fetches all Docker containers from the Unraid server (deterministic tool call)',
  inputSchema: z.object({
    stateFilter: z
      .enum(['running', 'exited', 'all'])
      .optional()
      .describe('Filter containers by state. Defaults to "all".'),
  }),
  outputSchema: z.object({
    containers: z.array(containerSchema),
    totalCount: z.number(),
    error: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    // Tools are called with an empty context — they use env vars, not requestContext.
    type Output = { containers: z.infer<typeof containerSchema>[]; totalCount: number; error?: string };
    const result = (await listDockerContainers.execute!(
      { stateFilter: inputData.stateFilter ?? null },
      {},
    )) as Output;
    return result;
  },
});

// ── Step 2: Check registry for all containers ─────────────────────────────────

const checkRegistryStep = createStep({
  id: 'check-registry',
  description:
    'Checks Docker registries for all containers in batches of 20. ' +
    'This is the source of truth for update availability — digest comparison never lies. ' +
    '(deterministic tool call)',
  inputSchema: z.object({
    containers: z.array(containerSchema),
    totalCount: z.number(),
    error: z.string().optional(),
  }),
  outputSchema: z.object({
    containers: z.array(containerSchema),
    totalCount: z.number(),
    registryResults: z.array(registryResultSchema),
  }),
  execute: async ({ inputData }) => {
    const { containers, totalCount } = inputData;

    // Batch into groups of 20 (tool limit)
    const BATCH_SIZE = 20;
    const allResults: z.infer<typeof registryResultSchema>[] = [];

    type RegistryOutput = { results: z.infer<typeof registryResultSchema>[] };
    for (let i = 0; i < containers.length; i += BATCH_SIZE) {
      const batch = containers.slice(i, i + BATCH_SIZE);
      const result = (await checkRegistryUpdates.execute!(
        {
          containers: batch.map((c) => ({
            image: c.image,
            tag: c.tag,
            localImageId: c.imageId,
          })),
        },
        {},
      )) as RegistryOutput;
      allResults.push(...result.results);
    }

    return {
      containers,
      totalCount,
      registryResults: allResults,
    };
  },
});

// ── Step 3: Merge and split into categories ───────────────────────────────────

const mergeAndSplitStep = createStep({
  id: 'merge-and-split',
  description:
    'Joins containers with registry results and splits into four categories: ' +
    'needsUpdate, digestPinned, upToDate, registryErrors. ' +
    'Pure deterministic logic — no I/O, no AI.',
  inputSchema: z.object({
    containers: z.array(containerSchema),
    totalCount: z.number(),
    registryResults: z.array(registryResultSchema),
  }),
  outputSchema: z.object({
    needsUpdate: z.array(
      containerSchema.extend({ remoteDigest: z.string() }),
    ),
    digestPinned: z.array(containerSchema),
    upToDate: z.array(z.string()), // container names
    registryErrors: z.array(
      z.object({ containerName: z.string(), image: z.string(), error: z.string() }),
    ),
    totalCount: z.number(),
  }),
  execute: async ({ inputData }) => {
    const { containers, totalCount, registryResults } = inputData;

    // Build a lookup from "image:tag" → registry result
    const resultMap = new Map<string, z.infer<typeof registryResultSchema>>();
    for (const r of registryResults) {
      resultMap.set(`${r.image}:${r.tag}`, r);
    }

    const needsUpdate: Array<Container & { remoteDigest: string }> = [];
    const digestPinned: Container[] = [];
    const upToDate: string[] = [];
    const registryErrors: Array<{ containerName: string; image: string; error: string }> = [];

    for (const container of containers) {
      const key = `${container.image}:${container.tag}`;
      const result = resultMap.get(key);

      if (!result) {
        // No registry result found — treat as error
        registryErrors.push({
          containerName: container.name,
          image: container.image,
          error: 'No registry result returned for this container',
        });
        continue;
      }

      if (result.error) {
        registryErrors.push({
          containerName: container.name,
          image: container.image,
          error: result.error,
        });
        continue;
      }

      // Digest-pinned containers get their own section — they can't be updated
      // via Unraid UI regardless of what the registry says.
      if (container.digestPin) {
        digestPinned.push(container);
        continue;
      }

      if (result.updateAvailable) {
        needsUpdate.push({ ...container, remoteDigest: result.remoteDigest ?? '' });
      } else {
        upToDate.push(container.name);
      }
    }

    return {
      needsUpdate,
      digestPinned,
      upToDate,
      registryErrors,
      totalCount,
    };
  },
});

// ── Step 4: Fetch changelogs ──────────────────────────────────────────────────

const fetchChangelogsStep = createStep({
  id: 'fetch-changelogs',
  description:
    'Resolves GitHub repos for containers needing updates (using known patterns, ' +
    'not AI), fetches release notes, and checks upstream compose files for ' +
    'digest-pinned containers. (deterministic tool calls)',
  inputSchema: z.object({
    needsUpdate: z.array(containerSchema.extend({ remoteDigest: z.string() })),
    digestPinned: z.array(containerSchema),
    upToDate: z.array(z.string()),
    registryErrors: z.array(
      z.object({ containerName: z.string(), image: z.string(), error: z.string() }),
    ),
    totalCount: z.number(),
  }),
  outputSchema: z.object({
    needsUpdateWithChangelogs: z.array(containerWithChangelogSchema),
    digestPinnedWithCompose: z.array(digestPinnedWithComposeSchema),
    upToDate: z.array(z.string()),
    registryErrors: z.array(
      z.object({ containerName: z.string(), image: z.string(), error: z.string() }),
    ),
    totalCount: z.number(),
    checkedAt: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { needsUpdate, digestPinned, upToDate, registryErrors, totalCount } = inputData;

    // ── Fetch changelogs for containers needing updates ──
    // De-duplicate repos so we don't call GitHub API multiple times for
    // containers that share an upstream (e.g. immich-server + immich-ml).
    const repoChangelogs = new Map<
      string,
      { latestVersion: string; changelog: string; error?: string }
    >();

    const needsUpdateWithChangelogs = await Promise.all(
      needsUpdate.map(async (container) => {
        // Always search GitHub dynamically — no hardcoded map.
        // Use the bare app name from the image reference as the query.
        const appName = container.image.split('/').pop() ?? container.image;
        try {
          type SearchOutput = { results: { fullName: string; stars: number; hasReleases: boolean }[]; error?: string };
          const searchResult = (await searchGithubRepos.execute!(
            { query: appName, maxResults: 3 },
            {},
          )) as SearchOutput;

          const best = searchResult.results.find((r) => r.hasReleases);
          if (best) {
            const [owner, repo] = best.fullName.split('/');
            const repoKey = `${owner}/${repo}`;
            if (!repoChangelogs.has(repoKey)) {
              type GitHubOutput = { releases: { tagName: string; name: string; publishedAt: string; isPreRelease: boolean; isDraft: boolean; body: string; url: string }[]; error?: string };
              const ghResult = (await checkGithubReleases.execute!(
                { owner, repo, count: 2 },
                {},
              )) as GitHubOutput;
              if (ghResult.error) {
                repoChangelogs.set(repoKey, { latestVersion: '', changelog: '', error: ghResult.error });
              } else {
                const latest = ghResult.releases.find((r) => !r.isPreRelease && !r.isDraft);
                repoChangelogs.set(repoKey, {
                  latestVersion: latest?.tagName ?? '',
                  changelog: ghResult.releases
                    .map((r) => `## ${r.tagName} (${r.publishedAt.slice(0, 10)})\n${r.body}`)
                    .join('\n\n'),
                });
              }
            }
            const cached = repoChangelogs.get(repoKey)!;
            return {
              ...container,
              githubRepo: repoKey,
              changelog: cached.error ? undefined : cached.changelog,
              changelogError: cached.error ? `Search found ${repoKey} but changelog failed: ${cached.error}` : undefined,
              latestVersion: cached.latestVersion || undefined,
            };
          }
        } catch (err) {
          // swallow search errors — classifier will note it
        }
        return {
          ...container,
          githubRepo: undefined,
          changelog: undefined,
          changelogError: `No GitHub repo found for image "${container.image}" — check manually`,
        };
      }),
    );

    // ── Check upstream compose files for digest-pinned containers ──
    // Group digest-pinned containers by their parent compose project.
    type ComposeProject = { owner: string; repo: string; composePath: string };
    const composeGroups = new Map<
      string, // "owner/repo"
      { project: ComposeProject; containers: Container[] }
    >();

    for (const container of digestPinned) {
      // Identify the parent compose project by checking image name or container name
      // against our known compose-managed projects.
      for (const [imageFragment, project] of Object.entries(COMPOSE_MANAGED_PROJECTS)) {
        if (
          container.image.includes(imageFragment) ||
          container.name.toLowerCase().includes(imageFragment.split('/')[0])
        ) {
          const key = `${project.owner}/${project.repo}`;
          if (!composeGroups.has(key)) {
            composeGroups.set(key, { project, containers: [] });
          }
          composeGroups.get(key)!.containers.push(container);
          break;
        }
      }
    }

    type ComposeOutput = {
      latestVersion: string; composeFound: boolean; composePath?: string; composeSource?: string;
      pinComparison: { service: string; upstreamImage: string; yourImage?: string; imageChanged: boolean; upstreamDigest: string; yourDigest?: string; digestChanged: boolean; summary: string }[];
      breakingChanges: string[]; releasesBetween: { version: string; date: string; highlights: string; hasBreakingIndicators: boolean }[];
      error?: string;
    };
    // Fetch compose check once per project, cache the result
    const composeResults = new Map<string, ComposeOutput>();
    for (const [key, { project, containers }] of composeGroups) {
      try {
        const pins = containers
          .filter((c) => c.digestPin)
          .map((c) => {
            // Best-effort service name: use container name suffix after last underscore
            const parts = c.name.split('_');
            const service = parts[parts.length - 1] ?? c.name;
            // image reference without the digest
            const baseRef = c.image + (c.tag !== 'latest' ? `:${c.tag}` : '');
            return { service, image: baseRef, digest: c.digestPin! };
          });

        const result = (await checkUpstreamCompose.execute!(
          {
            owner: project.owner,
            repo: project.repo,
            composePath: project.composePath,
            currentVersion: containers[0]?.runningVersion ?? null,
            currentPins: pins,
          },
          {},
        )) as ComposeOutput;
        composeResults.set(key, result);
      } catch (err) {
        composeResults.set(key, {
          latestVersion: '',
          composeFound: false,
          pinComparison: [],
          breakingChanges: [],
          releasesBetween: [],
          error: String(err),
        });
      }
    }

    // Annotate each digest-pinned container with its compose check result
    const digestPinnedWithCompose = digestPinned.map((container) => {
      for (const [key, { containers }] of composeGroups) {
        if (containers.some((c) => c.name === container.name)) {
          const project = COMPOSE_MANAGED_PROJECTS[
            key.split('/')[1] // approximation — find by repo name
          ] ?? composeGroups.get(key)?.project;
          const result = composeResults.get(key);
          return {
            ...container,
            composeOwner: key.split('/')[0],
            composeRepo: key.split('/')[1],
            composeCheck: result
              ? {
                  latestVersion: result.latestVersion,
                  composeFound: result.composeFound,
                  pinComparison: result.pinComparison,
                  breakingChanges: result.breakingChanges,
                  error: result.error,
                }
              : undefined,
          };
        }
      }
      // Not in any known compose project — no compose check available
      return { ...container };
    });

    return {
      needsUpdateWithChangelogs,
      digestPinnedWithCompose,
      upToDate,
      registryErrors,
      totalCount,
      checkedAt: new Date().toISOString(),
    };
  },
});

// ── Step 5: Classify updates (the only AI step) ───────────────────────────────
//
// This is the ONLY step that uses an LLM. The agent receives fully structured
// data — all the legwork was done deterministically in steps 1-4. The agent's
// sole job is to read release notes and apply risk classification judgment.
//
// Pattern used: calling agent.generate() inside a step's execute function.
// This gives us control over the prompt and lets us pass structuredOutput.

const classifyUpdatesStep = createStep({
  id: 'classify-updates',
  description:
    'The only AI step. Passes structured data (containers + changelogs) to the ' +
    'dockerClassifierAgent, which classifies each update as safe/reviewFirst/skip. ' +
    'The agent has no tools — it only reasons about the data provided.',
  inputSchema: z.object({
    needsUpdateWithChangelogs: z.array(containerWithChangelogSchema),
    digestPinnedWithCompose: z.array(digestPinnedWithComposeSchema),
    upToDate: z.array(z.string()),
    registryErrors: z.array(
      z.object({ containerName: z.string(), image: z.string(), error: z.string() }),
    ),
    totalCount: z.number(),
    checkedAt: z.string(),
  }),
  outputSchema: dockerReportSchema,
  execute: async ({ inputData, mastra: mastraInstance }) => {
    if (!mastraInstance) {
      throw new Error('Mastra instance not available in workflow step context');
    }

    const agent = mastraInstance.getAgent('dockerClassifierAgent');
    if (!agent) {
      throw new Error(
        'dockerClassifierAgent not found — make sure it is registered in src/mastra/index.ts',
      );
    }

    const {
      needsUpdateWithChangelogs,
      digestPinnedWithCompose,
      upToDate,
      registryErrors,
      totalCount,
      checkedAt,
    } = inputData;

    // Build a structured prompt. The agent doesn't need to call any tools —
    // all the data it needs to classify is right here.
    const prompt = `
You are classifying Docker container updates for a homelab Unraid server.
Classify each update in the data below into safe / reviewFirst / skip.
Every container must appear in exactly one output section.

Checked at: ${checkedAt}
Total containers: ${totalCount}

## Containers needing updates (${needsUpdateWithChangelogs.length})
${JSON.stringify(needsUpdateWithChangelogs, null, 2)}

## Digest-pinned containers (cannot be updated via Unraid UI) (${digestPinnedWithCompose.length})
${JSON.stringify(digestPinnedWithCompose, null, 2)}

## Up to date (${upToDate.length} containers)
${JSON.stringify(upToDate)}

## Registry errors (${registryErrors.length})
${JSON.stringify(registryErrors, null, 2)}

Produce a complete report following the output schema exactly.
`.trim();

    const response = await agent.generate(prompt, {      structuredOutput: {
        schema: dockerReportSchema,
        // Use a secondary model for structured output to avoid conflicts
        // with tool-calling constraints (same pattern as the agent-first workflow).
        model: 'openai/gpt-4o-mini',
      },
    });

    return response.object;
  },
});

// ── Workflow ──────────────────────────────────────────────────────────────────

export const dockerUpdateWorkflow = createWorkflow({
  id: 'docker-update-workflow',
  description:
    'Workflow-first Docker update checker. ' +
    'Steps 1-4 are fully deterministic (tool calls + logic). ' +
    'Step 5 is the only AI step: it classifies updates via the dockerClassifierAgent ' +
    'which receives structured data and produces a typed report.',
  inputSchema: z.object({
    stateFilter: z
      .enum(['running', 'exited', 'all'])
      .optional()
      .describe('Filter containers by state. Defaults to "all".'),
  }),
  outputSchema: dockerReportSchema,
})
  .then(listContainersStep)
  .then(checkRegistryStep)
  .then(mergeAndSplitStep)
  .then(fetchChangelogsStep)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(classifyUpdatesStep as any)
  .commit();
