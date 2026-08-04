import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSandbox: vi.fn() }));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: mocks.getSandbox }));

import {
  checkpointHealingSandbox,
  openHealingSandbox,
  openPushSandbox,
  seedHealingSandbox,
} from './sandbox';

const source = {
  kind: 'git' as const,
  remote: 'https://account.artifacts.cloudflare.net/git/default/repo.git',
  token: 'secret-token',
  sha: 'abc123',
};

beforeEach(() => vi.clearAllMocks());

describe('openHealingSandbox', () => {
  it('opens a distinct persistent sandbox and seeds it', async () => {
    const sandbox = fakeSandbox();
    mocks.getSandbox.mockReturnValue(sandbox);

    const result = await openHealingSandbox(
      { SANDBOX: {} as never },
      { id: 'ci-run-123', source }
    );

    expect(result).toBe(sandbox);
    expect(mocks.getSandbox).toHaveBeenCalledWith(
      {},
      expect.stringMatching(/^heal-ci-run-123-/),
      {
        transport: 'http',
        enableDefaultSession: false,
        containerTimeouts: { portReadyTimeoutMS: 60_000 },
      }
    );
    expect(sandbox.destroy).not.toHaveBeenCalled();
  });

  it('destroys a sandbox that fails to seed', async () => {
    const sandbox = fakeSandbox({ exitCode: 128 });
    mocks.getSandbox.mockReturnValue(sandbox);

    await expect(
      openHealingSandbox({ SANDBOX: {} as never }, { id: 'ci-run-123', source })
    ).rejects.toThrow('Failed to seed healing sandbox');
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it('keeps generated IDs within the Sandbox limit', async () => {
    mocks.getSandbox.mockReturnValue(fakeSandbox());

    await openHealingSandbox(
      { SANDBOX: {} as never },
      { id: 'a'.repeat(100), source }
    );

    const id = mocks.getSandbox.mock.calls[0]![1] as string;
    expect(id).toMatch(/^heal-/);
    expect(id.length).toBeLessThanOrEqual(63);
  });
});

describe('seedHealingSandbox', () => {
  it('restores the snapshot before overlaying a shallow git checkout', async () => {
    const restoreBackup = vi.fn().mockResolvedValue(undefined);
    const exec = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const snapshot = { id: 'backup-id', dir: '/workspace' };

    await seedHealingSandbox({ restoreBackup, exec }, { source, snapshot });

    expect(restoreBackup).toHaveBeenCalledWith(snapshot);
    expect(restoreBackup.mock.invocationCallOrder[0]).toBeLessThan(
      exec.mock.invocationCallOrder[0]!
    );
    const [script, options] = exec.mock.calls[0]!;
    expect(script).toContain('fetch --depth=1 origin');
    expect(script).toContain("'abc123'");
    expect(script).toContain("tar -C '/tmp/ci-healing-source' -cf - .");
    expect(script).toContain("git -C '/workspace' clean -fd");
    expect(script.indexOf("git -C '/workspace' clean -fd")).toBeLessThan(
      script.indexOf("tar -C '/tmp/ci-healing-source' -cf - .")
    );
    expect(script).not.toContain(source.token);
    expect(options).toEqual({
      cwd: '/',
      timeout: 300_000,
      env: { SOURCE_CONTROL_TOKEN: source.token },
    });
  });

  it('starts from an empty workspace without a snapshot', async () => {
    const restoreBackup = vi.fn();
    const exec = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await seedHealingSandbox({ restoreBackup, exec }, { source });

    expect(restoreBackup).not.toHaveBeenCalled();
    expect(exec.mock.calls[0]![0]).toContain(
      "rm -rf '/workspace' && mkdir -p '/workspace'"
    );
  });

  it('rejects archive sources', async () => {
    const sandbox = {
      restoreBackup: vi.fn(),
      exec: vi.fn(),
    };

    await expect(
      seedHealingSandbox(sandbox, {
        source: { kind: 'archive', url: 'https://ci.test/source' },
      })
    ).rejects.toThrow('Healing requires a git source checkout');
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it('reports checkout failures', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'bad revision' });

    await expect(
      seedHealingSandbox({ restoreBackup: vi.fn(), exec }, { source })
    ).rejects.toThrow(
      'Failed to seed healing sandbox (exit 128)\nbad revision'
    );
  });
});

describe('push sandbox', () => {
  it('checkpoints only the verified workspace for one hour', async () => {
    const createBackup = vi.fn().mockResolvedValue({
      id: 'verified-backup',
      dir: '/workspace',
    });

    await expect(checkpointHealingSandbox({ createBackup })).resolves.toEqual({
      id: 'verified-backup',
      dir: '/workspace',
    });
    expect(createBackup).toHaveBeenCalledWith({
      dir: '/workspace',
      name: 'verified-heal',
      multipart: true,
      ttl: 3600,
    });
  });

  it('replaces agent-controlled git metadata in a fresh sandbox', async () => {
    const sandbox = fakeSandbox();
    mocks.getSandbox.mockReturnValue(sandbox);
    const snapshot = { id: 'verified-backup', dir: '/workspace' };

    await expect(
      openPushSandbox(
        { SANDBOX: {} as never },
        { id: 'run-1', source, snapshot }
      )
    ).resolves.toBe(sandbox);

    expect(sandbox.restoreBackup).toHaveBeenCalledWith(snapshot);
    const [script, options] = sandbox.exec.mock.calls[0]!;
    expect(script).toContain("rm -rf '/workspace/.git'");
    expect(script).toContain("fetch --depth=1 origin 'abc123'");
    expect(script).toContain(
      "cp -a '/tmp/ci-healing-source/.git' '/workspace/.git'"
    );
    expect(script).not.toContain(source.token);
    expect(options).toEqual({
      cwd: '/',
      timeout: 300_000,
      env: { SOURCE_CONTROL_TOKEN: source.token },
    });
  });

  it('keeps generated push IDs within the Sandbox limit', async () => {
    mocks.getSandbox.mockReturnValue(fakeSandbox());

    await openPushSandbox(
      { SANDBOX: {} as never },
      {
        id: 'a'.repeat(100),
        source,
        snapshot: { id: 'verified-backup', dir: '/workspace' },
      }
    );

    const id = mocks.getSandbox.mock.calls[0]![1] as string;
    expect(id).toMatch(/^push-/);
    expect(id.length).toBeLessThanOrEqual(63);
  });
});

function fakeSandbox({ exitCode = 0 }: { exitCode?: number } = {}) {
  return {
    restoreBackup: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({
      exitCode,
      stdout: '',
      stderr: exitCode === 0 ? '' : 'checkout failed',
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}
