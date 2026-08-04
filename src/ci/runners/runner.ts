// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SourceControlCheckout } from '../../source-control';

export type RunStepInput = {
  label: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  source: SourceControlCheckout;
  extraEnv?: Record<string, string>;
  // Snapshot TTL in seconds. Omitted falls back to the sandbox default (3 days).
  ttlSeconds?: number;
};

export type RunOutput = {
  exitCode: number;
  logs: {
    stdout: string | ReadableStream<Uint8Array>;
    stderr: string | ReadableStream<Uint8Array>;
  };
  preview: { stdout: string; stderr: string };
};

export type RunStepResult<S> = RunOutput & {
  snapshot?: S;
};

export interface Runner<S> {
  readonly name: string;
  run(input: RunStepInput & { restore?: S }): Promise<RunStepResult<S>>;
}
