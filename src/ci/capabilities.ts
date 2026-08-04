// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import type {
  CiRunStepInput,
  CiRunStepOutput,
  SourceControlProviderDefinition,
} from '../pipeline';
import {
  lookupSnapshotCache,
  publishSnapshotCache,
  resolveCacheKey,
} from './cache';
import type { Bindings } from '../env';
import { SandboxRunner } from './runners/sandbox';
import type {
  SourceControlCheckout,
  SourceControlProvider,
  SourceControlSource,
} from '../source-control';
import type { SourceControlAdapter } from '../source-control-adapter';
import {
  withStepNotification,
  type CompletedStepExecution,
  type StepExecution,
} from './step-notification';

const DEFAULT_SNAPSHOT_TTL_SECONDS = 30 * 24 * 60 * 60;
const cloudflareCredentialsSchema = z.union([
  z.literal(true),
  z.object({ accountId: z.string().min(1) }),
]);

type PreparedStep = {
  // The commit identity ({ owner, repo, sha, providerData }) passed to provider
  // methods (checkout, cache fingerprint, credentials, notifications).
  source: SourceControlSource;
  // The materialization instructions derived from `source` via
  // getSourceCheckout; consumed by the Sandbox runner to fetch the workspace.
  checkout: SourceControlCheckout;
  cacheKey?: string;
  extraEnv: Record<string, string>;
};

/**
 * Runs one CI runner inside the current Workflow version.
 * A valid cache entry skips the command and returns its Snapshot as a success.
 * Otherwise, it resolves checkout data and requested secrets, runs the command
 * in Sandbox, and reports the result.
 * Running inside the versioned Workflow means only its configured pipeline can
 * request Worker secrets.
 */
export async function runCiStep<
  TProvider extends SourceControlProviderDefinition,
>(
  env: Bindings,
  sourceControl: SourceControlAdapter<TProvider>,
  input: CiRunStepInput
): Promise<CiRunStepOutput> {
  sourceControl.assertSource({
    provider: input.provider,
    owner: input.source.owner,
    repo: input.source.repo,
  });
  const sourceControlProvider = sourceControl.create(env);
  const prepared = await prepareStep(env, sourceControlProvider, input);
  const handle = await sourceControlProvider.startStepNotification({
    source: prepared.source,
    instanceId: input.instanceId,
    label: input.label,
    command: input.command,
  });

  return withStepNotification(
    {
      handle,
      label: input.label,
      command: input.command,
      sensitiveValues: Object.values(prepared.extraEnv),
    },
    () => executeStep(env, input, prepared),
    (execution) => finalizeStep(env, input, prepared, execution)
  );
}

/**
 * Gathers everything a step needs before running: fetches the checkout and
 * cache key from the provider (network), and builds the command env by merging
 * literal env, Cloudflare/source-control credentials, and named Worker secrets.
 * Throws if a requested secret is missing. Mutates only local state.
 */
async function prepareStep(
  env: Bindings,
  sourceControlProvider: SourceControlProvider,
  input: CiRunStepInput
): Promise<PreparedStep> {
  const source = {
    ...input.source,
    providerData: input.providerData,
  };
  const checkout = await sourceControlProvider.getSourceCheckout(source);
  const cacheKey = await resolveStepCacheKey(
    sourceControlProvider,
    source,
    input
  );
  const extraEnv: Record<string, string> = { ...input.env };
  if (
    input.cloudflareCredentials !== undefined &&
    input.cloudflareCredentials !== false
  ) {
    const credentials = normalizeCloudflareCredentials(
      input.cloudflareCredentials,
      input.label
    );
    extraEnv.CLOUDFLARE_API_TOKEN = env.CF_TOKEN;
    if (credentials.accountId) {
      extraEnv.CLOUDFLARE_ACCOUNT_ID = credentials.accountId;
    }
  }
  if (input.sourceControlCredentials) {
    // copy source control provider env vars to extraEnv
    Object.assign(
      extraEnv,
      await sourceControlProvider.getStepCredentialEnv(source)
    );
  }

  // copy the selected secrets from env to extraEnv
  for (const name of input.secrets ?? []) {
    const value = env[name];
    if (typeof value !== 'string') {
      throw new Error(
        `Secret ${name} is either not configured on ci-cd-worker or not a string.`
      );
    }
    extraEnv[name] = value;
  }

  return { source, checkout, cacheKey, extraEnv };
}

/**
 * Runs the command in a fresh Sandbox, or short-circuits on a cache hit.
 * On a hit it returns the cached snapshot with synthetic logs and no command
 * runs; on a miss it spawns the SandboxRunner (restoring the inherited
 * snapshot) and returns its real output. No persistent writes.
 */
