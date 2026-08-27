// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Bindings } from '../env';
import type { CiRunStepInput, CloudflareArtifacts } from '../pipeline';
import type {
  SourceControlCheckout,
  SourceControlProvider,
} from '../source-control';
import type { SourceControlAdapter } from '../source-control-adapter';

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  lookupSnapshotCache: vi.fn(),
  publishSnapshotCache: vi.fn(),
  resolveCacheKey: vi.fn(),
}));

// The real SandboxRunner runs here, so the checkout script under test is the one
// the runner actually sends. Only the sandbox itself is faked.
vi.mock('@cloudflare/sandbox', () => ({ getSandbox: mocks.getSandbox }));
vi.mock('./cache', () => ({
  lookupSnapshotCache: mocks.lookupSnapshotCache,
  publishSnapshotCache: mocks.publishSnapshotCache,
  resolveCacheKey: mocks.resolveCacheKey,
}));

import { runCiStep } from './capabilities';

const ARCHIVE_SECRET = 'archive-signature-value';
const GIT_SECRET = 'git-token-value';

describe('checkout credentials in failure output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lookupSnapshotCache.mockResolvedValue({ status: 'miss' });
    mocks.resolveCacheKey.mockResolvedValue(undefined);
  });

  it('embeds an archive credential in the checkout command and redacts it from the failure', async () => {
    const checkout: SourceControlCheckout = {
      kind: 'archive',
      url: `https://example.com/source.tar.gz?signature=${ARCHIVE_SECRET}`,
    };
    const { sandbox, adapter, fail } = harness(checkout);

    const failure = (await runCiStep(
      fromPartial<Bindings>({}),
      adapter,
      input
    ).catch((error: unknown) => error)) as Error;

    // The credential really is in the command the runner sends, which is what
    // makes it reachable at all: the script interpolates the URL directly.
    const sent = sandbox.exec.mock.calls[0]![0] as string;
    expect(sent).toContain(ARCHIVE_SECRET);
    // ...and it does not survive into anything that leaves the engine.
    expect(failure.message).not.toContain(ARCHIVE_SECRET);
    expect(failure.message).toContain('[REDACTED]');
    expect(JSON.stringify(fail.mock.calls[0]![0])).not.toContain(
      ARCHIVE_SECRET
    );
  });

  it('keeps a git credential out of the checkout command and redacts it from the failure', async () => {
    const checkout: SourceControlCheckout = {
      kind: 'git',
      remote: 'https://artifacts.example/repo.git',
      token: GIT_SECRET,
      sha: 'abc123',
    };
    const { sandbox, adapter, fail } = harness(checkout);

    const failure = (await runCiStep(
      fromPartial<Bindings>({}),
      adapter,
      input
    ).catch((error: unknown) => error)) as Error;

    // The git path passes its token by environment, so the command text is
    // already clean. The redaction below is the second line of defense.
    const sent = sandbox.exec.mock.calls[0]![0] as string;
    expect(sent).not.toContain(GIT_SECRET);
    expect(sent).toContain('$SOURCE_CONTROL_TOKEN');
    expect(sandbox.exec.mock.calls[0]![1].env).toEqual({
      SOURCE_CONTROL_TOKEN: GIT_SECRET,
    });
    expect(failure.message).not.toContain(GIT_SECRET);
    expect(JSON.stringify(fail.mock.calls[0]![0])).not.toContain(GIT_SECRET);
  });
});

// A sandbox whose checkout exec fails and reports the command it was given,
// which is how the credential would reach the engine's failure path.
function harness(checkout: SourceControlCheckout) {
  const sandbox = {
    exec: vi.fn().mockImplementation((command: string) => {
      return Promise.reject(new Error(`checkout failed: ${command}`));
    }),
    startProcess: vi.fn(),
    createBackup: vi.fn(),
    restoreBackup: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  mocks.getSandbox.mockReturnValue(sandbox);

  const succeed = vi.fn().mockResolvedValue(undefined);
  const fail = vi.fn().mockResolvedValue(undefined);
  const provider = fromPartial<SourceControlProvider<CloudflareArtifacts>>({
    getSourceCheckout: vi.fn().mockResolvedValue(checkout),
    listTreeBlobs: vi.fn().mockResolvedValue(null),
    getStepCredentialEnv: vi.fn().mockResolvedValue({}),
    startStepNotification: vi.fn().mockResolvedValue({ succeed, fail }),
  });
  const adapter = fromPartial<SourceControlAdapter<CloudflareArtifacts>>({
    id: 'cloudflare-artifacts',
    repository: { owner: 'cloudflare', repo: 'example' },
    create: () => provider,
    accepts: () => true,
    assertSource: () => undefined,
  });
  return { sandbox, adapter, fail, succeed };
}

const input = {
  provider: 'cloudflare-artifacts',
  providerData: { namespace: 'cloudflare' },
  source: {
    owner: 'cloudflare',
    repo: 'example',
    ref: 'refs/heads/main',
    sha: 'abc123',
  },
  instanceId: 'instance-1',
  label: 'test',
  command: 'npm test',
} satisfies CiRunStepInput;
