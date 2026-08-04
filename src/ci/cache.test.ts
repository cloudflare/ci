import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Bindings } from '../env';
import { matchSourceControlTreeBlobs } from '../source-control';
import {
  lookupSnapshotCache,
  publishSnapshotCache,
  resolveCacheKey,
  type CacheKeyInput,
} from './cache';

describe('resolveCacheKey', () => {
  it.each([
    ['command', { command: 'bun run build:prod' }],
    ['cwd', { cwd: 'packages/app' }],
    ['env', { env: { NODE_ENV: 'production' } }],
  ])('changes when %s changes', async (_field, change) => {
    expect(await resolveCacheKey({ ...input, ...change })).not.toBe(
      await resolveCacheKey(input)
    );
  });

  it('is independent of env insertion order', async () => {
    const first = await resolveCacheKey({
      ...input,
      env: { NODE_ENV: 'production', REGION: 'eu' },
    });
    const second = await resolveCacheKey({
      ...input,
      env: { REGION: 'eu', NODE_ENV: 'production' },
    });

    expect(first).toBe(second);
  });
});

describe('matchSourceControlTreeBlobs', () => {
  const tree = [
    { path: 'index.ts', sha: 'root' },
    { path: 'src/index.ts', sha: 'nested' },
    { path: 'foo/bar.ts', sha: 'direct' },
    { path: 'foo/a/bar.ts', sha: 'deep' },
    { path: '?literal.ts', sha: 'literal' },
  ];

  it.each([
    [
      '**/*.ts',
      ['index.ts', 'src/index.ts', 'foo/bar.ts', 'foo/a/bar.ts', '?literal.ts'],
    ],
    ['foo/**/bar.ts', ['foo/bar.ts', 'foo/a/bar.ts']],
    ['src/*.ts', ['src/index.ts']],
    ['?literal.ts', ['?literal.ts']],
  ])('matches %s', (pattern, expected) => {
    expect(matchSourceControlTreeBlobs(tree, [pattern])).toEqual(
      tree.filter((entry) => expected.includes(entry.path))
    );
  });
});

