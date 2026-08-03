import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Bindings } from '../env';
import type { CiRunStepInput, CloudflareArtifacts } from '../pipeline';
import type { SourceControlProvider } from '../source-control';
import {
  cloudflareArtifacts,
  type SourceControlAdapter,
} from '../source-control-adapter';

const mocks = vi.hoisted(() => ({
  lookupSnapshotCache: vi.fn(),
  publishSnapshotCache: vi.fn(),
  resolveCacheKey: vi.fn(),
  run: vi.fn(),
}));

vi.mock('./runners/sandbox', () => ({
  SandboxRunner: class {
    run = mocks.run;
  },
}));

vi.mock('./cache', () => ({
  lookupSnapshotCache: mocks.lookupSnapshotCache,
  publishSnapshotCache: mocks.publishSnapshotCache,
  resolveCacheKey: mocks.resolveCacheKey,
}));

import { runCiStep } from './capabilities';

describe('runCiStep', () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lookupSnapshotCache.mockResolvedValue({ status: 'miss' });
    mocks.resolveCacheKey.mockResolvedValue('cache-key');
    mocks.publishSnapshotCache.mockImplementation((_env, { key }) =>
      Promise.resolve({
        key,
        createdAt: '2026-07-22T00:00:00.000Z',
        sizeBytes: 456,
      })
    );
  });

  it('rejects direct calls for another repository', async () => {
    await expect(
      runCiStep(
        fromPartial<Bindings>({}),
        cloudflareArtifacts({ owner: 'cloudflare', repo: 'example' }),
        { ...input, source: { ...input.source, repo: 'other' } }
      )
    ).rejects.toThrow(
      'Unsupported CI source: cloudflare-artifacts:cloudflare/other'
    );
  });

  it('returns inline logs and a workspace snapshot for uncached runs', async () => {
    mocks.run.mockResolvedValue(successfulRun('lineage-1'));
    const { adapter, succeed } = sourceControl();

    const result = await runCiStep(fromPartial<Bindings>({}), adapter, input);

    expect(result).toEqual({
      exitCode: 0,
      logs: { stdout: 'ok', stderr: '' },
      snapshot: { id: 'lineage-1', dir: '/workspace' },
      cachePointer: undefined,
    });
    expect(succeed).toHaveBeenCalledOnce();
    expect(mocks.publishSnapshotCache).not.toHaveBeenCalled();
  });

  it('injects deployment credentials without using the CI host account', async () => {
    mocks.run.mockResolvedValue(successfulRun('lineage-1'));
    const { adapter } = sourceControl();

    await runCiStep(
      fromPartial<Bindings>({
        CF_TOKEN: 'deploy-token',
        CLOUDFLARE_ACCOUNT_ID: 'ci-host-account',
      }),
      adapter,
      {
        ...input,
        cloudflareCredentials: { accountId: 'deployment-account' },
      }
    );

    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        extraEnv: {
          CLOUDFLARE_ACCOUNT_ID: 'deployment-account',
          CLOUDFLARE_API_TOKEN: 'deploy-token',
        },
      })
    );
  });

  it('rejects malformed deployment credentials before starting a runner', async () => {
    const { adapter } = sourceControl();

    await expect(
      runCiStep(fromPartial<Bindings>({}), adapter, {
        ...input,
        cloudflareCredentials: 'invalid' as never,
      })
    ).rejects.toThrow(
      'runner(test): cloudflareCredentials must be true or contain an accountId'
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('passes inherited lineage to the runner as a restore snapshot', async () => {
    mocks.run.mockResolvedValue(successfulRun('lineage-2'));
    const { adapter } = sourceControl();
    const snapshot = { id: 'lineage-1', dir: '/workspace' };

    await runCiStep(fromPartial<Bindings>({}), adapter, {
      ...input,
      snapshot,
    });

    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({ restore: snapshot })
    );
  });

  it('configures workspace snapshot retention', async () => {
    mocks.run.mockResolvedValue(successfulRun('lineage-1'));
    const { adapter } = sourceControl();

    await runCiStep(fromPartial<Bindings>({}), adapter, {
      ...input,
      snapshotTtlSeconds: 86_400,
    });

    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: 86_400 })
    );
  });

  it('publishes and returns snapshot metadata when cache is configured', async () => {
    mocks.run.mockResolvedValue(successfulRun('cached-1'));
    const { adapter } = sourceControl();

    const result = await runCiStep(fromPartial<Bindings>({}), adapter, {
      ...input,
      cachePaths: ['pnpm-lock.yaml'],
    });

    expect(result.snapshot).toEqual({ id: 'cached-1', dir: '/workspace' });
    expect(result.cachePointer).toEqual({
      key: 'cache-key',
      createdAt: '2026-07-22T00:00:00.000Z',
      sizeBytes: 456,
    });
    expect(mocks.resolveCacheKey).toHaveBeenCalledWith({
      repo: 'cloudflare-artifacts:cloudflare/example:refs/heads/main',
      label: 'test',
      command: 'bun run test',
      cwd: undefined,
      env: undefined,
      paths: ['pnpm-lock.yaml'],
      blobs: [{ path: 'pnpm-lock.yaml', sha: 'blob-sha' }],
    });
    expect(mocks.publishSnapshotCache).toHaveBeenCalledWith(expect.anything(), {
      key: 'cache-key',
      label: 'test',
      snapshot: { id: 'cached-1', dir: '/workspace' },
      producedBySha: 'abc123',
    });
  });

  it('uses an explicit cache scope instead of its branch ref', async () => {
    mocks.run.mockResolvedValue(successfulRun('cached-1'));
    const { adapter } = sourceControl();

    await runCiStep(fromPartial<Bindings>({}), adapter, {
      ...input,
      cachePaths: ['pnpm-lock.yaml'],
      cacheScope: 'refs/cache/custom',
    });

    expect(mocks.resolveCacheKey).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'cloudflare-artifacts:cloudflare/example:refs/cache/custom',
      })
    );
  });

  it('reuses a valid cached backup without starting a sandbox', async () => {
    mocks.lookupSnapshotCache.mockResolvedValue({
      status: 'hit',
      snapshot: { id: 'cached-1', dir: '/workspace' },
      cachePointer: {
        key: 'cache-key',
        createdAt: '2026-07-20T00:00:00.000Z',
        sizeBytes: 456,
      },
    });
    const { adapter } = sourceControl();

    const result = await runCiStep(fromPartial<Bindings>({}), adapter, {
      ...input,
      cachePaths: ['pnpm-lock.yaml'],
    });

    expect(result.snapshot).toEqual({ id: 'cached-1', dir: '/workspace' });
    expect(result.cachePointer?.key).toBe('cache-key');
    expect(result.logs).toEqual({
      stdout: 'cache hit: reusing cached-1',
      stderr: '',
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('rejects empty cache inputs', async () => {
    const { adapter } = sourceControl();

    await expect(
      runCiStep(fromPartial<Bindings>({}), adapter, {
        ...input,
        cachePaths: [],
      })
    ).rejects.toThrow('cache(test): inputs must not be empty');
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('runs without caching when the source fingerprint is unavailable', async () => {
    mocks.run.mockResolvedValue(successfulRun('uncached-1'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, provider } = sourceControl();
    vi.mocked(provider.listTreeBlobs).mockResolvedValue(null);

    const result = await runCiStep(fromPartial<Bindings>({}), adapter, {
      ...input,
      cachePaths: ['pnpm-lock.yaml'],
    });

    expect(result.cachePointer).toBeUndefined();
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.resolveCacheKey).not.toHaveBeenCalled();
    expect(mocks.lookupSnapshotCache).not.toHaveBeenCalled();
    expect(mocks.publishSnapshotCache).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      '[cache] source fingerprint unavailable; skipping cache',
      {
        label: 'test',
        provider: 'cloudflare-artifacts',
        paths: ['pnpm-lock.yaml'],
      }
    );
  });

  it('throws failed commands and does not publish a backup', async () => {
    mocks.run.mockResolvedValue({
      exitCode: 1,
      logs: { stdout: '', stderr: 'failed' },
      preview: { stdout: '', stderr: 'failed' },
    });
    const { adapter, fail } = sourceControl();

    await expect(
      runCiStep(fromPartial<Bindings>({}), adapter, input)
    ).rejects.toThrow('test failed with exit code 1');
    expect(fail).toHaveBeenCalledOnce();
    expect(mocks.publishSnapshotCache).not.toHaveBeenCalled();
  });

  it('redacts injected values from failed command diagnostics', async () => {
    mocks.run.mockResolvedValue({
      exitCode: 1,
      logs: { stdout: '', stderr: 'token=super-secret-value' },
      preview: { stdout: '', stderr: 'token=super-secret-value' },
    });
    const { adapter, fail } = sourceControl();

    const failure = await runCiStep(fromPartial<Bindings>({}), adapter, {
      ...input,
      env: { API_TOKEN: 'super-secret-value' },
    }).catch((error) => error);

    expect(failure.message).toContain('token=[REDACTED]');
    expect(failure.message).not.toContain('super-secret-value');
    expect(JSON.stringify(fail.mock.calls[0]![0])).not.toContain(
      'super-secret-value'
    );
  });
});

function successfulRun(id: string) {
  return {
    exitCode: 0,
    logs: { stdout: 'ok', stderr: '' },
    preview: { stdout: 'ok', stderr: '' },
    snapshot: { id, dir: '/workspace' },
  };
}

function sourceControl() {
  const succeed = vi.fn().mockResolvedValue(undefined);
  const fail = vi.fn().mockResolvedValue(undefined);
  const provider = fromPartial<SourceControlProvider<CloudflareArtifacts>>({
    getSourceCheckout: vi.fn().mockResolvedValue({
      kind: 'archive',
      url: 'https://example.com/source',
    }),
    listTreeBlobs: vi
      .fn()
      .mockResolvedValue([{ path: 'pnpm-lock.yaml', sha: 'blob-sha' }]),
    getStepCredentialEnv: vi.fn().mockResolvedValue({}),
    startStepNotification: vi.fn().mockResolvedValue({ succeed, fail }),
  });
  const adapter = fromPartial<SourceControlAdapter<CloudflareArtifacts>>({
    id: 'cloudflare-artifacts',
    repository: { owner: 'cloudflare', repo: 'example' },
    create: () => provider,
    accepts: () => true,
    assertSource: () => undefined,
  });
  return { adapter, provider, fail, succeed };
}

const input = {
  provider: 'cloudflare-artifacts',
  providerData: { namespace: 'cloudflare' },
  source: {
    owner: 'cloudflare',
    repo: 'example',
    ref: 'refs/heads/main',
    sha: 'abc123',
  },
  instanceId: 'instance-1',
  label: 'test',
  command: 'bun run test',
} satisfies CiRunStepInput;
