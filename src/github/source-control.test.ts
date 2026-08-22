import { describe, expect, it } from 'vitest';
import { GitHubSourceControlProvider } from './source-control';

const source = {
  owner: 'cloudflare',
  repo: 'workers-sdk',
  sha: 'abc123',
  providerData: {},
};

describe('GitHubSourceControlProvider', () => {
  it('creates an immutable public archive checkout', async () => {
    const provider = createProvider({
      owner: 'Cloudflare',
      repo: 'Workers-SDK',
    });

    await expect(provider.getSourceCheckout(source)).resolves.toEqual({
      kind: 'archive',
      url: 'https://codeload.github.com/cloudflare/workers-sdk/tar.gz/abc123',
    });
  });

  it('rejects a source outside its configured repository', async () => {
    const provider = createProvider({
      owner: 'cloudflare',
      repo: 'workers-sdk',
    });

    await expect(
      provider.getSourceCheckout({ ...source, repo: 'other' })
    ).rejects.toThrow('Unsupported GitHub repository: cloudflare/other');
  });

  it('safely bypasses caching until source fingerprinting is available', async () => {
    const provider = createProvider();

    await expect(
      provider.listTreeBlobs(source, ['package.json'])
    ).resolves.toBeNull();
  });

  it('does not expose source-control credentials', async () => {
    const provider = createProvider();

    await expect(provider.getStepCredentialEnv(source)).resolves.toEqual({});
  });
});

function createProvider(repository: { owner?: string; repo?: string } = {}) {
  return new GitHubSourceControlProvider(repository);
}
