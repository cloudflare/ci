// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import type { Bindings } from '../env';
import type { CacheSnapshotPointer, DirectoryBackup } from '../pipeline';
import {
  matchSourceControlTreeBlobs,
  type SourceControlTreeBlob,
} from '../source-control';

// Pointer to a previously captured snapshot, stored in BACKUP_BUCKET under
// `cache/<key>.json`. Reused when the cache key's inputs are unchanged.
const BACKUP_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cachePointerSchema = z.object({
  backupId: z.string().regex(BACKUP_ID),
  dir: z.literal('/workspace'),
  producedBySha: z.string().min(1),
  createdAt: z.string().min(1),
});

const backupMetadataSchema = z.object({
  createdAt: z.string().min(1),
  ttl: z.number().finite().positive(),
});

export type CachePointer = z.infer<typeof cachePointerSchema>;

export type CacheKeyInput = {
  repo: string;
  label: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  paths: string[];
  blobs: SourceControlTreeBlob[];
};

// A cache hit yields two distinct things: `snapshot`, the handle to the actual
// workspace backup to restore, and `cachePointer`, the metadata of the
// deterministic R2 pointer that let us find that backup. They are separate
// because only `snapshot` is restorable; `cachePointer` is bookkeeping about the
// indirection, not a workspace.
export type SnapshotCacheLookup =
  | {
      status: 'hit';
      snapshot: DirectoryBackup;
      cachePointer: CacheSnapshotPointer;
    }
  | { status: 'miss' };

export type SnapshotCacheInput = {
  key: string;
  label: string;
};

export type PublishSnapshotCacheInput = SnapshotCacheInput & {
  snapshot: DirectoryBackup;
  producedBySha: string;
};

const CACHE_PREFIX = 'cache';
// Layout the @cloudflare/sandbox backup store writes under BACKUP_BUCKET.
const BACKUP_PREFIX = 'backups';
const BACKUP_META = 'meta.json';
const BACKUP_ARCHIVE = 'data.sqsh';
// Matches the sandbox SDK's own restore-time TTL guard so a pointer we accept
// here won't be rejected as expired when a consumer step restores it minutes
// later.
const TTL_BUFFER_MS = 60_000;

/**
 * Builds a stable cache key from the repository scope, runner label, command
 * settings, and matching source content hashes. Throws when no input paths match.
 */
export async function resolveCacheKey(input: CacheKeyInput): Promise<string> {
  const matches = matchSourceControlTreeBlobs(input.blobs, input.paths);
  if (matches.length === 0) {
    throw new Error(
      `cache(${input.label}): no files matched ${input.paths.join(', ')}`
    );
  }
  const fingerprint = matches
    .map((entry) => `${entry.path}:${entry.sha}`)
    .sort()
    .join('\n');
  const execution = JSON.stringify({
    command: input.command,
    cwd: input.cwd ?? null,
    env: Object.entries(input.env ?? {}).sort(([left], [right]) =>
      left.localeCompare(right)
    ),
  });
  return sha256Hex(
    `${input.repo}\n${input.label}\n${execution}\n${fingerprint}`
  );
}

