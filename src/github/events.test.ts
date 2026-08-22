import { describe, expect, it } from 'vitest';
import {
  GitHubWebhookSignatureError,
  mapGitHubPushEventToCiParams,
  parseGitHubPushEvent,
  verifyGitHubWebhookSignature,
  type GitHubPushEvent,
} from './events';

const pushEvent = {
  ref: 'refs/heads/main',
  before: 'before123',
  after: 'after456',
  repository: {
    name: 'workers-sdk',
    owner: { login: 'cloudflare' },
  },
  head_commit: { message: 'ship it' },
  sender: { login: 'octocat' },
  installation: { id: 12345 },
} satisfies GitHubPushEvent;

describe('GitHub webhook events', () => {
  it('verifies a signature over the exact request body', async () => {
    const body = JSON.stringify(pushEvent);
    const headers = new Headers({
      'x-hub-signature-256': await signature(body, 'webhook-secret'),
    });

    await expect(
      verifyGitHubWebhookSignature({ body, headers }, 'webhook-secret')
    ).resolves.toBeUndefined();
    await expect(
      verifyGitHubWebhookSignature(
        { body: `${body}\n`, headers },
        'webhook-secret'
      )
    ).rejects.toBeInstanceOf(GitHubWebhookSignatureError);
  });

  it.each([undefined, 'sha1=abc', `sha256=${'0'.repeat(64)}`])(
    'rejects a missing or invalid signature: %s',
    async (header) => {
      const body = JSON.stringify(pushEvent);
      const headers = new Headers();
      if (header) {
        headers.set('x-hub-signature-256', header);
      }

      await expect(
        verifyGitHubWebhookSignature({ body, headers }, 'webhook-secret')
      ).rejects.toBeInstanceOf(GitHubWebhookSignatureError);
    }
  );

  it('parses and maps a branch push', () => {
    expect(
      mapGitHubPushEventToCiParams(
        parseGitHubPushEvent(JSON.stringify(pushEvent))
      )
    ).toEqual({
      provider: 'github',
      providerData: { installationId: 12345 },
      event: { type: 'push' },
      owner: 'cloudflare',
      repo: 'workers-sdk',
      sha: 'after456',
      remote: 'github',
      trigger: 'push',
      ref: 'refs/heads/main',
      branch: 'main',
      tag: undefined,
      beforeSha: 'before123',
      headCommitMessage: 'ship it',
      actor: 'octocat',
    });
  });

  it('maps a tag push without an installation or head commit', () => {
    expect(
      mapGitHubPushEventToCiParams({
        ...pushEvent,
        ref: 'refs/tags/v1.0.0',
        installation: undefined,
        head_commit: null,
      })
    ).toEqual({
      provider: 'github',
      providerData: {},
      event: { type: 'tag' },
      owner: 'cloudflare',
      repo: 'workers-sdk',
      sha: 'after456',
      remote: 'github',
      trigger: 'tag',
      ref: 'refs/tags/v1.0.0',
      branch: undefined,
      tag: 'v1.0.0',
      beforeSha: 'before123',
      headCommitMessage: undefined,
      actor: 'octocat',
    });
  });

  it.each([
    { ref: 'refs/notes/test' },
    { deleted: true },
    { after: '0000000000000000000000000000000000000000' },
  ])('ignores unsupported or deleted refs: %o', (overrides) => {
    expect(
      mapGitHubPushEventToCiParams({ ...pushEvent, ...overrides })
    ).toBeNull();
  });

  it('rejects a malformed push payload', () => {
    expect(() =>
      parseGitHubPushEvent(JSON.stringify({ ...pushEvent, repository: {} }))
    ).toThrow(/repository/);
  });
});

async function signature(body: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body)
  );
  return `sha256=${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}
