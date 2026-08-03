import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Bindings } from '../../env';
import type { RunStepInput } from './runner';

const mocks = vi.hoisted(() => ({ getSandbox: vi.fn() }));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: mocks.getSandbox }));

import { SandboxRunner } from './sandbox';

describe('SandboxRunner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns separate inline logs and creates a lineage backup', async () => {
    const sandbox = fakeSandbox();
    mocks.getSandbox.mockReturnValue(sandbox);

    const result = await runner().run({ ...input, cwd: 'apps/example' });

    expect(result).toEqual({
      exitCode: 0,
      logs: { stdout: 'stdout', stderr: 'stderr' },
      preview: { stdout: 'stdout tail', stderr: 'stderr tail' },
      snapshot: { id: 'backup-1', dir: '/workspace' },
    });
    expect(sandbox.startProcess).toHaveBeenCalledWith(expect.any(String), {
      cwd: '/workspace/apps/example',
      env: { CI: 'true' },
      autoCleanup: false,
    });
    expect(sandbox.createBackup).toHaveBeenCalledOnce();
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it('restores a snapshot before overlaying the current source', async () => {
    const sandbox = fakeSandbox();
    mocks.getSandbox.mockReturnValue(sandbox);
    const restore = { id: 'previous-backup', dir: '/workspace' };

    await runner().run({ ...input, restore });

    expect(sandbox.restoreBackup).toHaveBeenCalledWith(restore);
    expect(sandbox.restoreBackup.mock.invocationCallOrder[0]).toBeLessThan(
      sandbox.exec.mock.invocationCallOrder[0]!
    );
    expect(sandbox.exec).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^mkdir -p/),
      expect.objectContaining({ cwd: '/' })
    );
  });

  it('rejects a cwd outside the workspace', async () => {
    const sandbox = fakeSandbox();
    mocks.getSandbox.mockReturnValue(sandbox);

    await expect(runner().run({ ...input, cwd: '../outside' })).rejects.toThrow(
      'cwd must be inside /workspace'
    );
    expect(sandbox.startProcess).not.toHaveBeenCalled();
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it('does not create a backup for failed commands', async () => {
    const sandbox = fakeSandbox({ exitCode: 1 });
    mocks.getSandbox.mockReturnValue(sandbox);

    const result = await runner().run(input);

    expect(result).toMatchObject({
      exitCode: 1,
      logs: { stdout: 'stdout tail', stderr: 'stderr tail' },
    });
    expect(result).not.toHaveProperty('snapshot');
    expect(sandbox.createBackup).not.toHaveBeenCalled();
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it('keeps the sandbox alive until large log streams are consumed', async () => {
    const sandbox = fakeSandbox({ largeStdout: true });
    mocks.getSandbox.mockReturnValue(sandbox);

    const result = await runner().run(input);

    expect(result.logs.stdout).toBeInstanceOf(ReadableStream);
    expect(sandbox.destroy).not.toHaveBeenCalled();
    expect(
      await new Response(
        result.logs.stdout as ReadableStream<Uint8Array>
      ).text()
    ).toBe('streamed stdout');
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it('destroys the sandbox after both large streams finish', async () => {
    const sandbox = fakeSandbox({ largeStdout: true, largeStderr: true });
    mocks.getSandbox.mockReturnValue(sandbox);

    const result = await runner().run(input);
    const stdout = result.logs.stdout as ReadableStream<Uint8Array>;
    const stderr = result.logs.stderr as ReadableStream<Uint8Array>;

    await new Response(stdout).text();
    expect(sandbox.destroy).not.toHaveBeenCalled();
    await stderr.cancel();
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });
});

function runner() {
  return new SandboxRunner(fromPartial<Bindings>({ SANDBOX: {} }));
}

function fakeSandbox(options?: {
  exitCode?: number;
  largeStdout?: boolean;
  largeStderr?: boolean;
}) {
  const encoder = new TextEncoder();
  return {
    restoreBackup: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockImplementation((command: string) => {
      if (command.includes('/tmp/ci-step.out')) {
        return Promise.resolve({ stdout: 'stdout tail' });
      }
      if (command.includes('/tmp/ci-step.err')) {
        return Promise.resolve({ stdout: 'stderr tail' });
      }
      return Promise.resolve({ stdout: '', exitCode: 0 });
    }),
    startProcess: vi.fn().mockResolvedValue({
      waitForExit: vi
        .fn()
        .mockResolvedValue({ exitCode: options?.exitCode ?? 0 }),
    }),
    createBackup: vi
      .fn()
      .mockResolvedValue({ id: 'backup-1', dir: '/workspace' }),
    listFiles: vi.fn().mockResolvedValue({
      files: [
        {
          absolutePath: '/tmp/ci-step.out',
          size: options?.largeStdout ? 500_000 : 6,
        },
        {
          absolutePath: '/tmp/ci-step.err',
          size: options?.largeStderr ? 500_000 : 6,
        },
      ],
    }),
    readFile: vi.fn().mockImplementation((path: string) =>
      Promise.resolve({
        content: path.endsWith('.out') ? 'stdout' : 'stderr',
      })
    ),
    readFileStream: vi.fn().mockImplementation(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('streamed stdout'));
            controller.close();
          },
        })
    ),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

const input = {
  label: 'test',
  command: 'pnpm test',
  source: { kind: 'archive', url: 'https://example.com/source.tar.gz' },
} satisfies RunStepInput;
