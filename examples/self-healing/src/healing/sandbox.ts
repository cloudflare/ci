import type { DirectoryBackup } from '@cloudflare/sandbox';
import type { CiBindings, SourceControlCheckout } from '@cloudflare/ci/worker';
import { shellQuote, slugify } from './utils';

const WORKSPACE_DIR = '/workspace';
const CLONE_DIR = '/tmp/ci-healing-source';
const SOURCE_TIMEOUT_MS = 5 * 60 * 1000;
const PORT_READY_TIMEOUT_MS = 60_000;
const HEALED_BACKUP_TTL_SECONDS = 60 * 60;
const MAX_SANDBOX_ID_LENGTH = 63;

type SeedableSandbox = {
  restoreBackup(backup: DirectoryBackup): Promise<unknown>;
  exec(
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
    }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

export type HealingSandboxOptions = {
  id: string;
  source: SourceControlCheckout;
  snapshot?: DirectoryBackup;
};

export type PushSandboxOptions = {
  id: string;
  source: SourceControlCheckout;
  snapshot: DirectoryBackup;
};

export async function openHealingSandbox(
  env: Pick<CiBindings, 'SANDBOX'>,
  options: HealingSandboxOptions
) {
  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandbox = getSandbox(
    env.SANDBOX,
    healingSandboxId('heal', options.id),
    {
      transport: 'http',
      enableDefaultSession: false,
      containerTimeouts: { portReadyTimeoutMS: PORT_READY_TIMEOUT_MS },
    }
  );

  try {
    await seedHealingSandbox(sandbox, options);
    return sandbox;
  } catch (error) {
    await sandbox.destroy().catch((cleanupError) => {
      console.error('Failed to destroy unseeded healing sandbox', {
        cleanupError,
      });
    });
    throw error;
  }
}

export async function checkpointHealingSandbox(sandbox: {
  createBackup(options: {
    dir: string;
    name: string;
    multipart: boolean;
    ttl: number;
  }): Promise<DirectoryBackup>;
}) {
  return sandbox.createBackup({
    dir: WORKSPACE_DIR,
    name: 'verified-heal',
    multipart: true,
    ttl: HEALED_BACKUP_TTL_SECONDS,
  });
}

export async function openPushSandbox(
  env: Pick<CiBindings, 'SANDBOX'>,
  options: PushSandboxOptions
) {
  if (options.source.kind !== 'git') {
    throw new Error('Fix Branch push requires a git source checkout');
  }
  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandbox = getSandbox(
    env.SANDBOX,
    healingSandboxId('push', options.id),
    {
      transport: 'http',
      enableDefaultSession: false,
      containerTimeouts: { portReadyTimeoutMS: PORT_READY_TIMEOUT_MS },
    }
  );

  try {
    await sandbox.restoreBackup(options.snapshot);
    const result = await sandbox.exec(
      preparePushScript(options.source.remote, options.source.sha),
      {
        cwd: '/',
        timeout: SOURCE_TIMEOUT_MS,
        env: { SOURCE_CONTROL_TOKEN: options.source.token },
      }
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to prepare push sandbox (exit ${result.exitCode})\n${result.stderr || result.stdout}`
      );
    }
    return sandbox;
  } catch (error) {
    await sandbox.destroy().catch((cleanupError) => {
      console.error('Failed to destroy unprepared push sandbox', {
        cleanupError,
      });
    });
    throw error;
  }
}

function healingSandboxId(prefix: 'heal' | 'push', runId: string) {
  const suffix = crypto.randomUUID();
  const maxNameLength =
    MAX_SANDBOX_ID_LENGTH - prefix.length - suffix.length - 2;
  const name = (slugify(runId) || 'attempt').slice(0, maxNameLength);
  return `${prefix}-${name}-${suffix}`;
}

export async function seedHealingSandbox(
  sandbox: SeedableSandbox,
  { source, snapshot }: Omit<HealingSandboxOptions, 'id'>
) {
  if (source.kind !== 'git') {
    throw new Error('Healing requires a git source checkout');
  }

  if (snapshot) {
    await sandbox.restoreBackup(snapshot);
  }

  const result = await sandbox.exec(
    seedScript(source.remote, source.sha, snapshot !== undefined),
    {
      cwd: '/',
      timeout: SOURCE_TIMEOUT_MS,
      env: { SOURCE_CONTROL_TOKEN: source.token },
    }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to seed healing sandbox (exit ${result.exitCode})\n${result.stderr || result.stdout}`
    );
  }
}

function seedScript(remote: string, sha: string, preserveWorkspace: boolean) {
  const prepareWorkspace = preserveWorkspace
    ? `mkdir -p ${shellQuote(WORKSPACE_DIR)}`
    : `rm -rf ${shellQuote(WORKSPACE_DIR)} && mkdir -p ${shellQuote(WORKSPACE_DIR)}`;
  const cleanStaleSource = preserveWorkspace
    ? [
        `rm -rf ${shellQuote(`${WORKSPACE_DIR}/.git`)}`,
        `cp -a ${shellQuote(`${CLONE_DIR}/.git`)} ${shellQuote(`${WORKSPACE_DIR}/.git`)}`,
        `git -C ${shellQuote(WORKSPACE_DIR)} clean -fd`,
        `rm -rf ${shellQuote(`${WORKSPACE_DIR}/.git`)}`,
      ].join(' && ')
    : undefined;
  return [
    prepareWorkspace,
    `rm -rf ${shellQuote(CLONE_DIR)}`,
    `git init -q ${shellQuote(CLONE_DIR)}`,
    `git -C ${shellQuote(CLONE_DIR)} remote add origin ${shellQuote(remote)}`,
    `git -c http.extraHeader="Authorization: Bearer $SOURCE_CONTROL_TOKEN" -C ${shellQuote(CLONE_DIR)} fetch --depth=1 origin ${shellQuote(sha)}`,
    `git -C ${shellQuote(CLONE_DIR)} checkout --detach FETCH_HEAD`,
    cleanStaleSource,
    `tar -C ${shellQuote(CLONE_DIR)} -cf - . | tar -C ${shellQuote(WORKSPACE_DIR)} -xf -`,
  ]
    .filter(Boolean)
    .join(' && ');
}

function preparePushScript(remote: string, sha: string) {
  return [
    `rm -rf ${shellQuote(`${WORKSPACE_DIR}/.git`)} ${shellQuote(CLONE_DIR)}`,
    `git init -q ${shellQuote(CLONE_DIR)}`,
    `git -C ${shellQuote(CLONE_DIR)} remote add origin ${shellQuote(remote)}`,
    `git -c http.extraHeader="Authorization: Bearer $SOURCE_CONTROL_TOKEN" -C ${shellQuote(CLONE_DIR)} fetch --depth=1 origin ${shellQuote(sha)}`,
    `git -C ${shellQuote(CLONE_DIR)} checkout --detach FETCH_HEAD`,
    `cp -a ${shellQuote(`${CLONE_DIR}/.git`)} ${shellQuote(`${WORKSPACE_DIR}/.git`)}`,
  ].join(' && ');
}
