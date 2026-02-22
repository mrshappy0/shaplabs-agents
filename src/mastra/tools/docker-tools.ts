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
      .optional()
      .describe('Filter by container state. Defaults to "all".'),
  }),
  outputSchema: z.object({
    containers: z.array(
      z.object({
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
          const runningVersion =
            labels['org.opencontainers.image.version'] ||
            // linuxserver images use build_version: "Linuxserver.io version:- X.Y.Z-lsNNN ..."
            (labels['build_version']?.match(/version:-\s*([^\s]+)/)?.[1]) ||
            null;

          // Extract source URL from OCI labels (may point to Docker packaging repo)
          const sourceUrl = labels['org.opencontainers.image.source'] || null;

          return {
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
      .optional()
      .describe('Number of recent releases to fetch (default: 2, max: 10)'),
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
  execute: async ({ owner, repo, count = 2 }) => {
    const perPage = Math.min(count, 10);
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

  // Docker Hub — official images use library/ prefix
  const repo = image.includes('/') ? image : `library/${image}`;
  return {
    registryUrl: 'https://registry-1.docker.io',
    tokenUrl: `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
    repo,
  };
}

/**
 * Get an anonymous auth token for pulling manifests.
 */
async function getRegistryToken(tokenUrl: string): Promise<string> {
  const res = await fetch(tokenUrl);
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
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
// Tool: Search GitHub Repos
// ---------------------------------------------------------------------------

export const searchGithubRepos = createTool({
  id: 'search-github-repos',
  description:
    'Searches GitHub for repositories matching a query. Use this to discover ' +
    'the upstream GitHub repo for a Docker container when the sourceUrl label ' +
    'points to a Docker packaging repo (e.g. hotio/radarr) rather than the ' +
    'upstream app (e.g. Radarr/Radarr). Save discovered mappings to your ' +
    'working memory so you don\'t have to search again.',
  inputSchema: z.object({
    query: z.string().describe('Search query (e.g. "radarr" or "jellyfin media server")'),
    maxResults: z
      .number()
      .optional()
      .describe('Max results to return (default: 5, max: 10)'),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        fullName: z.string(),
        description: z.string(),
        stars: z.number(),
        url: z.string(),
        hasReleases: z.boolean(),
      }),
    ),
    error: z.string().optional(),
  }),
  execute: async ({ query, maxResults = 5 }) => {
    const perPage = Math.min(maxResults, 10);
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
          has_downloads: boolean;
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