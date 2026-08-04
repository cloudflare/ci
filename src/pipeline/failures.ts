// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { DirectoryBackup, RunnerOptions } from './types';

export type CiObservedRunnerFailure = {
  runner: Pick<RunnerOptions, 'name' | 'command' | 'cwd'>;
  output: string;
};

export type CiRunnerFailureDiagnostics = {
  failures: CiObservedRunnerFailure[];
  runners: Array<Pick<RunnerOptions, 'name' | 'command' | 'cwd'>>;
};

export type CiRunnerFailureInput = {
  cause: unknown;
  order: number;
  runner: Pick<RunnerOptions, 'name' | 'command' | 'cwd'>;
  snapshot?: DirectoryBackup;
};

/**
 * Describes a failed runner and the workspace Snapshot it inherited.
 * It retains the last 20,000 characters of the original output. Parallel
 * diagnostics are attached after the active runner group has settled.
 */
export class CiRunnerFailure extends Error {
  readonly order: number;
  readonly runner: Pick<RunnerOptions, 'name' | 'command' | 'cwd'>;
  readonly snapshot?: DirectoryBackup;
  readonly output: string;
  diagnostics: CiRunnerFailureDiagnostics;

  constructor({ cause, order, runner, snapshot }: CiRunnerFailureInput) {
    const rawOutput = cause instanceof Error ? cause.message : String(cause);
    const output =
      rawOutput.length > 20_000
        ? `[diagnostic truncated]\n${rawOutput.slice(-20_000)}`
        : rawOutput;
    super(`${runner.name} failed: ${output}`, { cause });
    this.name = 'CiRunnerFailure';
    this.order = order;
    this.runner = runner;
    this.snapshot = snapshot;
    this.output = output;
    this.diagnostics = {
      failures: [{ runner, output }],
      runners: [runner],
    };
  }
}

export function isCiRunnerFailure(value: unknown): value is CiRunnerFailure {
  return value instanceof CiRunnerFailure;
}
