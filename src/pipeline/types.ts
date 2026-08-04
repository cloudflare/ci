// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

// Shared contract between the static CI workflow and its sandbox runner.

export type SourceControlProviderDefinition<
  TId extends string = string,
  TEvent extends { type: string } = { type: string },
  TProviderData = unknown,
> = {
  id: TId;
  event: TEvent;
  providerData: TProviderData;
};

export type CloudflareArtifactsEvent = { type: 'push' } | { type: 'tag' };

export type CloudflareArtifactsPushEvent = {
  id?: string;
  type: 'cf.artifacts.repo.pushed';
  source: {
    namespace: string;
    repoName: string;
  };
  payload: {
    ref: string;
    before: string;
    after: string;
    commits: Array<{
      id: string;
      message: string;
      author: { name: string; email: string };
    }>;
  };
};

export type CloudflareArtifacts = SourceControlProviderDefinition<
  'cloudflare-artifacts',
  CloudflareArtifactsEvent,
  { namespace: string }
>;

export type CiProvider = CloudflareArtifacts;

// Serializable sandbox backup handle (mirrors @cloudflare/sandbox's
// DirectoryBackup) passed between CI steps as a snapshot reference.
export type DirectoryBackup = {
  id: string;
  dir: string;
  localBucket?: boolean;
};

// Where a run's source lives. This is display/deployment-origin metadata rather
// than the source-control provider ID.
export type CiRemote = 'cloudflare';

export type CiParams<
  TProvider extends SourceControlProviderDefinition = CiProvider,
> = TProvider extends SourceControlProviderDefinition
  ? {
      provider: TProvider['id'];
      providerData: TProvider['providerData'];
      event: TProvider['event'];
      owner: string;
      repo: string;
      sha: string;
      remote?: CiRemote;

      trigger: 'push' | 'tag';
      // Always the full ref (refs/heads/* or refs/tags/*).
      ref: string;
      branch?: string;
      tag?: string;

      beforeSha?: string;
      headCommitMessage?: string;
      actor?: string;
    }
  : never;

export type CiWorkflowPayload<
  TProvider extends SourceControlProviderDefinition = CiProvider,
> = TProvider extends CloudflareArtifacts
  ? CiParams<TProvider> | CloudflareArtifactsPushEvent
  : CiParams<TProvider>;

export type CiSource<
  TProvider extends SourceControlProviderDefinition = CiProvider,
> = TProvider extends SourceControlProviderDefinition
  ? Pick<CiParams<TProvider>, 'provider' | 'owner' | 'repo' | 'sha'>
  : never;

export type StepConfig = {
  retries?: {
    limit: number;
    delay: number;
    backoff?: 'constant' | 'linear' | 'exponential';
  };
  timeout?: number;
};

export type RunnerConfig = StepConfig & {
  // Maximum command execution time in milliseconds. Defaults to ten seconds
  // less than the durable Workflow step timeout.
  commandTimeoutMs?: number;
  // How long the workspace Snapshot remains restorable, in seconds.
  snapshotRetentionSeconds?: number;
};

export type CiRunStepInput = {
  label: string;
  command: string;
  cwd?: string;
  commandTimeoutMs?: number;
  provider: string;
  providerData: unknown;
  source: { owner: string; repo: string; ref?: string; sha: string };
  cacheScope?: string;
  instanceId: string;
  attempt?: number;
  snapshot?: DirectoryBackup;
  snapshotTtlSeconds?: number;
  // Inject the Cloudflare deployment account and API token into the command
  // env. Scoped per step so build/test/lint commands never see them.
  cloudflareCredentials?: boolean | { accountId: string };
  // Inject provider-specific source-control credentials into the command env.
  sourceControlCredentials?: boolean;
  // When set, the step's snapshot is cached and keyed by the git blob SHAs of
  // these paths (globs allowed). An unchanged key restores the prior snapshot
  // and overlays current source instead of running the command.
  cachePaths?: string[];
  // Literal env injected into the command. Set by the pipeline.
  env?: Record<string, string>;
  // Names of Worker secrets/vars resolved and injected into the command.
  secrets?: string[];
};

export type CiRunStepOutput = {
  exitCode: number;
  logs: CiRunnerLogs;
  // The workspace backup the sandbox writes after every successful runner. The
  // sandbox SDK stores it under a randomly generated id, so this handle is the
  // only way to find it again; the next chained runner restores from it.
  // Always present.
  snapshot: DirectoryBackup;
  // Metadata for the deterministic cache pointer, present only when the runner
  // opted into caching. The pointer is a second-order indirection: a small R2
  // object at a content-addressed key that records `snapshot`'s random id, so a
  // future run can rediscover an otherwise-unfindable backup. See CacheSnapshotPointer.
  cachePointer?: CacheSnapshotPointer;
};

export type RunnerOptions = {
  // Names identify durable Workflow steps and must be deterministic.
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  // TODO: Add `outputs` so cache hits restore only declared paths (for example,
  // node_modules/) onto a fresh checkout instead of reusing a full workspace.
  cache?: { inputs: string[] };
  config?: RunnerConfig;
  cloudflareCredentials?: boolean | { accountId: string };
  // Inject provider-specific source-control credentials into the command env.
  sourceControlCredentials?: boolean;
  // Names of Worker secrets/vars resolved and injected into the command.
  secrets?: string[];
};

// Metadata for a deterministic cache pointer written when a runner opts into
// caching. The sandbox SDK stores workspace backups under random ids, so on its
// own a backup can never be found by a later run. To make one reusable we write
// a small R2 object at a deterministic, content-addressed key that points back
// at the backup's random id. This type describes that pointer, not the backup.
export type CacheSnapshotPointer = {
  // Content-addressed key derived from the runner's cache.inputs.
  key: string;
  createdAt: string;
  // Compressed workspace archive size of the backup the pointer references.
  sizeBytes: number;
};

export type CiRunnerLogs = {
  stdout: string | ReadableStream<Uint8Array>;
  stderr: string | ReadableStream<Uint8Array>;
};

export type CiRunnerResult = CiRunStepOutput & {
  /**
   * Starts a chained runner. On a cache miss, it restores this runner's
   * workspace Snapshot before copying the current source.
   */
  runner(options: RunnerOptions): Promise<CiRunnerResult>;
};

export type CiContext = {
  /**
   * Starts an independent runner with no inherited Snapshot. A cache hit may
   * supply its workspace and skip the command. Separate calls may run in parallel.
   */
  runner(options: RunnerOptions): Promise<CiRunnerResult>;
};