async function executeStep(
  env: Bindings,
  input: CiRunStepInput,
  prepared: PreparedStep
): Promise<StepExecution> {
  const runner = new SandboxRunner(env);
  const runInput = {
    label: input.label,
    command: input.command,
    cwd: input.cwd,
    timeoutMs: input.commandTimeoutMs,
    source: prepared.checkout,
    ttlSeconds: input.snapshotTtlSeconds ?? DEFAULT_SNAPSHOT_TTL_SECONDS,
    extraEnv: prepared.extraEnv,
  };

  const cache = prepared.cacheKey
    ? await lookupSnapshotCache(env, {
        key: prepared.cacheKey,
        label: input.label,
      })
    : { status: 'miss' as const };
  if (cache.status === 'hit') {
    // The cache only stores the workspace snapshot, not run output, so there is
    // no original preview/logs to replay; synthesize a placeholder message.
    // TODO: consider persisting the preview in the pointer to return real logs.
    const message = `cache hit: reusing ${cache.snapshot.id}`;
    const execution = {
      exitCode: 0,
      logs: { stdout: message, stderr: '' },
      preview: { stdout: message, stderr: '' },
      // A hit gives us both: the backup to restore (snapshot) and the pointer
      // metadata that found it (cachePointer). Distinct roles, same origin.
      snapshot: cache.snapshot,
      cachePointer: cache.cachePointer,
      cacheHit: true,
    } satisfies StepExecution;
    return execution;
  }

  const result = await runner.run({ ...runInput, restore: input.snapshot });
  return {
    exitCode: result.exitCode,
    logs: result.logs,
    preview: result.preview,
    snapshot: result.snapshot,
    cacheHit: false,
  };
}

/**
 * Publishes the deterministic cache pointer for the step's workspace backup when
 * eligible, as a side effect. No-op for uncacheable steps and cache hits (which
 * already carry a pointer); otherwise calls publishSnapshotCache to write the R2
 * pointer and attaches the resulting pointer metadata to the returned execution.
 * The backup itself is created by the sandbox runner, not here.
 */
async function finalizeStep(
  env: Bindings,
  input: CiRunStepInput,
  prepared: PreparedStep,
  execution: CompletedStepExecution
): Promise<CompletedStepExecution> {
  if (!prepared.cacheKey || execution.cachePointer) {
    return execution;
  }
  // Write the small JSON pointer at the deterministic cache key. It records the
  // randomly generated id of the sandbox workspace backup so a future run can
  // rediscover it; the backup already exists, we only add the indirection.
  const cachePointer = await publishSnapshotCache(env, {
    key: prepared.cacheKey,
    label: input.label,
    snapshot: execution.snapshot,
    producedBySha: input.source.sha,
  });
  return { ...execution, cachePointer };
}

/**
 * Computes the content-addressed cache key from the source blob SHAs of the
 * step's cache paths (network: lists tree blobs). Returns undefined when
 * caching is off or the provider can't fingerprint the source; throws when
 * cache paths are configured but empty.
 */
async function resolveStepCacheKey(
  sourceControlProvider: SourceControlProvider,
  source: SourceControlSource,
  input: CiRunStepInput
) {
  if (!input.cachePaths) {
    return undefined;
  }
  if (input.cachePaths.length === 0) {
    throw new Error(`cache(${input.label}): inputs must not be empty`);
  }
  const blobs = await sourceControlProvider.listTreeBlobs(
    source,
    input.cachePaths
  );
  if (blobs === null) {
    console.warn('[cache] source fingerprint unavailable; skipping cache', {
      label: input.label,
      provider: input.provider,
      paths: input.cachePaths,
    });
    return undefined;
  }
  const scope = `${input.provider}:${input.source.owner}/${input.source.repo}:${input.cacheScope ?? input.source.ref ?? input.source.sha}`;
  const cacheKey = await resolveCacheKey({
    // Scope writable caches by ref so an untrusted branch cannot publish a
    // workspace later restored by the default branch. Pull requests use their
    // synthetic refs/pull/<number>/head scope; ref-less events fall back to SHA.
    repo: scope,
    label: input.label,
    command: input.command,
    cwd: input.cwd,
    env: input.env,
    paths: input.cachePaths,
    blobs,
  });
  console.log('[cache] key computed', {
    label: input.label,
    cacheKey,
    scope,
    paths: input.cachePaths,
    matchedBlobs: blobs.map((blob) => `${blob.path}:${blob.sha}`),
  });
  return cacheKey;
}

/**
 * Validates the runner's cloudflareCredentials option and returns the optional
 * accountId. Pure; throws when the value is neither true nor an accountId.
 */
function normalizeCloudflareCredentials(
  value: CiRunStepInput['cloudflareCredentials'],
  label: string
): { accountId?: string } {
  const parsed = cloudflareCredentialsSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data === true ? {} : parsed.data;
  }
  throw new Error(
    `runner(${label}): cloudflareCredentials must be true or contain an accountId`
  );
}
