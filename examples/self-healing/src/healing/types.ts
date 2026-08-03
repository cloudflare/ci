import type {
  CreatePullRequestResult,
  DirectoryBackup,
  RunnerOptions,
  SourceControlSource,
} from '@cloudflare/ci/worker';

export type VerificationCommand = { command: string; cwd?: string };

export type ObservedFailure = {
  runner: Pick<RunnerOptions, 'name' | 'command' | 'cwd'>;
  output: string;
};

export type HealFailure = {
  runId: string;
  source: SourceControlSource;
  baseBranch: string;
  failures: ObservedFailure[];
  snapshot?: DirectoryBackup;
  verificationCommands: VerificationCommand[];
};

export type HealInput = {
  failure: HealFailure;
  prompt?: string;
};

export type HealResult = {
  branch: string;
  commit: string;
  steps: number;
  pullRequest: CreatePullRequestResult;
};