describe('snapshot cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
  });

  afterEach(() => vi.useRealTimers());

  it('misses when no pointer exists', async () => {
    const bucket = fakeBucket();

    await expect(
      lookupSnapshotCache(bindings(bucket), { key: 'key-1', label: 'build' })
    ).resolves.toEqual({ status: 'miss' });
    expect(bucket.get).toHaveBeenCalledWith('cache/key-1.json');
    expect(bucket.head).not.toHaveBeenCalled();
  });

  it.each([
    { backupId: 123 },
    { ...cachePointer, backupId: 'not-a-uuid' },
    { ...cachePointer, dir: 'workspace' },
    { ...cachePointer, dir: '/workspace/../tmp' },
    { ...cachePointer, dir: '/workspace\0escape' },
  ])('misses when the pointer is malformed', async (pointer) => {
    const bucket = fakeBucket({ pointer });

    await expect(
      lookupSnapshotCache(bindings(bucket), { key: 'key-1', label: 'build' })
    ).resolves.toEqual({ status: 'miss' });
    expect(bucket.head).not.toHaveBeenCalled();
  });

  it('misses when pointer JSON cannot be decoded', async () => {
    const bucket = fakeBucket({ pointer: new SyntaxError('invalid JSON') });

    await expect(
      lookupSnapshotCache(bindings(bucket), { key: 'key-1', label: 'build' })
    ).resolves.toEqual({ status: 'miss' });
    expect(bucket.head).not.toHaveBeenCalled();
  });

  it('returns a snapshot when the pointer and backup are usable', async () => {
    const bucket = fakeBucket({ pointer: cachePointer });

    await expect(
      lookupSnapshotCache(bindings(bucket), { key: 'key-1', label: 'build' })
    ).resolves.toEqual({
      status: 'hit',
      snapshot: { id: backupId, dir: '/workspace' },
      cachePointer: {
        key: 'key-1',
        createdAt: '2026-07-30T00:00:00.000Z',
        sizeBytes: 123,
      },
    });
  });

  it('misses when the pointed-to backup is expired', async () => {
    const bucket = fakeBucket({
      pointer: cachePointer,
      metadata: { createdAt: '2026-07-01T00:00:00.000Z', ttl: 60 },
    });

    await expect(
      lookupSnapshotCache(bindings(bucket), { key: 'key-1', label: 'build' })
    ).resolves.toEqual({ status: 'miss' });
    expect(bucket.head).not.toHaveBeenCalled();
  });

  it('misses when backup metadata is malformed', async () => {
    const bucket = fakeBucket({
      pointer: cachePointer,
      metadata: { createdAt: '2026-07-30T00:00:00.000Z', ttl: 'forever' },
    });

    await expect(
      lookupSnapshotCache(bindings(bucket), { key: 'key-1', label: 'build' })
    ).resolves.toEqual({ status: 'miss' });
    expect(bucket.head).not.toHaveBeenCalled();
  });

  it('misses when backup metadata JSON cannot be decoded', async () => {
    const bucket = fakeBucket({
      pointer: cachePointer,
      metadata: new SyntaxError('invalid JSON'),
    });

    await expect(
      lookupSnapshotCache(bindings(bucket), { key: 'key-1', label: 'build' })
    ).resolves.toEqual({ status: 'miss' });
    expect(bucket.head).not.toHaveBeenCalled();
  });

  it('misses when backup expiry overflows', async () => {
    const bucket = fakeBucket({
      pointer: cachePointer,
      metadata: {
        createdAt: '2026-07-30T00:00:00.000Z',
        ttl: Number.MAX_VALUE,
      },
    });

    await expect(
      lookupSnapshotCache(bindings(bucket), { key: 'key-1', label: 'build' })
    ).resolves.toEqual({ status: 'miss' });
    expect(bucket.head).not.toHaveBeenCalled();
  });

  it('publishes a usable backup and returns its cache metadata', async () => {
    const bucket = fakeBucket();

    await expect(
      publishSnapshotCache(bindings(bucket), {
        key: 'key-1',
        label: 'build',
        snapshot: { id: backupId, dir: '/workspace' },
        producedBySha: 'commit-1',
      })
    ).resolves.toEqual({
      key: 'key-1',
      createdAt: '2026-07-30T00:00:00.000Z',
      sizeBytes: 123,
    });
    expect(bucket.put).toHaveBeenCalledWith(
      'cache/key-1.json',
      JSON.stringify({
        backupId,
        dir: '/workspace',
        producedBySha: 'commit-1',
        createdAt: '2026-07-30T00:00:00.000Z',
      })
    );
  });

  it('refuses to publish a backup outside the runner workspace', async () => {
    const bucket = fakeBucket();

    await expect(
      publishSnapshotCache(bindings(bucket), {
        key: 'key-1',
        label: 'build',
        snapshot: { id: backupId, dir: '/tmp' },
        producedBySha: 'commit-1',
      })
    ).rejects.toThrow('build produced a backup outside /workspace');
    expect(bucket.put).not.toHaveBeenCalled();
  });
});

function fakeBucket(options?: { pointer?: unknown; metadata?: unknown }) {
  const metadata =
    options && 'metadata' in options
      ? options.metadata
      : {
          createdAt: '2026-07-30T00:00:00.000Z',
          ttl: 30 * 24 * 60 * 60,
        };
  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (key.startsWith('cache/')) {
        return Promise.resolve(
          options && 'pointer' in options
            ? { json: () => json(options.pointer) }
            : null
        );
      }
      return Promise.resolve({ json: () => json(metadata) });
    }),
    head: vi.fn().mockResolvedValue({ size: 123 }),
    put: vi.fn().mockResolvedValue(undefined),
  };
}

function json(value: unknown) {
  return value instanceof Error
    ? Promise.reject(value)
    : Promise.resolve(value);
}

function bindings(bucket: ReturnType<typeof fakeBucket>) {
  return fromPartial<Bindings>({ BACKUP_BUCKET: bucket });
}

const backupId = '123e4567-e89b-12d3-a456-426614174000';

const cachePointer = {
  backupId,
  dir: '/workspace',
  producedBySha: 'commit-1',
  createdAt: '2026-07-30T00:00:00.000Z',
};

const input = {
  repo: 'cloudflare-artifacts:cloudflare/example:refs/heads/main',
  label: 'build',
  command: 'bun run build',
  paths: ['bun.lock'],
  blobs: [{ path: 'bun.lock', sha: 'blob-sha' }],
} satisfies CacheKeyInput;
