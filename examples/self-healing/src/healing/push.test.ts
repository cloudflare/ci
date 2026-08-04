import { describe, expect, it, vi } from 'vitest';
import { inspectHealingChanges, pushFixBranch } from './push';
import type { HealingSandbox } from './tools';

const credentials = {
  remote: 'https://account.artifacts.cloudflare.net/git/default/repo.git',
  token: 'write-token',
};

describe('pushFixBranch', () => {
  it('commits and pushes a deterministic Fix Branch', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: ' M src/value.ts\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'base123\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'abc123\nbase123\n',
        stderr: '',
      });

    await expect(
      pushFixBranch(createSandbox(exec), {
        runId: 'ci-cloudflare-artifacts-demo-123',
        baseSha: 'base123',
        credentials,
      })
    ).resolves.toEqual({
      status: 'pushed',
      branch: 'ci-autofix/ci-cloudflare-artifacts-demo-123',
      commit: 'abc123',
    });

    const [command, options] = exec.mock.calls[2]!;
    expect(command).toContain(
      "git checkout -B 'ci-autofix/ci-cloudflare-artifacts-demo-123'"
    );
    expect(command).toContain('[skip ci]');
    expect(command).toContain('core.hooksPath=/dev/null');
    expect(command).toContain('ls-remote --heads');
    expect(command).toContain('test "$(git rev-parse FETCH_HEAD^)"');
    expect(command).toContain('test "$(git show -s --format=%ae FETCH_HEAD)"');
    expect(command).toContain(
      `push --force-with-lease='refs/heads/ci-autofix/ci-cloudflare-artifacts-demo-123:'$REMOTE_COMMIT '${credentials.remote}' HEAD:`
    );
    expect(command).not.toContain('push origin');
    expect(command).toContain('$SOURCE_CONTROL_TOKEN');
    expect(command).not.toContain(credentials.token);
    expect(options).toEqual({
      cwd: '/workspace',
      timeout: 120_000,
      env: { SOURCE_CONTROL_TOKEN: credentials.token },
    });
  });

  it('does not create a branch when the agent made no changes', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await expect(
      pushFixBranch(createSandbox(exec), {
        runId: 'run-1',
        baseSha: 'base123',
        credentials,
      })
    ).resolves.toEqual({ status: 'no_changes' });
    expect(exec).toHaveBeenCalledOnce();
  });

  it('reports push failures', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: ' M src/value.ts\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'base123\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 128,
        stdout: '',
        stderr: 'permission denied',
      });

    await expect(
      pushFixBranch(createSandbox(exec), {
        runId: 'run-1',
        baseSha: 'base123',
        credentials,
      })
    ).rejects.toThrow(
      'Failed to push Fix Branch ci-autofix/run-1 (exit 128)\npermission denied'
    );
  });

  it('rejects an unexpected base before exposing push credentials', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: ' M src/value.ts\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'attacker-commit\n',
        stderr: '',
      });

    await expect(
      pushFixBranch(createSandbox(exec), {
        runId: 'run-1',
        baseSha: 'base123',
        credentials,
      })
    ).rejects.toThrow(
      'Refusing to push Fix Branch from unexpected base attacker-commit'
    );
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.flat().join(' ')).not.toContain(credentials.token);
  });
});

describe('inspectHealingChanges', () => {
  it('flags tests, CI configuration, lockfiles, and package scripts', async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: [
        'src/value.ts',
        'src/value.test.ts',
        '.github/workflows/ci.yml',
        'packages/app/package.json',
        'bun.lock',
        '.oxlintrc.json',
        'tsconfig.json',
        'wrangler.jsonc',
        'Dockerfile',
        '',
      ].join('\0'),
      stderr: '',
    });

    await expect(inspectHealingChanges(createSandbox(exec))).resolves.toEqual({
      paths: [
        '.github/workflows/ci.yml',
        '.oxlintrc.json',
        'Dockerfile',
        'bun.lock',
        'packages/app/package.json',
        'src/value.test.ts',
        'src/value.ts',
        'tsconfig.json',
        'wrangler.jsonc',
      ],
      protectedPaths: [
        '.github/workflows/ci.yml',
        '.oxlintrc.json',
        'Dockerfile',
        'bun.lock',
        'packages/app/package.json',
        'src/value.test.ts',
        'tsconfig.json',
        'wrangler.jsonc',
      ],
    });
  });
});

function createSandbox(exec: HealingSandbox['exec']): HealingSandbox {
  return {
    exec,
    readFile: vi.fn(),
    writeFile: vi.fn(),
  };
}
