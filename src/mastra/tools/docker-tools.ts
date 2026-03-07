import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool: List Docker Containers (live from Unraid API)
// ---------------------------------------------------------------------------

export const listDockerContainers = createTool({
  id: 'list-docker-containers',
  description:
    'Queries the Unraid GraphQL API to get the LIVE list of Docker containers ' +
    'running on the server, including their state, image, running version, and status. ' +
    'The runningVersion field is extracted from container labels (org.opencontainers.image.version ' +
    'or build_version). Use this to compare against GitHub releases. ' +
    'Requires UNRAID_API_URL and UNRAID_API_KEY env vars.',
  inputSchema: z.object({
    stateFilter: z
      .enum(['running', 'exited', 'all'])
      .nullable()
      .describe('Filter by container state. Defaults to "all". Pass null to use the default.'),
  }),
  outputSchema: z.object({
    containers: z.array(
      z.object({
        dockerId: z.string().describe('Actual Docker container ID (short hash) — use this as the mutation identifier, not imageId.'),
        name: z.string(),
        image: z.string(),
        tag: z.string(),
        imageId: z.string(),
        digestPin: z.string().nullable().describe('If the image is digest-pinned (e.g. @sha256:...), this is the pinned digest. null otherwise.'),
        runningVersion: z.string().nullable(),
        state: z.string(),
        status: z.string(),
        autoStart: z.boolean().optional(),
        sourceUrl: z.string().nullable().describe('GitHub URL from org.opencontainers.image.source label — often points to the Docker packaging repo, not the upstream app'),
      }),
    ),
    totalCount: z.number(),
    error: z.string().optional(),
  }),
  execute: async ({ stateFilter }) => {
    const apiUrl = process.env.UNRAID_API_URL;
    const apiKey = process.env.UNRAID_API_KEY;

    if (!apiUrl || !apiKey) {
      return {
        containers: [],
        totalCount: 0,
        error:
          'Missing UNRAID_API_URL or UNRAID_API_KEY environment variables. ' +
          'Set them in .env — URL is your Unraid server GraphQL endpoint ' +
          '(e.g. http://unraid.local/graphql) and API key is from ' +
          'Settings → Management Access → API Keys.',
      };
    }

    const query = `
      query {
        docker {
          containers {
            id
            names
            image
            imageId
            state
            status
            autoStart
            labels
          }
        }
      }
    `;

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) {
        return {
          containers: [],
          totalCount: 0,
          error: `Unraid API ${response.status}: ${response.statusText}`,
        };
      }

      const json = (await response.json()) as {
        data?: {
          docker?: {
            containers?: Array<{
              id: string;
              names: string[];
              image: string;
              imageId: string;
              state: string;
              status: string;
              autoStart: boolean;
              labels: Record<string, string> | null;
            }>;
          };
        };
        errors?: Array<{ message: string }>;
      };

      if (json.errors?.length) {
        return {
          containers: [],
          totalCount: 0,
          error: `GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`,
        };
      }

      const raw = json.data?.docker?.containers ?? [];

      const containers = raw
        .filter((c) => {
          if (!stateFilter || stateFilter === 'all') return true;
          return c.state.toLowerCase() === stateFilter;
        })
        .map((c) => {
          const imageWithTag = c.image;

          // Handle digest-pinned images: image:tag@sha256:... or image@sha256:...
          let imageName: string;
          let tag: string;
          let digestPin: string | null = null;

          const atIdx = imageWithTag.indexOf('@sha256:');
          const baseRef = atIdx !== -1 ? imageWithTag.slice(0, atIdx) : imageWithTag;
          if (atIdx !== -1) {
            digestPin = imageWithTag.slice(atIdx + 1); // 'sha256:abc...'
          }

          if (baseRef.includes(':')) {
            imageName = baseRef.slice(0, baseRef.lastIndexOf(':'));
            tag = baseRef.slice(baseRef.lastIndexOf(':') + 1);
          } else {
            imageName = baseRef;
            tag = 'latest';
          }

          // Extract running version from OCI labels
          const labels = c.labels ?? {};
          const rawVersion =
            labels['org.opencontainers.image.version'] ||
            // linuxserver images use build_version: "Linuxserver.io version:- X.Y.Z-lsNNN ..."
            (labels['build_version']?.match(/version:-\s*([^\s]+)/)?.[1]) ||
            null;

          // Reject Ubuntu/Debian-style release names (e.g. "24.04", "22.04") that
          // leak through from base image labels — they are not the app version.
          const isOsVersion = rawVersion !== null && /^\d{2}\.\d{2}$/.test(rawVersion);
          const runningVersion = isOsVersion ? null : rawVersion;

          // Extract source URL from OCI labels (may point to Docker packaging repo)
          const sourceUrl = labels['org.opencontainers.image.source'] || null;

          return {
            dockerId: c.id,
            // Container names from Docker often start with "/", strip it
            name: (c.names?.[0] ?? c.id).replace(/^\//, ''),
            image: imageName,
            tag,
            digestPin,
            imageId: c.imageId,
            runningVersion,
            state: c.state,
            status: c.status,
            autoStart: c.autoStart,
            sourceUrl,
          };
        });

      return {
        containers,
        totalCount: containers.length,
      };
    } catch (error) {
      return {
        containers: [],
        totalCount: 0,
        error: `Failed to query Unraid API: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Tool: Check GitHub Releases
// ---------------------------------------------------------------------------

export const checkGithubReleases = createTool({
  id: 'check-github-releases',
  description:
    'Fetches the latest GitHub releases for a repository. Use this to see ' +
    'what versions are available, read changelogs, and determine if an ' +
    'update is safe. Supports an optional GITHUB_TOKEN env var for higher ' +
    'rate limits (unauthenticated: 60 req/hr, authenticated: 5000 req/hr).',
  inputSchema: z.object({
    owner: z.string().describe('GitHub repository owner/organization (e.g. "jellyfin")'),
    repo: z.string().describe('GitHub repository name (e.g. "jellyfin")'),
    count: z
      .number()
      .nullable()
      .describe('Number of recent releases to fetch (default: 2, max: 10). Pass null to use the default.'),
  }),
  outputSchema: z.object({
    repository: z.string(),
    releases: z.array(
      z.object({
        tagName: z.string(),
        name: z.string(),
        publishedAt: z.string(),
        isPreRelease: z.boolean(),
        isDraft: z.boolean(),
        body: z.string(),
        url: z.string(),
      }),
    ),
    rateLimitRemaining: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ owner, repo, count }) => {
    const perPage = Math.min(count ?? 2, 10);
    const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${perPage}`;

    try {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'mastra-docker-update-agent',
      };

      if (process.env.GITHUB_TOKEN) {
        headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
      }

      const response = await fetch(url, { headers });

      const rateLimitRemaining = Number(response.headers.get('x-ratelimit-remaining') ?? -1);

      if (!response.ok) {
        return {
          repository: `${owner}/${repo}`,
          releases: [],
          rateLimitRemaining: rateLimitRemaining >= 0 ? rateLimitRemaining : undefined,
          error: `GitHub API ${response.status}: ${response.statusText}`,
        };
      }

      const data = (await response.json()) as Array<{
        tag_name: string;
        name: string | null;
        published_at: string;
        prerelease: boolean;
        draft: boolean;
        body: string | null;
        html_url: string;
      }>;

      return {
        repository: `${owner}/${repo}`,
        releases: data.map((release) => ({
          tagName: release.tag_name,
          name: release.name || release.tag_name,
          publishedAt: release.published_at,
          isPreRelease: release.prerelease,
          isDraft: release.draft,
          // Truncate huge changelogs to keep token usage manageable
          body: (release.body || 'No release notes provided.').slice(0, 500),
          url: release.html_url,
        })),
        rateLimitRemaining: rateLimitRemaining >= 0 ? rateLimitRemaining : undefined,
      };
    } catch (error) {
      return {
        repository: `${owner}/${repo}`,
        releases: [],
        error: `Failed to fetch: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

interface RegistryInfo {
  registryUrl: string;
  tokenUrl: string;
  repo: string;
}

/**
 * Parse a Docker image name into registry URL, auth token URL, and repo path.
 */
function parseRegistry(image: string): RegistryInfo {
  // GHCR
  if (image.startsWith('ghcr.io/')) {
    const repo = image.replace('ghcr.io/', '');
    return {
      registryUrl: 'https://ghcr.io',
      tokenUrl: `https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull`,
      repo,
    };
  }

  // LSCR (Linux Server Container Registry) — proxies to GHCR
  if (image.startsWith('lscr.io/')) {
    const repo = image.replace('lscr.io/', '');
    return {
      registryUrl: 'https://ghcr.io',
      tokenUrl: `https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull`,
      repo,
    };
  }

  // Docker Hub — strip common prefixes (docker.io/, index.docker.io/)
  let stripped = image;
  for (const prefix of ['docker.io/', 'index.docker.io/']) {
    if (stripped.startsWith(prefix)) {
      stripped = stripped.slice(prefix.length);
      break;
    }
  }
  // Official images use library/ prefix (e.g. "redis" → "library/redis")
  const repo = stripped.includes('/') ? stripped : `library/${stripped}`;
  return {
    registryUrl: 'https://registry-1.docker.io',
    tokenUrl: `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
    repo,
  };
}

/**
 * Get an auth token for pulling manifests.
 * Uses Docker Hub credentials (DOCKERHUB_USERNAME + DOCKERHUB_TOKEN) when
 * available to avoid anonymous rate-limits / 401s. Falls back to anonymous.
 */
async function getRegistryToken(tokenUrl: string): Promise<string> {
  const headers: Record<string, string> = {};

  // Docker Hub auth endpoint accepts Basic auth to issue an authenticated token
  const dhUser = process.env.DOCKERHUB_USERNAME;
  const dhToken = process.env.DOCKERHUB_TOKEN;
  if (dhUser && dhToken && tokenUrl.includes('auth.docker.io')) {
    const creds = Buffer.from(`${dhUser}:${dhToken}`).toString('base64');
    headers['Authorization'] = `Basic ${creds}`;
  }

  const res = await fetch(tokenUrl, { headers });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { token: string };
  return data.token;
}

/**
 * Fetch the image config digest from the registry for a given tag.
 * Handles both single-arch manifests and multi-arch manifest lists.
 */
async function getRemoteConfigDigest(
  registryUrl: string,
  repo: string,
  tag: string,
  token: string,
): Promise<string> {
  const manifestUrl = `${registryUrl}/v2/${repo}/manifests/${tag}`;
  const acceptHeaders = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ].join(', ');

  const res = await fetch(manifestUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: acceptHeaders,
    },
  });

  if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status} ${res.statusText}`);

  const manifest = (await res.json()) as {
    schemaVersion: number;
    mediaType?: string;
    config?: { digest: string };
    manifests?: Array<{
      digest: string;
      platform?: { architecture: string; os: string };
      mediaType: string;
    }>;
  };

  // Single-arch manifest — config.digest is the image config hash = imageId
  if (manifest.config?.digest) {
    return manifest.config.digest;
  }

  // Multi-arch manifest list — find the amd64/linux entry
  if (manifest.manifests?.length) {
    const amd64 = manifest.manifests.find(
      (m) => m.platform?.architecture === 'amd64' && m.platform?.os === 'linux',
    );
    const target = amd64 ?? manifest.manifests[0];

    // Fetch platform-specific manifest to get config.digest
    const platRes = await fetch(`${registryUrl}/v2/${repo}/manifests/${target.digest}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
      },
    });

    if (!platRes.ok) throw new Error(`Platform manifest fetch failed: ${platRes.status}`);

    const platManifest = (await platRes.json()) as { config?: { digest: string } };
    if (platManifest.config?.digest) {
      return platManifest.config.digest;
    }
  }

  throw new Error('Could not extract config digest from manifest');
}

