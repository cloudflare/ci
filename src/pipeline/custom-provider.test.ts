import { describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Bindings } from '../env';

vi.mock('../ci/capabilities', () => ({ runCiStep: vi.fn() }));

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    readonly env: unknown;

    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

import {
  CIWorkflow,
  SourceControlProvider,
  createAdapter,
  type CiContext,
  type CiParams,
  type SourceControlEvent,
  type SourceControlEventInput,
  type SourceControlProviderDefinition,
  type SourceControlSource,
} from '../index';

type CustomProvider = SourceControlProviderDefinition<
  'custom',
  { type: 'push' },
  { kind: string }
>;

class CustomSourceControl extends SourceControlProvider<CustomProvider> {
  receiveEvent(
    _event: SourceControlEventInput
  ): Promise<SourceControlEvent<CustomProvider> | null> {
    return Promise.resolve(null);
  }

  getSourceCheckout(source: SourceControlSource) {
    return Promise.resolve({
      kind: 'archive' as const,
      url: `https://example.test/${source.owner}/${source.repo}/${source.sha}`,
    });
  }

  listTreeBlobs() {
    return Promise.resolve([]);
  }

  getStepCredentialEnv() {
    return Promise.resolve({});
  }
}

const customAdapter = createAdapter<CustomProvider>(
  'custom',
  { owner: 'acme', repo: 'widgets' },
  () => new CustomSourceControl(),
  true
);

class CustomWorkflow extends CIWorkflow<CustomProvider> {
  static override getProvider() {
    return customAdapter;
  }

  pipeline = vi.fn(
    (
      _event: WorkflowEvent<CiParams<CustomProvider>>,
      _step: WorkflowStep,
      _ci: CiContext
    ) => Promise.resolve()
  );
}

const customEvent = {
  instanceId: 'instance-1',
  workflowName: 'custom-ci',
  timestamp: new Date('2026-08-23T00:00:00.000Z'),
  payload: {
    provider: 'custom',
    providerData: { kind: 'git' },
    event: { type: 'push' },
    owner: 'acme',
    repo: 'widgets',
    sha: '1234567890abcdef1234567890abcdef12345678',
    trigger: 'push',
    ref: 'refs/heads/main',
    branch: 'main',
  },
} satisfies WorkflowEvent<CiParams<CustomProvider>>;

describe('custom SourceControlProvider', () => {
  it('typechecks a non-Artifacts provider against CIWorkflow', () => {
    expect(CustomWorkflow.getProvider()).toBe(customAdapter);
    expect(CustomWorkflow.getProvider().id).toBe('custom');
  });

  it('runs a CIWorkflow parameterized by that provider', async () => {
    const workflow = new CustomWorkflow(
      fromPartial<ExecutionContext>({}),
      fromPartial<Bindings>({})
    );

    await expect(
      workflow.run(customEvent, fromPartial<WorkflowStep>({}))
    ).resolves.toEqual({ conclusion: 'success' });
    expect(workflow.pipeline).toHaveBeenCalledOnce();
    expect(workflow.pipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          provider: 'custom',
          owner: 'acme',
          repo: 'widgets',
        }),
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it('rejects runs for another repository using the custom provider id', async () => {
    const workflow = new CustomWorkflow(
      fromPartial<ExecutionContext>({}),
      fromPartial<Bindings>({})
    );
    const otherRepoEvent = {
      ...customEvent,
      payload: { ...customEvent.payload, repo: 'other' },
    } satisfies WorkflowEvent<CiParams<CustomProvider>>;

    await expect(
      workflow.run(otherRepoEvent, fromPartial<WorkflowStep>({}))
    ).rejects.toThrow('Unsupported CI source: custom:acme/other');
  });
});
