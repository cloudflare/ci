import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import type { CloudflareArtifacts } from '@cloudflare/ci';
import type { SourceControlAdapter } from '@cloudflare/ci/worker/source-control';
import type { Bindings } from '../../env';

const mocks = vi.hoisted(() => ({
  saveMessages: vi.fn(),
  checkpointHealingSandbox: vi.fn(),
  openHealingSandbox: vi.fn(),
  openPushSandbox: vi.fn(),
  inspectHealingChanges: vi.fn(),
  pushFixBranch: vi.fn(),
}));

vi.mock('@cloudflare/think', () => ({
  Think: class {
    readonly env: unknown;

    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }

    saveMessages(messages: unknown) {
      return mocks.saveMessages(messages);
    }
  },
}));
vi.mock('./sandbox', () => ({
  checkpointHealingSandbox: mocks.checkpointHealingSandbox,
  openHealingSandbox: mocks.openHealingSandbox,
  openPushSandbox: mocks.openPushSandbox,
}));
vi.mock('./push', () => ({
  inspectHealingChanges: mocks.inspectHealingChanges,
  pushFixBranch: mocks.pushFixBranch,
}));

import { HealingAgent } from './healer';
import type { HealFailure } from './types';

const failure: HealFailure = {
  runId: 'run-1',
  source: {
    owner: 'owner',
    repo: 'repo',
    sha: 'abc123',
    providerData: { namespace: 'owner' },
  },
  baseBranch: 'main',
  failures: [
    {
      runner: { name: 'test', command: 'bun test' },
      output: 'assertion failed',
    },
    {
      runner: { name: 'lint', command: 'bun lint', cwd: 'apps/example' },
      output: 'lint failed',
    },
  ],
  snapshot: { id: 'snapshot-1', dir: '/workspace' },
  verificationCommands: [
    { command: 'bun test' },
    { command: 'bun lint', cwd: 'apps/example' },
  ],
};

describe('HealingAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveMessages.mockResolvedValue({ status: 'completed' });
    mocks.inspectHealingChanges.mockResolvedValue({
      paths: ['src/value.ts'],
      protectedPaths: [],
    });
  });

  it('runs a Think turn, verifies the pipeline, and pushes a Fix Branch', async () => {
    const healingExec = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
    const healingSandbox = {
      exec: healingExec,
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const pushSandbox = { destroy: vi.fn().mockResolvedValue(undefined) };
    mocks.openHealingSandbox.mockResolvedValue(healingSandbox);
    mocks.checkpointHealingSandbox.mockResolvedValue({
      id: 'verified-backup',
      dir: '/workspace',
    });
    mocks.openPushSandbox.mockResolvedValue(pushSandbox);
    mocks.pushFixBranch.mockResolvedValue({
      status: 'pushed',
      branch: 'ci-autofix/run-1',
      commit: 'def456',
    });
    const createPullRequest = vi.fn().mockResolvedValue({ status: 'skipped' });
    const getSourceCheckout = vi.fn().mockResolvedValue({
      kind: 'git',
      remote: 'https://example.com/owner/repo.git',
      token: 'read-token',
      sha: 'abc123',
    });
    const provider = adapter({ getSourceCheckout, createPullRequest });
    class Healer extends HealingAgent {
      protected override getProvider() {
        return provider;
      }
    }
    const healer = new Healer(
      fromPartial<DurableObjectState>({}),
      fromPartial<Bindings>({})
    );
    mocks.saveMessages.mockImplementationOnce(async () => {
      const execute = healer.getTools().exec?.execute;
      if (!execute) {
        throw new Error('exec tool unavailable');
      }
      const toolResult = await (
        execute as (input: {
          command: string;
          timeoutMs: number;
        }) => Promise<unknown>
      )({ command: 'touch src/value.ts', timeoutMs: 1_000 });
      expect(toolResult).toMatchObject({
        allPassed: true,
        verification: [
          { command: 'bun test', exitCode: 0 },
          {
            command: 'bun lint',
            cwd: 'apps/example',
            exitCode: 0,
          },
        ],
      });
      return { status: 'completed' };
    });

    const result = await healer.heal({
      failure,
      prompt: 'Fix the root cause.',
    });

    expect(result).toEqual({
      branch: 'ci-autofix/run-1',
      commit: 'def456',
      steps: 0,
      pullRequest: { status: 'skipped' },
    });
    expect(mocks.saveMessages).toHaveBeenCalledWith([
      expect.objectContaining({
        role: 'user',
        parts: [
          expect.objectContaining({
            text: expect.stringContaining('assertion failed'),
          }),
        ],
      }),
    ]);
    expect(mocks.saveMessages).toHaveBeenCalledWith([
      expect.objectContaining({
        parts: [
          expect.objectContaining({
            text: expect.stringContaining('lint failed'),
          }),
        ],
      }),
    ]);
    expect(healingExec).toHaveBeenNthCalledWith(1, 'touch src/value.ts', {
      cwd: '/workspace',
      timeout: 1_000,
    });
    expect(healingExec).toHaveBeenNthCalledWith(2, 'bun test', {
      cwd: '/workspace',
      timeout: 600_000,
    });
    expect(healingExec).toHaveBeenNthCalledWith(3, 'bun lint', {
      cwd: '/workspace/apps/example',
      timeout: 600_000,
    });
    expect(mocks.openPushSandbox).toHaveBeenCalledWith(expect.anything(), {
      id: 'run-1',
      source: expect.objectContaining({ token: 'read-token' }),
      snapshot: { id: 'verified-backup', dir: '/workspace' },
    });
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        headBranch: 'ci-autofix/run-1',
        headCommit: 'def456',
      })
    );
  });

  it('does not mint push credentials when final verification fails', async () => {
    const getPushCredentials = vi.fn();
    mocks.openHealingSandbox.mockResolvedValue({
      exec: vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'still failing',
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    });
    const provider = adapter({ getPushCredentials });
    class Healer extends HealingAgent {
      protected override getProvider() {
        return provider;
      }
    }
    const healer = new Healer(
      fromPartial<DurableObjectState>({}),
      fromPartial<Bindings>({})
    );

    await expect(healer.heal({ failure })).rejects.toThrow(
      'Heal Attempt failed pipeline verification bun test\nstill failing'
    );
    expect(getPushCredentials).not.toHaveBeenCalled();
    expect(mocks.openPushSandbox).not.toHaveBeenCalled();
  });
});

function adapter(provider: {
  getSourceCheckout?: ReturnType<typeof vi.fn>;
  getPushCredentials?: ReturnType<typeof vi.fn>;
  createPullRequest?: ReturnType<typeof vi.fn>;
}) {
  return fromPartial<SourceControlAdapter<CloudflareArtifacts>>({
    create: vi.fn().mockReturnValue({
      getSourceCheckout:
        provider.getSourceCheckout ??
        vi.fn().mockResolvedValue({
          kind: 'git',
          remote: 'https://example.com/owner/repo.git',
          token: 'read-token',
          sha: 'abc123',
        }),
      getPushCredentials:
        provider.getPushCredentials ??
        vi.fn().mockResolvedValue({
          remote: 'https://example.com/owner/repo.git',
          token: 'write-token',
        }),
      createPullRequest:
        provider.createPullRequest ??
        vi.fn().mockResolvedValue({ status: 'skipped' }),
    }),
  });
}
