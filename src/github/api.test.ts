import { describe, expect, it, vi } from 'vitest';
import { listGitHubTreeBlobs } from './api';

const source = {
  owner: 'cloudflare',
  repo: 'workers-sdk',
  sha: 'commit-sha',
};

describe('GitHub API', () => {
  it('returns matching blob hashes from the commit tree', async () => {
    const fetcher = responses(
      jsonResponse({ tree: { sha: 'root-tree' } }),
      jsonResponse({
        truncated: false,
        tree: [
          { path: 'package.json', type: 'blob', sha: 'blob-package' },
          { path: 'README.md', type: 'blob', sha: 'blob-readme' },
          { path: 'packages', type: 'tree', sha: 'tree-packages' },
          {
            path: 'packages/app/package.json',
            type: 'blob',
            sha: 'blob-app-package',
          },
          {
            path: 'vendor/submodule',
            type: 'commit',
            sha: 'submodule-commit',
          },
        ],
      })
    );

    await expect(
      listGitHubTreeBlobs(fetcher, source, [
        'package.json',
        'packages/**/package.json',
      ])
    ).resolves.toEqual([
      { path: 'package.json', sha: 'blob-package' },
      { path: 'packages/app/package.json', sha: 'blob-app-package' },
    ]);
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/cloudflare/workers-sdk/git/commits/commit-sha',
      githubRequest()
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/cloudflare/workers-sdk/git/trees/root-tree?recursive=1',
      githubRequest()
    );
  });

  it('returns an unavailable fingerprint for a truncated tree', async () => {
    const fetcher = responses(
      jsonResponse({ tree: { sha: 'root-tree' } }),
      jsonResponse({ truncated: true, tree: [] })
    );

    await expect(
      listGitHubTreeBlobs(fetcher, source, ['package.json'])
    ).resolves.toBeNull();
  });

  it('throws when the GitHub API request fails', async () => {
    const fetcher = responses(new Response(null, { status: 403 }));

    await expect(
      listGitHubTreeBlobs(fetcher, source, ['package.json'])
    ).rejects.toThrow('GitHub API request failed (403)');
  });

  it('rejects malformed GitHub API responses', async () => {
    const fetcher = responses(jsonResponse({ tree: {} }));

    await expect(
      listGitHubTreeBlobs(fetcher, source, ['package.json'])
    ).rejects.toThrow(/sha/);
  });
});

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function responses(...values: Response[]) {
  return vi.fn<typeof fetch>(async () => values.shift()!);
}

function githubRequest() {
  return {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'cloudflare-ci',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };
}
