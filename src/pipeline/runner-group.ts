// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import { CiRunnerFailure } from './failures';
import type { CiRunnerResult, DirectoryBackup, RunnerOptions } from './types';

type RunnerInvocation = Pick<RunnerOptions, 'name' | 'command' | 'cwd'>;

/**
 * Tracks concurrent and chained runners in one pipeline run.
 * After a failure, it waits for active runners and reports the earliest-started
 * failed runner with diagnostics for every failure that completed.
 */
export class RunnerGroup {
  private readonly active = new Set<Promise<CiRunnerResult>>();
  private readonly failures: CiRunnerFailure[] = [];
  private readonly invocations: RunnerInvocation[] = [];
  private nextOrder = 0;

  run(
    options: RunnerOptions,
    inherited: DirectoryBackup | undefined,
    execute: () => Promise<CiRunnerResult>
  ): Promise<CiRunnerResult> {
    const runner = runnerInvocation(options);
    const order = this.nextOrder++;
    this.invocations.push(runner);

    const execution = execute().catch((cause: unknown) => {
      const failure = new CiRunnerFailure({
        cause,
        order,
        runner,
        snapshot: inherited,
      });
      this.failures.push(failure);
      throw failure;
    });

    this.active.add(execution);
    const remove = () => {
      this.active.delete(execution);
    };
    // Unlike finally(), handling both outcomes consumes the rejection instead
    // of creating an ignored rejected promise. `void` marks cleanup as detached.
    void execution.then(remove, remove);
    return execution.catch((requestedFailure: CiRunnerFailure) =>
      this.settle(requestedFailure)
    );
  }

  private async settle(requestedFailure: CiRunnerFailure): Promise<never> {
    while (this.active.size > 0) {
      // Runners can chain another runner while the current active set settles.
      // eslint-disable-next-line no-await-in-loop
      await Promise.allSettled([...this.active]);
    }

    const failure = this.failures.reduce(
      (first, candidate) => (candidate.order < first.order ? candidate : first),
      requestedFailure
    );

    failure.diagnostics = {
      failures: [...this.failures]
        .sort((left, right) => left.order - right.order)
        .map(({ runner, output }) => ({ runner, output })),
      runners: [...this.invocations],
    };

    throw failure;
  }
}

function runnerInvocation(options: RunnerOptions): RunnerInvocation {
  return {
    name: options.name,
    command: options.command,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  };
}