// ---------------------------------------------------------------------------
// Tool: Check Registry Updates
// ---------------------------------------------------------------------------

export const checkRegistryUpdates = createTool({
  id: 'check-registry-updates',
  description:
    'Checks Docker registries (Docker Hub, GHCR, LSCR) to determine if newer ' +
    'images are available for the given containers. Compares the remote image ' +
    'config digest against the local imageId. If they match, the container is ' +
    'truly up to date — regardless of what GitHub releases say. ' +
    'Accepts up to 20 containers per call. You MUST call this for every container — never skip any.',
  inputSchema: z.object({
    containers: z.array(
      z.object({
        image: z.string().describe('Full image name without tag (e.g. "ghcr.io/hotio/radarr")'),
        tag: z.string().describe('Image tag (e.g. "latest")'),
        localImageId: z.string().describe('Local imageId from Unraid (sha256:...)'),
      }).describe('Containers to check. Max 20 per call - send as many as possible per batch.')),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        image: z.string(),
        tag: z.string(),
        updateAvailable: z.boolean(),
        localDigest: z.string(),
        remoteDigest: z.string().optional(),
        error: z.string().optional(),
      }),
    ),
  }),
  execute: async ({ containers }) => {
    const batch = containers.slice(0, 20);

    const results = await Promise.all(
      batch.map(async ({ image, tag, localImageId }) => {
        try {
          const { registryUrl, tokenUrl, repo } = parseRegistry(image);
          const token = await getRegistryToken(tokenUrl);
          const remoteDigest = await getRemoteConfigDigest(registryUrl, repo, tag, token);

          return {
            image,
            tag,
            updateAvailable: remoteDigest !== localImageId,
            localDigest: localImageId,
            remoteDigest,
          };
        } catch (error) {
          return {
            image,
            tag,
            updateAvailable: false,
            localDigest: localImageId,
            error: `Registry check failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
    );

    return { results };
  },
});

// ---------------------------------------------------------------------------
// Tool: Resolve Running Version From Digest
// ---------------------------------------------------------------------------

export const resolveVersionFromDigest = createTool({
  id: 'resolve-version-from-digest',
  description:
    'For Docker Hub images with floating tags (latest/nightly), fetches recent ' +
    'semver tags and finds which one has a config digest matching the local imageId. ' +
    'This reveals the actual version running under a floating tag (e.g. "v0.17.3" ' +
    'instead of just "latest"). Only works for Docker Hub images.',
  inputSchema: z.object({
    image: z.string().describe('Full image name without tag (e.g. "ollama/ollama")'),
    localDigest: z.string().describe('Local imageId / config digest from Unraid (sha256:...)'),
  }),
  outputSchema: z.object({
    resolvedVersion: z
      .string()
      .nullable()
      .describe('Semver version tag matching the local digest, or null if not found'),
    checkedTags: z.number().describe('How many tags were checked before giving up'),
    error: z.string().optional(),
  }),
  execute: async ({ image, localDigest }) => {
    try {
      const { registryUrl, tokenUrl, repo } = parseRegistry(image);

      // Only Docker Hub for now — GHCR tags API differs
      if (!tokenUrl.includes('auth.docker.io')) {
        return { resolvedVersion: null, checkedTags: 0 };
      }

      // Docker Hub tags API — sorted by last_updated so newest tags come first
      const tagsUrl = `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=50&ordering=last_updated`;
      const tagsRes = await fetch(tagsUrl);
      if (!tagsRes.ok) {
        return {
          resolvedVersion: null,
          checkedTags: 0,
          error: `Docker Hub tags API ${tagsRes.status}: ${tagsRes.statusText}`,
        };
      }

      const tagsData = (await tagsRes.json()) as {
        results: Array<{ name: string }>;
      };

      // Keep only semver-looking tags; drop floating, platform-specific, and pre-release tags
      const FLOATING = new Set(['latest', 'nightly', 'stable', 'edge', 'dev', 'main', 'master']);
      const semverTags = tagsData.results
        .map((t) => t.name)
        .filter(
          (name) =>
            /^v?\d+\.\d+/.test(name) &&
            !FLOATING.has(name.toLowerCase()) &&
            !/-rc\d*/i.test(name) &&
            !/-beta/i.test(name) &&
            !/-alpha/i.test(name),
        )
        .slice(0, 15); // check at most 15 recent semver tags

      const token = await getRegistryToken(tokenUrl);

      let checkedTags = 0;
      for (const semverTag of semverTags) {
        try {
          checkedTags++;
          const configDigest = await getRemoteConfigDigest(registryUrl, repo, semverTag, token);
          if (configDigest === localDigest) {
            return { resolvedVersion: semverTag, checkedTags };
          }
        } catch {
          // skip this tag and try the next
        }
      }

      return { resolvedVersion: null, checkedTags };
    } catch (error) {
      return {
        resolvedVersion: null,
        checkedTags: 0,
        error: `Version resolution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Tool: Search GitHub Repos
// ---------------------------------------------------------------------------

export const searchGithubRepos = createTool({
  id: 'search-github-repos',
  description:
    'Searches GitHub for repositories matching a query. Use this to discover ' +
    'the upstream GitHub repo for a Docker container when the sourceUrl label ' +
    'points to a Docker packaging repo (e.g. hotio/radarr) rather than the ' +
    'upstream app (e.g. Radarr/Radarr).',
  inputSchema: z.object({
    query: z.string().describe('Search query (e.g. "radarr" or "jellyfin media server")'),
    maxResults: z
      .number()
      .nullable()
      .describe('Max results to return (default: 5, max: 10). Pass null to use the default.'),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        fullName: z.string(),
        description: z.string(),
        stars: z.number(),
        url: z.string(),
        hasReleases: z.boolean(),
        archived: z.boolean().describe('True when the GitHub repo is archived (read-only / abandoned). Prefer non-archived repos.'),
      }),
    ),
    error: z.string().optional(),
  }),
  execute: async ({ query, maxResults }) => {
    const perPage = Math.min(maxResults ?? 5, 10);
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}`;

    try {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'mastra-docker-update-agent',
      };

      if (process.env.GITHUB_TOKEN) {
        headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
      }

      const response = await fetch(url, { headers });

      if (!response.ok) {
        return {
          results: [],
          error: `GitHub Search API ${response.status}: ${response.statusText}`,
        };
      }

      const data = (await response.json()) as {
        items: Array<{
          full_name: string;
          description: string | null;
          stargazers_count: number;
          html_url: string;
          archived: boolean;
        }>;
      };

      // Quick check for releases on top results
      const results = await Promise.all(
        data.items.map(async (item) => {
          let hasReleases = false;
          try {
            const relUrl = `https://api.github.com/repos/${item.full_name}/releases?per_page=1`;
            const relRes = await fetch(relUrl, { headers });
            if (relRes.ok) {
              const rels = (await relRes.json()) as Array<unknown>;
              hasReleases = rels.length > 0;
            }
          } catch {
            // ignore — just mark as unknown
          }

          return {
            fullName: item.full_name,
            description: item.description || 'No description',
            stars: item.stargazers_count,
            url: item.html_url,
            hasReleases,
            archived: item.archived ?? false,
          };
        }),
      );

      return { results };
    } catch (error) {
      return {
        results: [],
        error: `Failed to search: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Helpers for upstream compose checking
// ---------------------------------------------------------------------------

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'mastra-docker-update-agent',
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

interface ParsedImagePin {
  /** Compose service name (e.g. "redis", "database") */
  service: string;
  /** Full image reference without digest, e.g. "redis:6.2-alpine" */
  image: string;
  /** The sha256 digest, e.g. "sha256:abc123..." */
  digest: string;
}

/**
 * Parse image references with digest pins from a docker-compose YAML string.
 * Also extracts the service name so we can match by role, not just image name.
 * Handles patterns like:
 *   redis:
 *     image: docker.io/valkey/valkey:9@sha256:abc123
 */
function parseComposePins(yaml: string): ParsedImagePin[] {
  const pins: ParsedImagePin[] = [];
  const lines = yaml.split('\n');
  let currentService: string | null = null;
  let inServices = false;

  for (const line of lines) {
    // Detect the top-level "services:" block
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }

    if (inServices) {
      // A top-level key under services (2-space or no indent, followed by ':')
      const serviceMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
      if (serviceMatch) {
        currentService = serviceMatch[1];
        continue;
      }

      // Exit services block if we hit another top-level key (no indent)
      if (/^[a-zA-Z]/.test(line) && !line.startsWith(' ')) {
        inServices = false;
        currentService = null;
        continue;
      }

      // Match image line with digest pin
      const imageMatch = line.match(/^\s+image:\s*(.+?)@(sha256:[a-f0-9]+)/);
      if (imageMatch && currentService) {
        pins.push({
          service: currentService,
          image: imageMatch[1].trim().replace(/^["']|["']$/g, ''),
          digest: imageMatch[2],
        });
      }
    }
  }

  // Fallback: if service-aware parsing found nothing, try the simple regex
  if (pins.length === 0) {
    const regex = /^\s*image:\s*(.+?)@(sha256:[a-f0-9]+)/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(yaml)) !== null) {
      pins.push({
        service: 'unknown',
        image: match[1].trim().replace(/^["']|["']$/g, ''),
        digest: match[2],
      });
    }
  }

  return pins;
}

/** Keywords that signal breaking changes in release notes */
const BREAKING_KEYWORDS = [
  /\bbreaking\s*change/i,
  /\bBREAKING\b/,
  /\bmigration\s*required/i,
  /\baction\s*required/i,
  /\bdeprecated?\b/i,
  /\bremoved\b/i,
  /\b⚠️/,
  /\bdatabase\s*migration/i,
  /\bschema\s*change/i,
  /\bbackup\s*(your|the)?\s*(database|db|data)\b/i,
];

function extractBreakingChanges(body: string, version: string): string[] {
  const lines = body.split('\n');
  const matches: string[] = [];

  for (const line of lines) {
    for (const kw of BREAKING_KEYWORDS) {
      if (kw.test(line)) {
        matches.push(`[${version}] ${line.trim()}`);
        break; // one match per line is enough
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Tool: Update Docker Container (Unraid mutation)
// ---------------------------------------------------------------------------

/**
 * Triggers Unraid to pull the latest image for a container and restart it
 * via mutation { docker { updateContainer(id: PrefixedID) } }.
 *
 * HTTP 400 from GraphQL means the query is syntactically malformed — most
 * commonly caused by including a selection set on a scalar return or omitting
 * one on an object return. We try both forms to handle either case.
 */
export const updateDockerContainer = createTool({
  id: 'update-docker-container',
  description:
    'Updates a Docker container on Unraid via the GraphQL docker.updateContainer mutation. ' +
    'Requires UNRAID_API_URL and UNRAID_API_KEY.',
  inputSchema: z.object({
    containerId: z.string().describe(
      'The Unraid container ID as returned by list-docker-containers (dockerId field).',
    ),
    containerName: z.string().describe('Container name as shown in Unraid (e.g. "mealie").'),
    image: z.string().describe('Full image name without tag (e.g. "ghcr.io/mealie-recipes/mealie").'),
    tag: z.string().describe('Image tag (e.g. "latest").'),
    dryRun: z
      .boolean()
      .optional()
      .describe('When true, skips the mutation and returns what would have been called.'),
  }),
  outputSchema: z.object({
    containerName: z.string(),
    success: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ containerId, containerName, image, tag, dryRun }) => {
    const apiUrl = process.env.UNRAID_API_URL;
    const apiKey = process.env.UNRAID_API_KEY;

    if (!apiUrl || !apiKey) {
      return {
        containerName,
        success: false,
        message: 'Missing UNRAID_API_URL or UNRAID_API_KEY environment variable.',
        error: 'Missing UNRAID_API_URL or UNRAID_API_KEY',
      };
    }

    if (dryRun) {
      return {
        containerName,
        success: true,
        message:
          `[dry-run] Would call: mutation { docker { updateContainer(id: "${containerId}") { id names state status } } } ` +
          `(image=${image}:${tag})`,
      };
    }

    const MUTATION_TIMEOUT_MS = 30_000;

    const post = async (query: string) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MUTATION_TIMEOUT_MS);
      try {
        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify({ query }),
          signal: controller.signal,
        });
        const text = await res.text();
        let body: { data?: unknown; errors?: { message: string }[] } = {};
        try {
          body = JSON.parse(text) as typeof body;
        } catch {
          // Non-JSON response (e.g. Unraid HTML error page) — surface the raw text
          return { ok: false, status: res.status, body, rawText: text.slice(0, 500) };
        }
        return { ok: res.ok, status: res.status, body, rawText: undefined };
      } finally {
        clearTimeout(timer);
      }
    };

    // Inline the ID directly (no variables) — the schema uses PrefixedID, not ID,
    // so $id: ID! variable declarations are rejected with HTTP 400.
    // Confirmed via curl: returns DockerContainer! so object selection set is required.
    // The raw `id` from the containers query IS the PrefixedID on this Unraid version.
    const idCandidates = [containerId, `docker:${containerName}`, containerName];
    const attempts: string[] = [];

    for (const id of idCandidates) {
      const query = `mutation { docker { updateContainer(id: "${id}") { id names state status } } }`;
      try {
        const { ok, status, body, rawText } = await post(query);

        if (rawText !== undefined) {
          // Unraid returned non-JSON — log the raw body so we can diagnose it
          attempts.push(`id=${id} → HTTP ${status}, non-JSON response: ${rawText}`);
          continue;
        }

        if (!ok) {
          attempts.push(`id=${id} → HTTP ${status}`);
          continue;
        }

        if (body.errors?.length) {
          attempts.push(`id=${id} → ${body.errors.map(e => e.message).join('; ')}`);
          continue;
        }

        return {
          containerName,
          success: true,
          message: `✓ Updated "${containerName}" via docker.updateContainer (id=${id}).`,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        attempts.push(`id=${id} → ${e instanceof Error && e.name === 'AbortError' ? `timed out after ${MUTATION_TIMEOUT_MS / 1000}s` : msg}`);
      }
    }

    return {
      containerName,
      success: false,
      message: `docker.updateContainer failed for "${containerName}": ${attempts.join(' | ')}`,
      error: attempts.join(' | '),
    };
  },
});

// ---------------------------------------------------------------------------
// Tool: Introspect Unraid Mutations
// ---------------------------------------------------------------------------

export const introspectUnraidMutations = createTool({
  id: 'introspect-unraid-mutations',
  description:
    'Runs GraphQL introspection against the Unraid API to find all mutation fields, ' +
    'including sub-fields of nested object types (e.g. mutation { docker { ... } }). ' +
    'Results are prefixed — top-level fields are shown as-is, nested fields as "docker.fieldName". ' +
    'Use this when update-docker-container reports all variants failed.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    mutations: z.array(
      z.object({
        path: z.string().describe('Mutation path, e.g. "docker.updateContainer" or "createNotification"'),
        args: z.array(z.object({ name: z.string(), type: z.string() })),
      }),
    ),
    error: z.string().optional(),
  }),
  execute: async () => {
    const apiUrl = process.env.UNRAID_API_URL;
    const apiKey = process.env.UNRAID_API_KEY;

    if (!apiUrl || !apiKey) {
      return { mutations: [], error: 'Missing UNRAID_API_URL or UNRAID_API_KEY' };
    }

    type GqlType = {
      kind: string;
      name: string | null;
      ofType?: GqlType | null;
    };
    type GqlArg = { name: string; type: GqlType };
    type GqlField = { name: string; args: GqlArg[]; type: GqlType };

    function resolveTypeName(t: GqlType): string {
      if (t.name) return t.name;
      if (t.ofType) return resolveTypeName(t.ofType);
      return t.kind;
    }

    async function gql(query: string): Promise<unknown> {
      const res = await fetch(apiUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey! },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return res.json();
    }

    try {
      // ── Pass 1: top-level mutation fields + their return type names ──────────
      const pass1 = (await gql(`
        query {
          __schema {
            mutationType {
              fields {
                name
                args { name type { kind name ofType { kind name ofType { kind name } } } }
                type { kind name ofType { kind name ofType { kind name } } }
              }
            }
          }
        }
      `)) as {
        data?: { __schema?: { mutationType?: { fields?: GqlField[] } } };
        errors?: { message: string }[];
      };

      if (pass1.errors?.length) {
        return { mutations: [], error: pass1.errors.map((e) => e.message).join('; ') };
      }

      const topFields = pass1.data?.__schema?.mutationType?.fields ?? [];
      const results: { path: string; args: { name: string; type: string }[] }[] = [];
      const nestedObjectTypes: { fieldName: string; typeName: string }[] = [];

      for (const f of topFields) {
        const returnTypeName = resolveTypeName(f.type);
        const isObjectType = f.type.kind === 'OBJECT' ||
          (f.type.kind === 'NON_NULL' && f.type.ofType?.kind === 'OBJECT');

        if (isObjectType && f.args.length === 0) {
          // Nested namespace (like `docker`) — drill in with pass 2
          nestedObjectTypes.push({ fieldName: f.name, typeName: returnTypeName });
        } else {
          results.push({
            path: f.name,
            args: f.args.map((a) => ({ name: a.name, type: resolveTypeName(a.type) })),
          });
        }
      }

      // ── Pass 2: resolve sub-fields of each nested object type ───────────────
      for (const { fieldName, typeName } of nestedObjectTypes) {
        if (!typeName) continue;
        try {
          const pass2 = (await gql(`
            query {
              __type(name: "${typeName}") {
                fields {
                  name
                  args { name type { kind name ofType { kind name ofType { kind name } } } }
                }
              }
            }
          `)) as {
            data?: { __type?: { fields?: GqlField[] } };
            errors?: { message: string }[];
          };

          const subFields = pass2.data?.__type?.fields ?? [];
          for (const sf of subFields) {
            results.push({
              path: `${fieldName}.${sf.name}`,
              args: sf.args.map((a) => ({ name: a.name, type: resolveTypeName(a.type) })),
            });
          }
        } catch {
          // sub-type lookup failed — just note the parent with no args
          results.push({ path: `${fieldName}.*`, args: [] });
        }
      }

      // Sort: docker/container matches first, then alphabetical
      results.sort((a, b) => {
        const aRel = /docker|container/i.test(a.path) ? 0 : 1;
        const bRel = /docker|container/i.test(b.path) ? 0 : 1;
        if (aRel !== bRel) return aRel - bRel;
        return a.path.localeCompare(b.path);
      });

      return { mutations: results };
    } catch (error) {
      return {
        mutations: [],
        error: `Introspection failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Tool: Check Upstream Compose File
// ---------------------------------------------------------------------------

export const checkUpstreamCompose = createTool({
  id: 'check-upstream-compose',
  description:
    'Fetches the latest docker-compose file from an upstream GitHub project (via release ' +
    'assets or repo tree) and compares digest-pinned image references against your current ' +
    'pins. Also scans all release notes between your current version and the latest for ' +
    'breaking changes, migration requirements, and deprecations. Use this for digest-pinned ' +
    'containers to determine if the upstream project recommends updating the compose file.',
  inputSchema: z.object({
    owner: z.string().describe('GitHub repo owner (e.g. "immich-app")'),
    repo: z.string().describe('GitHub repo name (e.g. "immich")'),
    composePath: z
      .string()
      .nullable()
      .describe(
        'Path to compose file in the repo (e.g. "docker-compose.yml"). ' +
        'The tool first checks release assets for this filename, then falls back to repo contents at the release tag. ' +
        'Defaults to "docker-compose.yml". Pass null to use the default.',
      ),
    currentVersion: z
      .string()
      .nullable()
      .describe(
        'Your current version/release tag (e.g. "v1.120.0"). If provided, all releases between ' +
        'this version and latest are scanned for breaking changes. Pass null to check only the latest release.',
      ),
    currentPins: z
      .array(
        z.object({
          service: z
            .string()
            .describe('Compose service name (e.g. "redis", "database")'),
          image: z
            .string()
            .describe('Full image reference without digest (e.g. "docker.io/redis:6.2-alpine")'),
          digest: z
            .string()
            .describe('Current sha256 digest pin from your compose file'),
        }),
      )
      .nullable()
      .describe('Your current digest pins to compare against the upstream compose file. Include service names from your compose. Pass null if not comparing pins.'),
  }),
  outputSchema: z.object({
    latestVersion: z.string(),
    currentVersion: z.string().optional(),
    composeFound: z.boolean(),
    composeSource: z
      .string()
      .optional()
      .describe('Where the compose file was fetched from (release asset or repo path)'),
    pinComparison: z.array(
      z.object({
        service: z.string().describe('Compose service name'),
        upstreamImage: z.string(),
        yourImage: z.string().optional(),
        imageChanged: z.boolean().describe('True if the upstream uses a completely different image than yours'),
        upstreamDigest: z.string(),
        yourDigest: z.string().optional(),
        digestChanged: z.boolean().describe('True if digests differ (either image swap or rebuild)'),
        summary: z.string().describe('Human-readable summary of what changed for this service'),
      }),
    ),
    breakingChanges: z
      .array(z.string())
      .describe('Lines from release notes that mention breaking changes, prefixed with version'),
    releasesBetween: z
      .array(
        z.object({
          version: z.string(),
          date: z.string(),
          highlights: z.string(),
          hasBreakingIndicators: z.boolean(),
        }),
      )
      .describe('All releases between currentVersion and latest, summarized'),
    error: z.string().optional(),
  }),
  execute: async ({ owner, repo, composePath, currentVersion, currentPins }) => {
    composePath = composePath ?? 'docker-compose.yml';
    const headers = githubHeaders();
    const repoSlug = `${owner}/${repo}`;

    try {
      // ----- Step 1: Get latest release -----
      const latestRes = await fetch(
        `https://api.github.com/repos/${repoSlug}/releases/latest`,
        { headers },
      );
      if (!latestRes.ok) {
        return {
          latestVersion: '',
          composeFound: false,
          pinComparison: [],
          breakingChanges: [],
          releasesBetween: [],
          error: `Failed to fetch latest release: ${latestRes.status} ${latestRes.statusText}`,
        };
      }
      const latestRelease = (await latestRes.json()) as {
        tag_name: string;
        body: string | null;
        published_at: string;
        assets: Array<{ name: string; browser_download_url: string }>;
      };
      const latestVersion = latestRelease.tag_name;

      // ----- Step 2: Fetch compose file -----
      let composeYaml: string | null = null;
      let composeSource: string | null = null;
      const composeFilename = composePath.split('/').pop() ?? composePath;

      // Try release assets first
      const asset = latestRelease.assets.find(
        (a) => a.name === composeFilename || a.name === composePath,
      );
      if (asset) {
        const assetRes = await fetch(asset.browser_download_url, {
          headers: { 'User-Agent': 'mastra-docker-update-agent' },
        });
        if (assetRes.ok) {
          composeYaml = await assetRes.text();
          composeSource = `release asset: ${asset.name} (${latestVersion})`;
        }
      }

      // Fallback: fetch from repo tree at the release tag
      if (!composeYaml) {
        const contentsRes = await fetch(
          `https://api.github.com/repos/${repoSlug}/contents/${composePath}?ref=${latestVersion}`,
          { headers: { ...headers, Accept: 'application/vnd.github.v3.raw' } },
        );
        if (contentsRes.ok) {
          composeYaml = await contentsRes.text();
          composeSource = `repo file: ${composePath} @ ${latestVersion}`;
        }
      }

      // Also try without 'v' prefix if tag-based lookup failed
      if (!composeYaml && latestVersion.startsWith('v')) {
        const altTag = latestVersion.slice(1);
        const contentsRes = await fetch(
          `https://api.github.com/repos/${repoSlug}/contents/${composePath}?ref=${altTag}`,
          { headers: { ...headers, Accept: 'application/vnd.github.v3.raw' } },
        );
        if (contentsRes.ok) {
          composeYaml = await contentsRes.text();
          composeSource = `repo file: ${composePath} @ ${altTag}`;
        }
      }

      // ----- Step 3: Parse and compare pins -----
      let pinComparison: Array<{
        service: string;
        upstreamImage: string;
        yourImage?: string;
        imageChanged: boolean;
        upstreamDigest: string;
        yourDigest?: string;
        digestChanged: boolean;
        summary: string;
      }> = [];

      if (composeYaml) {
        const upstreamPins = parseComposePins(composeYaml);

        const normalizeImage = (img: string) =>
          img.replace(/^(docker\.io|index\.docker\.io)\//, '');

        pinComparison = upstreamPins.map((up) => {
          const normalizedUpImage = normalizeImage(up.image);

          // Match by service name first, then fall back to image name
          const matchByService = currentPins?.find((cp) => cp.service === up.service);
          const matchByImage = currentPins?.find(
            (cp) => normalizeImage(cp.image) === normalizedUpImage,
          );
          const match = matchByService ?? matchByImage;

          if (!match) {
            return {
              service: up.service,
              upstreamImage: up.image,
              imageChanged: false,
              upstreamDigest: up.digest,
              digestChanged: false,
              summary: 'New pinned service in upstream compose (not in your current file)',
            };
          }

          const normalizedYourImage = normalizeImage(match.image);
          const imageSwapped = normalizedUpImage !== normalizedYourImage;
          const digestDiffers = match.digest !== up.digest;

          let summary: string;
          if (imageSwapped) {
            summary = `IMAGE REPLACED: upstream switched from ${match.image} to ${up.image}. This is a significant change — review migration notes.`;
          } else if (digestDiffers) {
            summary = `Digest updated: same image (${up.image}) but tag was rebuilt with new pin.`;
          } else {
            summary = 'No change — your pin matches upstream.';
          }

          return {
            service: up.service,
            upstreamImage: up.image,
            yourImage: match.image,
            imageChanged: imageSwapped,
            upstreamDigest: up.digest,
            yourDigest: match.digest,
            digestChanged: digestDiffers || imageSwapped,
            summary,
          };
        });
      }

      // ----- Step 4: Fetch releases between current and latest -----
      const allBreakingChanges: string[] = [];
      const releasesBetween: Array<{
        version: string;
        date: string;
        highlights: string;
        hasBreakingIndicators: boolean;
      }> = [];

      if (currentVersion && currentVersion !== latestVersion) {
        // Fetch up to 30 releases and filter to those between current and latest
        let page = 1;
        let foundCurrent = false;
        const maxPages = 3; // up to 90 releases

        while (!foundCurrent && page <= maxPages) {
          const relRes = await fetch(
            `https://api.github.com/repos/${repoSlug}/releases?per_page=30&page=${page}`,
            { headers },
          );
          if (!relRes.ok) break;

          const releases = (await relRes.json()) as Array<{
            tag_name: string;
            published_at: string;
            body: string | null;
            prerelease: boolean;
            draft: boolean;
          }>;
          if (releases.length === 0) break;

          for (const rel of releases) {
            // Skip the current version itself — we want releases AFTER it
            if (rel.tag_name === currentVersion) {
              foundCurrent = true;
              break;
            }
            // Skip pre-releases and drafts
            if (rel.prerelease || rel.draft) continue;

            const body = rel.body || '';
            const breaking = extractBreakingChanges(body, rel.tag_name);
            allBreakingChanges.push(...breaking);

            releasesBetween.push({
              version: rel.tag_name,
              date: rel.published_at,
              highlights: body.slice(0, 300),
              hasBreakingIndicators: breaking.length > 0,
            });
          }

          page++;
        }
      } else {
        // No current version — just check the latest release notes
        const body = latestRelease.body || '';
        const breaking = extractBreakingChanges(body, latestVersion);
        allBreakingChanges.push(...breaking);
      }

      return {
        latestVersion,
        currentVersion: currentVersion ?? undefined,
        composeFound: composeYaml !== null,
        composeSource: composeSource ?? undefined,
        pinComparison,
        breakingChanges: allBreakingChanges,
        releasesBetween,
      };
    } catch (error) {
      return {
        latestVersion: '',
        composeFound: false,
        pinComparison: [],
        breakingChanges: [],
        releasesBetween: [],
        error: `Failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});