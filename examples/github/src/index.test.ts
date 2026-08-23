import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Bindings } from '../env';

const dispatch = vi.hoisted(() => ({
  restartCiRun: vi.fn(),
  startCiRun: vi.fn(),
}));

vi.mock('@cloudflare/ci/worker', () => ({
  CiSandbox: class {
    readonly mocked = true;
  },
  ...dispatch,
}));
vi.mock('@cloudflare/ci', async () => {
  const { github } = await import('@cloudflare/ci/worker/source-control');
  return {
    CIWorkflow: class {
      readonly mocked = true;
    },
    github,
  };
});

const { default: worker } = await import('./index');

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
};

describe('GitHub webhook route', () => {
  beforeEach(() => {
    dispatch.restartCiRun.mockReset();
    dispatch.startCiRun.mockReset();
  });

  it('dispatches a signed push to the CI Workflow', async () => {
    dispatch.startCiRun.mockResolvedValue('ci-github-workers-sdk-run');

    const response = await request(pushEvent);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      status: 'started',
      id: 'ci-github-workers-sdk-run',
    });
    expect(dispatch.startCiRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: 'github',
        owner: 'cloudflare',
        repo: 'workers-sdk',
        sha: 'after456',
      })
    );
  });

  it('reports a duplicate commit', async () => {
    dispatch.startCiRun.mockResolvedValue(null);

    const response = await request(pushEvent);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      id: null,
      status: 'duplicate',
    });
  });

  it('rejects an invalid signature', async () => {
    const response = await request(pushEvent, 'push', 'invalid');

    expect(response.status).toBe(401);
    expect(dispatch.startCiRun).not.toHaveBeenCalled();
  });

  it('ignores a signed unsupported event', async () => {
    const response = await request(
      { zen: 'Keep it logically awesome.' },
      'ping'
    );

    expect(response.status).toBe(204);
    expect(dispatch.startCiRun).not.toHaveBeenCalled();
  });

  it('rejects a malformed signed push payload', async () => {
    const response = await request({});

    expect(response.status).toBe(400);
    expect(dispatch.startCiRun).not.toHaveBeenCalled();
  });
});

async function request(
  payload: unknown,
  event = 'push',
  signatureOverride?: string
) {
  const body = JSON.stringify(payload);
  const signature =
    signatureOverride ?? (await webhookSignature(body, 'webhook-secret'));
  const webhookRequest = new Request('https://ci.example.com/webhooks/github', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-Hub-Signature-256': signature,
    },
  }) as Parameters<typeof worker.fetch>[0];
  return worker.fetch(
    webhookRequest,
    fromPartial<Bindings>({ GITHUB_WEBHOOK_SECRET: 'webhook-secret' }),
    fromPartial<ExecutionContext>({})
  );
}

async function webhookSignature(body: string, secret: string) {
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
