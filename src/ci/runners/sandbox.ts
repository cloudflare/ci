// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getSandbox, type DirectoryBackup } from '@cloudflare/sandbox';
import { posix } from 'node:path';
import type { Bindings } from '../../env';
import {
  checkoutSourceEnv,
  checkoutSourceScript,
} from '../../shared/source-checkout';
import { slugify } from '../../shared/slugify';
import type { RunStepInput, RunStepResult, Runner } from './runner';

// Sandbox implementation limits. Pipeline-facing command and Snapshot
// retention settings are supplied through RunnerConfig.
const WORKSPACE_DIR = '/workspace';
const STDOUT_FILE = '/tmp/ci-step.out';
const STDERR_FILE = '/tmp/ci-step.err';
const COMMAND_TIMEOUT_MS = 11 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 5 * 60 * 1000;
const PORT_READY_TIMEOUT_MS = 60_000;
// Keep notification and failure previews bounded by slicing each stream to its
// tail in the sandbox, where command failures usually surface.
const TAIL_BYTES = 28_000;
// Two inline logs plus result metadata must remain below Workflows' 1 MiB limit.
const INLINE_LOG_BYTES = 300_000;

export class SandboxRunner implements Runner<DirectoryBackup> {
  readonly name = 'sandbox';

  constructor(private readonly env: Bindings) {}

  /**
   * Copies source, runs the command, and snapshots `/workspace` after a
   * successful exit. A restored Snapshot is overlaid with the current source.
   * Large log streams keep the Sandbox alive until they are read or cancelled.
   */
  async run(
    input: RunStepInput & { restore?: DirectoryBackup }
  ): Promise<RunStepResult<DirectoryBackup>> {
    // create the sandbox handle
    const sandbox = getSandbox(this.env.SANDBOX, createRunnerId(input.label), {
      transport: 'http',
      enableDefaultSession: false,
      containerTimeouts: { portReadyTimeoutMS: PORT_READY_TIMEOUT_MS },
    });

    let cleanupTransferredToStreams = false;
    try {
      if (input.restore) {
        await sandbox.restoreBackup(input.restore);
        // Overlay (no rm) so cached node_modules survive while tracked source
        // files are refreshed to this commit. The restored archive may carry a
        // different commit's source (e.g. a reused install cache), so this is
        // what keeps it correct. Files deleted since then linger; the next
        // install/build regenerates derived output.
        await sandbox.exec(
          checkoutSourceScript(input.source, WORKSPACE_DIR, true),
          {
            cwd: '/',
            timeout: SOURCE_TIMEOUT_MS,
            env: checkoutSourceEnv(input.source),
          }
        );
      } else {
        await sandbox.exec(checkoutSourceScript(input.source, WORKSPACE_DIR), {
          cwd: '/',
          timeout: SOURCE_TIMEOUT_MS,
          env: checkoutSourceEnv(input.source),
        });
      }

      const proc = await sandbox.startProcess(
        `(${input.command}) > ${STDOUT_FILE} 2> ${STDERR_FILE}`,
        {
          cwd: resolveCwd(input.cwd),
          env: {
            CI: 'true',
            ...input.extraEnv,
          },
          autoCleanup: false,
        }
      );
      const { exitCode } = await proc.waitForExit(
        input.timeoutMs ?? COMMAND_TIMEOUT_MS
      );
      const preview = await readPreviews(sandbox);

      if (exitCode !== 0) {
        return { exitCode, logs: preview, preview };
      }

      const snapshot = await sandbox.createBackup({
        dir: WORKSPACE_DIR,
        name: input.label,
        multipart: true,
        ttl: input.ttlSeconds,
      });
      const rawLogs = await readLogs(sandbox);
      const streams = [rawLogs.stdout, rawLogs.stderr].filter(
        (value): value is ReadableStream<Uint8Array> =>
          typeof value !== 'string'
      );
      if (streams.length === 0) {
        return { exitCode, logs: rawLogs, preview, snapshot };
      }

      let remainingStreams = streams.length;
      const releaseStream = async () => {
        remainingStreams -= 1;
        if (remainingStreams === 0) {
          await destroySandbox(sandbox);
        }
      };
      cleanupTransferredToStreams = true;
      return {
        exitCode,
        logs: {
          stdout:
            typeof rawLogs.stdout === 'string'
              ? rawLogs.stdout
              : withCleanup(rawLogs.stdout, releaseStream),
          stderr:
            typeof rawLogs.stderr === 'string'
              ? rawLogs.stderr
              : withCleanup(rawLogs.stderr, releaseStream),
        },
        preview,
        snapshot,
      };
    } finally {
      if (!cleanupTransferredToStreams) {
        await destroySandbox(sandbox);
      }
    }
  }
}

async function readLogs(sandbox: ReturnType<typeof getSandbox>) {
  const listing = await sandbox.listFiles('/tmp');
  const sizes = new Map(
    listing.files.map((file) => [file.absolutePath, file.size])
  );
  return {
    stdout: await readLog(sandbox, STDOUT_FILE, sizes.get(STDOUT_FILE) ?? 0),
    stderr: await readLog(sandbox, STDERR_FILE, sizes.get(STDERR_FILE) ?? 0),
  };
}

async function readLog(
  sandbox: ReturnType<typeof getSandbox>,
  file: string,
  size: number
): Promise<string | ReadableStream<Uint8Array>> {
  if (size > INLINE_LOG_BYTES) {
    return sandbox.readFileStream(file);
  }
  return (await sandbox.readFile(file, { encoding: 'utf-8' })).content;
}

async function readPreviews(sandbox: ReturnType<typeof getSandbox>) {
  const [stdout, stderr] = await Promise.all([
    readTail(sandbox, STDOUT_FILE),
    readTail(sandbox, STDERR_FILE),
  ]);
  return { stdout, stderr };
}

async function readTail(sandbox: ReturnType<typeof getSandbox>, file: string) {
  return (
    await sandbox.exec(`tail -c ${TAIL_BYTES} ${file} 2>/dev/null`, {
      cwd: '/',
      timeout: 30_000,
    })
  ).stdout;
}

function resolveCwd(cwd: string | undefined) {
  if (!cwd || cwd === '.' || cwd === './') {
    return WORKSPACE_DIR;
  }
  const normalized = posix.normalize(cwd);
  // Commands stay inside the snapshotted workspace so chained runners cannot
  // depend on filesystem state that lineage backups do not preserve.
  if (
    posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`cwd must be inside ${WORKSPACE_DIR}: ${cwd}`);
  }
  return posix.join(WORKSPACE_DIR, normalized);
}

function withCleanup(
  stream: ReadableStream<Uint8Array>,
  release: () => Promise<void>
) {
  const reader = stream.getReader();
  let released = false;
  const releaseOnce = async () => {
    if (!released) {
      released = true;
      await release();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await releaseOnce();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        await releaseOnce();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await releaseOnce();
      }
    },
  });
}

function createRunnerId(label: string) {
  return `${slugify(label).slice(0, 16)}-${crypto.randomUUID()}`;
}

async function destroySandbox(sandbox: ReturnType<typeof getSandbox>) {
  try {
    await sandbox.destroy();
  } catch (error) {
    console.error('Failed to destroy CI sandbox', { error });
  }
}
