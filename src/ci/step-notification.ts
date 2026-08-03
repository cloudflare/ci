// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  CacheSnapshotPointer,
  CiRunStepOutput,
  CiRunnerLogs,
  DirectoryBackup,
} from '../pipeline';
import type { StepNotificationHandle } from '../source-control';

export type StepExecution = {
  exitCode: number;
  logs: CiRunnerLogs;
  preview: { stdout: string; stderr: string };
  // The restorable workspace backup (always produced on success), kept separate
  // from the cache pointer below: `snapshot` is the thing you restore,
  // `cachePointer` is only bookkeeping for the deterministic cache indirection.
  snapshot?: DirectoryBackup;
  cachePointer?: CacheSnapshotPointer;
  cacheHit: boolean;
};

export type CompletedStepExecution = StepExecution & {
  snapshot: DirectoryBackup;
};

/**
 * Runs and finalizes a runner, then reports success or failure.
 * Failure output is redacted and streamed-log cancellation is attempted.
 * Reporting and cleanup errors do not replace the original runner failure.
 */
export async function withStepNotification(
  input: {
    handle: StepNotificationHandle | null;
    label: string;
    command: string;
    sensitiveValues: string[];
  },
  execute: () => Promise<StepExecution>,
  finalize: (
    execution: CompletedStepExecution
  ) => Promise<CompletedStepExecution>
): Promise<CiRunStepOutput> {
  const startedAt = Date.now();
  let execution: StepExecution | undefined;

  try {
    execution = await execute();
    if (execution.exitCode !== 0) {
      const { stdout, stderr } = redactPreview(
        execution.preview,
        input.sensitiveValues
      );
      throw new Error(
        `${input.label} failed with exit code ${execution.exitCode}\n=== stdout ===\n${stdout}\n=== stderr ===\n${stderr}`
      );
    }
    if (!execution.snapshot) {
      throw new Error(`${input.label} did not produce a workspace snapshot`);
    }
    const completed = await finalize({
      ...execution,
      snapshot: execution.snapshot,
    });
    execution = completed;

    await input.handle?.succeed({
      cacheHit: completed.cacheHit,
      command: input.command,
      durationMs: Date.now() - startedAt,
      logs: redactPreview(completed.preview, input.sensitiveValues),
    });

    return {
      exitCode: completed.exitCode,
      logs: completed.logs,
      snapshot: completed.snapshot,
      cachePointer: completed.cachePointer,
    };
  } catch (error) {
    const safeError = sanitizeError(error, input.sensitiveValues);
    try {
      await cancelLogs(execution?.logs);
    } catch (cleanupError) {
      console.error('Failed to cancel CI log streams', { cleanupError });
    }
    try {
      await input.handle?.fail({
        cacheHit: execution?.cacheHit ?? false,
        command: input.command,
        durationMs: Date.now() - startedAt,
        logs: redactPreview(
          execution?.preview ?? { stdout: '', stderr: '' },
          input.sensitiveValues
        ),
        error: safeError.message,
      });
    } catch (notificationError) {
      console.error('Failed to report CI step failure', { notificationError });
    }
    throw safeError;
  }
}

// Redacts both log streams before they leave the engine. Presentation (framing,
// truncation, markdown) is the provider's job.
function redactPreview(
  logs: { stdout: string; stderr: string },
  sensitiveValues: string[] = []
) {
  return {
    stdout: redact(logs.stdout, sensitiveValues),
    stderr: redact(logs.stderr, sensitiveValues),
  };
}

function sanitizeError(error: unknown, sensitiveValues: string[]) {
  const message = redact(
    error instanceof Error ? error.message : String(error),
    sensitiveValues
  );
  const safe = new Error(message);
  safe.name = error instanceof Error ? error.name : 'Error';
  return safe;
}

function redact(value: string, sensitiveValues: string[]) {
  let redacted = value;
  const values = [...new Set(sensitiveValues.filter(Boolean))].sort(
    (left, right) => right.length - left.length
  );
  for (const sensitive of values) {
    redacted = redacted.split(sensitive).join('[REDACTED]');
  }
  return redacted;
}

async function cancelLogs(logs: CiRunnerLogs | undefined) {
  if (!logs) {
    return;
  }
  await Promise.all(
    [logs.stdout, logs.stderr].map((log) =>
      typeof log === 'string' ? Promise.resolve() : log.cancel()
    )
  );
}