async function readCachePointer(
  env: Bindings,
  key: string
): Promise<CachePointer | null> {
  const object = await env.BACKUP_BUCKET.get(`${CACHE_PREFIX}/${key}.json`);
  if (!object) {
    return null;
  }
  let value: unknown;
  try {
    value = await object.json<unknown>();
  } catch (error) {
    console.log('[cache] pointer unreadable', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const parsed = cachePointerSchema.safeParse(value);
  if (!parsed.success) {
    console.log('[cache] pointer invalid', {
      key,
      issues: parsed.error.issues,
    });
    return null;
  }
  return parsed.data;
}

async function writeCachePointer(
  env: Bindings,
  key: string,
  pointer: CachePointer
): Promise<void> {
  await env.BACKUP_BUCKET.put(
    `${CACHE_PREFIX}/${key}.json`,
    JSON.stringify(pointer)
  );
}

/**
 * Reads a cache pointer and checks that its Snapshot metadata and archive are
 * still usable. Missing, expired, or invalid data is returned as a cache miss.
 */
export async function lookupSnapshotCache(
  env: Bindings,
  input: SnapshotCacheInput
): Promise<SnapshotCacheLookup> {
  const pointer = await readCachePointer(env, input.key);
  console.log('[cache] pointer read', {
    label: input.label,
    cacheKey: input.key,
    found: pointer !== null,
    backupId: pointer?.backupId,
    producedBySha: pointer?.producedBySha,
  });

  const metadata = pointer
    ? await readBackupMetadata(env, pointer.backupId)
    : null;
  if (pointer && !metadata) {
    console.log('[cache] pointer found but backup unusable (missing/expired)', {
      label: input.label,
      backupId: pointer.backupId,
    });
  }
  console.log('[cache] decision', {
    label: input.label,
    result: pointer && metadata ? 'HIT' : 'MISS',
  });

  if (!pointer || !metadata) {
    return { status: 'miss' };
  }
  return {
    status: 'hit',
    snapshot: { id: pointer.backupId, dir: pointer.dir },
    cachePointer: { key: input.key, ...metadata },
  };
}

/**
 * Makes an already-created workspace backup rediscoverable by a future run.
 * The backup itself is not created here (the sandbox wrote it under a random
 * id); this only writes the second-order indirection: a small R2 pointer at a
 * deterministic, content-addressed key that records the backup's random id.
 * Returns the pointer's metadata. Throws when the backup is missing, expired,
 * or outside `/workspace`.
 */
export async function publishSnapshotCache(
  env: Bindings,
  input: PublishSnapshotCacheInput
): Promise<CacheSnapshotPointer> {
  const { id, dir } = input.snapshot;
  if (dir !== '/workspace') {
    throw new Error(`${input.label} produced a backup outside /workspace`);
  }
  const metadata = await readBackupMetadata(env, id);
  if (!metadata) {
    throw new Error(`${input.label} produced an unreadable cache backup`);
  }
  const cachePointer = { key: input.key, ...metadata };
  await writeCachePointer(env, input.key, {
    backupId: id,
    dir,
    producedBySha: input.producedBySha,
    createdAt: metadata.createdAt,
  });
  console.log('[cache] pointer written', {
    label: input.label,
    cacheKey: input.key,
    backupId: id,
    producedBySha: input.producedBySha,
  });
  return cachePointer;
}

// A pointer is only worth reusing if its backup archive still exists and is
// within its TTL. We read the backup's own metadata (the same objects the
// sandbox SDK checks on restore) rather than trusting the pointer, because the
// pointer JSON has no TTL of its own and outlives a garbage-collected archive.
async function readBackupMetadata(
  env: Bindings,
  backupId: string
): Promise<{ createdAt: string; sizeBytes: number } | null> {
  const meta = await env.BACKUP_BUCKET.get(
    `${BACKUP_PREFIX}/${backupId}/${BACKUP_META}`
  );
  if (!meta) {
    console.log('[cache] backup meta.json missing', { backupId });
    return null;
  }
  let value: unknown;
  try {
    value = await meta.json<unknown>();
  } catch (error) {
    console.log('[cache] backup metadata unreadable', {
      backupId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const parsed = backupMetadataSchema.safeParse(value);
  if (!parsed.success) {
    console.log('[cache] backup metadata invalid', {
      backupId,
      issues: parsed.error.issues,
    });
    return null;
  }
  const { createdAt, ttl } = parsed.data;
  const expiresAt = new Date(createdAt).getTime() + ttl * 1000;
  if (!Number.isFinite(expiresAt) || Date.now() + TTL_BUFFER_MS > expiresAt) {
    console.log('[cache] backup expired or invalid TTL', {
      backupId,
      createdAt,
      ttl,
      expiresAt: Number.isFinite(expiresAt)
        ? new Date(expiresAt).toISOString()
        : String(expiresAt),
      now: new Date().toISOString(),
    });
    return null;
  }
  const archive = await env.BACKUP_BUCKET.head(
    `${BACKUP_PREFIX}/${backupId}/${BACKUP_ARCHIVE}`
  );
  if (!archive) {
    console.log('[cache] backup archive (data.sqsh) missing', { backupId });
    return null;
  }
  return { createdAt, sizeBytes: archive.size };
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
