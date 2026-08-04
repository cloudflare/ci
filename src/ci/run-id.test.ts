import { describe, expect, it } from 'vitest';
import { runId } from './run-id';

describe('runId', () => {
  it('creates a valid, bounded workflow ID', async () => {
    const source = {
      provider: 'cloudflare-artifacts',
      owner: 'owner',
      repo: 'repo',
      sha: 'abc123',
    };

    const id = await runId(source);
    expect(id).toMatch(/^ci-cloudflare-a-repo-[a-f0-9]{64}$/);
    expect(id.length).toBeLessThanOrEqual(100);
  });

  it('scopes IDs by provider, owner, and repository', async () => {
    const source = {
      provider: 'cloudflare-artifacts',
      owner: 'owner',
      repo: 'example',
      sha: 'abc123',
    };

    const ids = await Promise.all([
      runId(source),
      runId({ ...source, provider: 'other-provider' }),
      runId({ ...source, owner: 'other' }),
      runId({ ...source, repo: 'other' }),
    ]);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('bounds IDs for long source names', async () => {
    const id = await runId({
      provider: 'cloudflare-artifacts',
      owner: 'owner'.repeat(20),
      repo: 'repository'.repeat(20),
      sha: 'a'.repeat(200),
    });

    expect(id).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/);
    expect(id.length).toBeLessThanOrEqual(100);
  });

  it('keeps Artifacts repository identity case-sensitive', async () => {
    const source = {
      provider: 'cloudflare-artifacts',
      owner: 'Namespace',
      repo: 'Repo',
      sha: 'abc123',
    };

    await expect(runId({ ...source, repo: 'repo' })).resolves.not.toBe(
      await runId(source)
    );
  });
});
