import { describe, expect, it } from 'vitest';
import { GitHubSourceControlProvider } from './source-control';

const source = {
  owner: 'cloudflare',
  repo: 'workers-sdk',
  sha: 'abc123',
  providerData: {},
};

const pushEvent = {
  ref: 'refs/heads/main',
  before: 'before123',
  after: 'after456',
  repository: {
    name: 'Workers-SDK',
    owner: { login: 'Cloudflare' },
  },
  head_commit: { message: 'ship it' },
  sender: { login: 'octocat' },
};

describe('GitHubSourceControlProvider', () => {
  it('maps a signed push for its configured repository to a CI run', async () => {
    const provider = createProvider({
      owner: 'cloudflare',
      repo: 'workers-sdk',
    });
    const event = await webhookEvent(pushEvent);

    await expect(provider.receiveEvent(event)).resolves.toMatchObject({
      type: 'run',
      params: {
        provider: 'github',
        owner: 'Cloudflare',
        repo: 'Workers-SDK',
        sha: 'after456',
        ref: 'refs/heads/main',
      },
    });
  });

  it('ignores a signed push for another repository', async () => {
    const provider = createProvider({
      owner: 'cloudflare',
      repo: 'workers-sdk',
    });
    const event = await webhookEvent({
      ...pushEvent,
      repository: { ...pushEvent.repository, name: 'other' },
    });

    await expect(provider.receiveEvent(event)).resolves.toBeNull();
  });

  it('ignores a signed unsupported GitHub event', async () => {
    const provider = createProvider();
    const event = await webhookEvent(
      { zen: 'Keep it logically awesome.' },
      'ping'
    );

    await expect(provider.receiveEvent(event)).resolves.toBeNull();
  });

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
  return new GitHubSourceControlProvider('webhook-secret', repository);
}

async function webhookEvent(payload: unknown, event = 'push') {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('webhook-secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body)
  );
  const signature = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return {
    body,
    headers: new Headers({
      'x-github-event': event,
      'x-hub-signature-256': `sha256=${signature}`,
    }),
  };
}
