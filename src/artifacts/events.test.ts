import { describe, expect, it, vi } from 'vitest';
import { CloudflareArtifactsSourceControlProvider } from './source-control';
import type { SourceControlRepositoryFilter } from '../source-control-adapter';

const pushEvent = {
  id: 'a2e81275-4727-49a7-86b7-20dea8c20b05',
  type: 'cf.artifacts.repo.pushed',
  source: {
    namespace: 'john_pork-ci',
    repoName: 'example',
  },
  payload: {
    ref: 'refs/heads/main',
    before: 'old123',
    after: 'abc123',
    commits: [
      {
        id: 'abc123',
        message: 'ship it',
        author: { name: 'Ada', email: 'ada@example.com' },
      },
    ],
  },
};

describe('CloudflareArtifactsSourceControlProvider', () => {
  it('maps a pushed event to a CI run', async () => {
    const provider = createProvider();

    await expect(
      provider.receiveEvent({
        body: JSON.stringify(pushEvent),
        headers: new Headers(),
      })
    ).resolves.toEqual({
      type: 'run',
      params: {
        provider: 'cloudflare-artifacts',
        providerData: { namespace: 'john_pork-ci' },
        event: { type: 'push' },
        owner: 'john_pork-ci',
        repo: 'example',
        sha: 'abc123',
        remote: 'cloudflare',
        trigger: 'push',
        ref: 'refs/heads/main',
        branch: 'main',
        tag: undefined,
        beforeSha: 'old123',
        headCommitMessage: 'ship it',
        actor: 'Ada',
      },
    });
  });

  it('creates a short-lived authenticated Git checkout', async () => {
    const createToken = vi.fn().mockResolvedValue({ plaintext: 'token' });
    const provider = createProvider({ createToken });
    const source = {
      owner: 'john_pork-ci',
      repo: 'example',
      sha: 'abc123',
      providerData: { namespace: 'john_pork-ci' },
    };

    await expect(provider.getSourceCheckout(source)).resolves.toEqual({
      kind: 'git',
      remote:
        'https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/john_pork-ci/example.git',
      token: 'token',
      sha: 'abc123',
    });
    expect(createToken).toHaveBeenCalledWith('read', 3600);
    await expect(provider.getPushCredentials(source)).resolves.toEqual({
      remote:
        'https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/john_pork-ci/example.git',
      token: 'token',
    });
    expect(createToken).toHaveBeenLastCalledWith('write', 3600);
  });

  it('returns blob hashes for matching files while walking the commit tree', async () => {
    const readCommit = vi.fn().mockResolvedValue({ treeHash: 'root-tree' });
    const readTree = vi.fn(async (hash: string) => {
      if (hash === 'root-tree') {
        return [
          { name: 'bun.lock', mode: '100644', hash: 'blob-lock', type: 'blob' },
          {
            name: 'README.md',
            mode: '100644',
            hash: 'blob-readme',
            type: 'blob',
          },
          {
            name: 'packages',
            mode: '040000',
            hash: 'tree-packages',
            type: 'tree',
          },
        ];
      }
      if (hash === 'tree-packages') {
        return [
          {
            name: 'app',
            mode: '040000',
            hash: 'tree-app',
            type: 'tree',
          },
        ];
      }
      if (hash === 'tree-app') {
        return [
          {
            name: 'index.ts',
            mode: '100644',
            hash: 'blob-index',
            type: 'blob',
          },
        ];
      }
      return null;
    });
    const get = vi.fn().mockResolvedValue({
      createToken: vi.fn().mockResolvedValue({ plaintext: 'token' }),
      readCommit,
      readTree,
    });
    const provider = createProvider({ get });
    const source = {
      owner: 'john_pork-ci',
      repo: 'example',
      sha: 'commit-sha',
      providerData: { namespace: 'john_pork-ci' },
    };

    await expect(
      provider.listTreeBlobs(source, ['bun.lock', 'packages/**'])
    ).resolves.toEqual([
      { path: 'bun.lock', sha: 'blob-lock' },
      { path: 'packages/app/index.ts', sha: 'blob-index' },
    ]);
    expect(readCommit).toHaveBeenCalledWith('commit-sha');
  });

  it.each([
    ['commit read fails', true],
    ['tree read fails', false],
  ])(
    'returns an unavailable fingerprint when %s',
    async (_case, failCommitRead) => {
      const readCommit = failCommitRead
        ? vi.fn().mockRejectedValue(new Error('RPC unavailable'))
        : vi.fn().mockResolvedValue({ treeHash: 'root-tree' });
      const readTree = vi.fn().mockRejectedValue(new Error('RPC unavailable'));
      const get = vi.fn().mockResolvedValue({ readCommit, readTree });
      const provider = createProvider({ get });

      await expect(
        provider.listTreeBlobs(
          {
            owner: 'john_pork-ci',
            repo: 'example',
            sha: 'commit-sha',
            providerData: { namespace: 'john_pork-ci' },
          },
          ['bun.lock']
        )
      ).resolves.toBeNull();
      expect(readCommit).toHaveBeenCalledOnce();
      expect(readTree).toHaveBeenCalledTimes(failCommitRead ? 0 : 1);
    }
  );

  it('ignores Git notes refs', async () => {
    const get = vi.fn();
    const provider = createProvider({ get });
    const event = {
      ...pushEvent,
      payload: { ...pushEvent.payload, ref: 'refs/notes/ai' },
    };

    await expect(
      provider.receiveEvent({
        body: JSON.stringify(event),
        headers: new Headers(),
      })
    ).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('leaves commit-message policy to the pipeline', async () => {
    const provider = createProvider();
    const event = {
      ...pushEvent,
      payload: {
        ...pushEvent.payload,
        commits: [
          { ...pushEvent.payload.commits[0], message: 'docs [skip ci]' },
        ],
      },
    };

    await expect(
      provider.receiveEvent({
        body: JSON.stringify(event),
        headers: new Headers(),
      })
    ).resolves.toMatchObject({
      type: 'run',
      params: { headCommitMessage: 'docs [skip ci]' },
    });
  });

  it('uses the repository configured by the adapter', async () => {
    const provider = createProvider({}, { owner: 'custom', repo: 'project' });
    const event = {
      ...pushEvent,
      source: {
        ...pushEvent.source,
        namespace: 'custom',
        repoName: 'project',
      },
    };

    await expect(
      provider.receiveEvent({
        body: JSON.stringify(event),
        headers: new Headers(),
      })
    ).resolves.toMatchObject({
      type: 'run',
      params: { owner: 'custom', repo: 'project' },
    });
  });

  it('ignores events for another repository', async () => {
    const get = vi.fn();
    const provider = createProvider({ get });
    const event = {
      ...pushEvent,
      source: { ...pushEvent.source, repoName: 'other' },
    };

    await expect(
      provider.receiveEvent({
        body: JSON.stringify(event),
        headers: new Headers(),
      })
    ).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('uses repository identity from the event when no filter is configured', async () => {
    const provider = createProvider({}, {});
    const event = {
      ...pushEvent,
      source: {
        ...pushEvent.source,
        namespace: 'event-namespace',
        repoName: 'event-repo',
      },
    };

    await expect(
      provider.receiveEvent({
        body: JSON.stringify(event),
        headers: new Headers(),
      })
    ).resolves.toMatchObject({
      type: 'run',
      params: { owner: 'event-namespace', repo: 'event-repo' },
    });
  });
});

function createProvider(
  overrides: {
    createToken?: ReturnType<typeof vi.fn>;
    get?: ReturnType<typeof vi.fn>;
  } = {},
  repository: SourceControlRepositoryFilter = {
    owner: 'john_pork-ci',
    repo: 'example',
  }
) {
  const repo = {
    createToken:
      overrides.createToken ??
      vi.fn().mockResolvedValue({ plaintext: 'token' }),
  };
  return new CloudflareArtifactsSourceControlProvider(
    {
      CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      ARTIFACTS: {
        get: overrides.get ?? vi.fn().mockResolvedValue(repo),
      } as unknown as Artifacts,
    },
    repository
  );
}
