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
  resolveVersionFromDigest,
} from '../tools/docker-tools';
import { notifyUpdateReport } from '../tools/discord-tools';

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

// ── Step 3.5: Resolve running versions for floating-tag containers ──────────────
//
// For containers tagged 'latest'/'nightly' with no runningVersion label, we
// cross-reference the local image digest against all recent semver tags on
// Docker Hub to find which exact version is actually running.
// This turns "latest → v0.17.7" into "v0.17.3 → v0.17.7" with full changelog.

const resolveRunningVersionsStep = createStep({
  id: 'resolve-running-versions',
  description:
    'For containers with a floating tag (latest/nightly) and no runningVersion, ' +
    'checks Docker Hub tags to find which semver version matches the local image digest. ' +
    'Enriches runningVersion so classifyUpdatesStep can report the real version gap.',
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
    needsUpdate: z.array(containerSchema.extend({ remoteDigest: z.string() })),
    digestPinned: z.array(containerSchema),
    upToDate: z.array(z.string()),
    registryErrors: z.array(
      z.object({ containerName: z.string(), image: z.string(), error: z.string() }),
    ),
    totalCount: z.number(),
  }),
  execute: async ({ inputData }) => {
    const { needsUpdate, digestPinned, upToDate, registryErrors, totalCount } = inputData;

    const FLOATING_TAGS = new Set(['latest', 'nightly', 'stable', 'edge', 'dev', 'main', 'master']);

    type ResolveOutput = { resolvedVersion: string | null; checkedTags: number; error?: string };

    const enriched = await Promise.all(
      needsUpdate.map(async (container) => {
        // Only attempt resolution when: floating tag + no version label + Docker Hub image
        if (
          container.runningVersion !== null ||
          !FLOATING_TAGS.has(container.tag.toLowerCase()) ||
          container.digestPin
        ) {
          return container;
        }

        try {
          const result = (await resolveVersionFromDigest.execute!(
            { image: container.image, localDigest: container.imageId },
            {},
          )) as ResolveOutput;

          if (result.resolvedVersion) {
            // Strip leading 'v' to match label-sourced runningVersion format (e.g. "0.17.5" not "v0.17.5")
            const normalized = result.resolvedVersion.replace(/^v/, '');
            return { ...container, runningVersion: normalized };
          }
        } catch {
          // Resolution failed — keep original container unchanged
        }

        return container;
      }),
    );

    return { needsUpdate: enriched, digestPinned, upToDate, registryErrors, totalCount };
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
        // Resolve the GitHub repo for this container — 100% dynamic, no hardcoded maps.
        //
        // Resolution priority:
        //   1. sourceUrl label: if it's a github.com URL pointing directly to an
        //      upstream repo (not a packaging/docker-only repo), try it first.
        //   2. Dynamic GitHub search on the bare image name, skipping archived repos.
        //
        // Any failure is captured in changelogError and surfaced in the output.
        const appName = container.image.split('/').pop() ?? container.image;

        type GitHubOutput = { releases: { tagName: string; name: string; publishedAt: string; isPreRelease: boolean; isDraft: boolean; body: string; url: string }[]; error?: string };
        type SearchOutput = { results: { fullName: string; stars: number; hasReleases: boolean; archived: boolean }[]; error?: string };

        /** Fetch releases for owner/repo, caching by repoKey. */
        const fetchForRepo = async (repoKey: string) => {
          if (!repoChangelogs.has(repoKey)) {
            const [owner, repo] = repoKey.split('/');
            const ghResult = (await checkGithubReleases.execute!(
              { owner, repo, count: 5 },
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
          return repoChangelogs.get(repoKey)!;
        };

        /**
         * Extract "owner/repo" from a GitHub URL, or null if it's not a
         * recognisable upstream repo URL (e.g. a packaging-only repo like
         * "linuxserver/docker-*" or "hotio/*").
         */
        const parseGithubOwnerRepo = (url: string | null): string | null => {
          if (!url) return null;
          const m = url.match(/github\.com\/([^/]+)\/([^/?#]+)/);
          if (!m) return null;
          // Skip obvious Docker-packaging repos — they don't have upstream releases
          const owner = m[1].toLowerCase();
          const repo = m[2].toLowerCase().replace(/\.git$/, '');
          if (
            owner === 'linuxserver' ||
            owner === 'hotio' ||
            repo.startsWith('docker-') ||
            repo === 'docker'
          ) return null;
          return `${m[1]}/${m[2].replace(/\.git$/, '')}`;
        };

        /**
         * Validate that a GitHub repo name is a plausible match for this
         * container's app name (avoids accepting totally unrelated popular repos).
         */
        const isPlausibleMatch = (repoFullName: string) => {
          const appNameLower = appName.toLowerCase().replace(/[^a-z0-9]/g, '');
          const [owner, repo] = repoFullName.toLowerCase().split('/');
          const combined = `${owner}${repo}`;
          for (let len = Math.min(appNameLower.length, 8); len >= 4; len--) {
            if (combined.includes(appNameLower.slice(0, len))) return true;
          }
          return false;
        };

        try {
          // ── 1. sourceUrl direct lookup ──
          // Many containers set org.opencontainers.image.source to the real
          // upstream GitHub repo. Try it first if it looks legit.
          const sourceRepo = parseGithubOwnerRepo(container.sourceUrl);
          if (sourceRepo) {
            const cached = await fetchForRepo(sourceRepo);
            if (!cached.error && cached.latestVersion) {
              return {
                ...container,
                githubRepo: sourceRepo,
                changelog: cached.changelog,
                latestVersion: cached.latestVersion,
              };
            }
            // sourceUrl led somewhere valid but had no releases — fall through to search
          }

          // ── 2. Dynamic GitHub search ──
          // Skip archived repos (renamed/abandoned — their releases are stale).
          const searchResult = (await searchGithubRepos.execute!(
            { query: appName, maxResults: 5 },
            {},
          )) as SearchOutput;

          const best = searchResult.results.find(
            (r) => r.hasReleases && !r.archived && isPlausibleMatch(r.fullName),
          );

          if (best) {
            const cached = await fetchForRepo(best.fullName);
            return {
              ...container,
              githubRepo: best.fullName,
              changelog: cached.error ? undefined : cached.changelog,
              changelogError: cached.error
                ? `GitHub repo found (${best.fullName}) but releases fetch failed: ${cached.error}`
                : undefined,
              latestVersion: cached.latestVersion || undefined,
            };
          }

          // Search found results but all were archived or implausible — surface that.
          const archivedMatches = searchResult.results.filter(
            (r) => r.archived && isPlausibleMatch(r.fullName),
          );
          if (archivedMatches.length > 0) {
            return {
              ...container,
              githubRepo: undefined,
              changelog: undefined,
              changelogError:
                `GitHub search found only archived repos for "${appName}" ` +
                `(${archivedMatches.map((r) => r.fullName).join(', ')}) — ` +
                `the project may have been renamed or moved. Check Docker Hub or the project site manually.`,
            };
          }
        } catch (err) {
          return {
            ...container,
            githubRepo: undefined,
            changelog: undefined,
            changelogError: `GitHub lookup failed for "${container.image}": ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        return {
          ...container,
          githubRepo: undefined,
          changelog: undefined,
          changelogError: `No matching GitHub repo found for image "${container.image}" — check Docker Hub or the project site manually.`,
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

## Rules for filling the output schema fields

currentVersion:
  - Use runningVersion when it is not null (e.g. "3.4.1" or "0.17.3").
  - runningVersion may be a resolved semver version discovered by matching the
    local image digest against Docker Hub tags — trust it as the real version.
  - When runningVersion IS null, fall back to the container's tag field
    (e.g. "latest", "nightly"). NEVER output "(no current version)".
  - Always strip any leading "v" prefix for consistency (e.g. "0.17.5" not "v0.17.5").

latestVersion:
  - Use the latestVersion field from the changelog data when present.
  - Strip any leading "v" prefix for consistency (e.g. "0.17.7" not "v0.17.7").
  - If no latestVersion is available but the changelog mentions a version tag,
    extract it. Otherwise write the remote image tag (e.g. "latest").
  - NEVER output "(no latest version)".

changesSummary:
  - Write a single, concrete sentence about what changed in the new release.
  - When currentVersion and latestVersion are both semver (e.g. 0.17.3 → 0.17.7),
    summarise ALL intermediate releases in the changelog, not just the latest.
  - If no changelog is available, write: "No changelog found — check
    <githubRepo or Docker Hub page> for release notes."

notes (safeToUpdate only):
  - ONLY use this field for operational context unrelated to the changelog, e.g.
    "pinned version tag — update via Unraid template" or "shared image with immich_ml".
  - NEVER repeat changelog information here.
  - NEVER write "No changelog found" here — that belongs in changesSummary only.
  - Omit the field entirely if there is nothing operationally notable.

warnings (reviewFirst only):
  - Be specific. "Manual check required" alone is not a warning. State WHY
    the user must check: e.g. "Major version bump from 11 to 12 — check for
    breaking config changes." or "GitHub repo was renamed; verify the correct
    update path."

composePinUpdates:
  - parentProject MUST be the GitHub repo that OWNS THE COMPOSE FILE, not the
    image source. E.g. for immich's postgres and redis pins, parentProject is
    "immich-app/immich", not "postgres" or "redis" or "tensorchord/pgvecto-rs".
  - serviceName is the service key inside that compose file (e.g. "postgres", "redis").

Checked at: ${checkedAt}
Total containers: ${totalCount}

## Containers needing updates (${needsUpdateWithChangelogs.length})
${JSON.stringify(needsUpdateWithChangelogs, null, 2)}

## Digest-pinned containers (cannot be updated via Unraid UI) (${digestPinnedWithCompose.length})
${JSON.stringify(digestPinnedWithCompose, null, 2)}

## Up to date (${upToDate.length} containers) — copy these names VERBATIM into the output upToDate array
${JSON.stringify(upToDate)}

## Registry errors (${registryErrors.length})
${JSON.stringify(registryErrors, null, 2)}

Produce a complete report following the output schema exactly.
IMPORTANT: The output upToDate array MUST contain every name listed above — do not omit, abbreviate, or truncate this list.
`.trim();

    const response = await agent.generate(prompt, {      structuredOutput: {
        schema: dockerReportSchema,
        // Use a secondary model for structured output to avoid conflicts
        // with tool-calling constraints (same pattern as the agent-first workflow).
        model: 'openai/gpt-4o-mini',
      },
    });

    const result = response.object;

    // ── Post-AI corrections (deterministic overrides) ──

    // 1. Guarantee upToDate list is complete — the AI may truncate 30+ names.
    if (result.upToDate.length !== upToDate.length) {
      result.upToDate = upToDate;
      result.summary.upToDate = upToDate.length;
    }

    // 2. Guarantee ALL digest-pinned containers appear in composePinUpdates.
    //    The AI drops them when it sees no changes — but they must be listed
    //    so nothing is silently missing from the report.
    const coveredByAI = new Set(result.composePinUpdates.map((c) => c.containerName));
    for (const pinned of digestPinnedWithCompose) {
      if (coveredByAI.has(pinned.name)) continue;
      // Determine the parent project from the compose group, if known
      const composeOwner = (pinned as { composeOwner?: string }).composeOwner;
      const composeRepo = (pinned as { composeRepo?: string }).composeRepo;
      const parentProject =
        composeOwner && composeRepo ? `${composeOwner}/${composeRepo}` : 'unknown';
      const composeCheck = (pinned as { composeCheck?: { pinComparison: { service: string; upstreamImage: string; imageChanged: boolean; upstreamDigest: string; digestChanged: boolean; summary: string }[] } }).composeCheck;
      const pin = composeCheck?.pinComparison?.[0];
      result.composePinUpdates.push({
        containerName: pinned.name,
        serviceName: pin?.service ?? pinned.name.split('_').pop() ?? pinned.name,
        parentProject,
        imageChanged: pin?.imageChanged ?? false,
        digestChanged: pin?.digestChanged ?? false,
        currentImage: `${pinned.image}:${pinned.tag}`,
        newImage: pin?.imageChanged ? pin.upstreamImage : undefined,
        notes: 'Digest-pinned container — no upstream compose changes detected.',
        hasMigrationDocs: false,
      });
    }
    result.summary.composePinsToReview = result.composePinUpdates.filter(
      (c) => c.imageChanged || c.digestChanged,
    ).length;

    // 3. Strip empty notes strings from safeToUpdate (omit rather than "").
    result.safeToUpdate = result.safeToUpdate.map(({ notes, ...rest }) =>
      notes && notes.trim() ? { ...rest, notes } : rest,
    );

    return result;
  },
});

// ── Discord notification step ────────────────────────────────────────────────

const notifyDiscordStep = createStep({
  id: 'notify-discord',
  description: 'Posts the final update report to Discord via webhook. Pass-through — the report is returned unchanged as the workflow output.',
  inputSchema: dockerReportSchema,
  outputSchema: dockerReportSchema,
  execute: async ({ inputData }) => {
    await notifyUpdateReport(inputData);
    return inputData;
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
  .then(resolveRunningVersionsStep)
  .then(fetchChangelogsStep)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(classifyUpdatesStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(notifyDiscordStep as any)
  .commit();
