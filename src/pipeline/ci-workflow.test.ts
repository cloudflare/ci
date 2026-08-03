import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { fromPartial } from '@total-typescript/shoehorn';
import type {
  CiContext,
  CiParams,
  CiRunnerResult,
  CloudflareArtifacts,
  RunnerConfig,
} from './types';
import { cloudflareArtifacts } from '../source-control-adapter';
import type { Bindings } from '../env';

const mocks = vi.hoisted(() => ({
  runCiStep: vi.fn(),
}));

vi.mock('../ci/capabilities', () => ({ runCiStep: mocks.runCiStep }));

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    readonly env: unknown;

    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

import { CIWorkflow } from './ci-workflow';
import { CiRunnerFailure } from './failures';

const testProvider = cloudflareArtifacts({
  owner: 'cloudflare',
  repo: 'example',
});

class TestWorkflow extends CIWorkflow<CloudflareArtifacts> {
  static override getProvider() {
    return testProvider;
  }

  installResult: CiRunnerResult | undefined;
  nativeStep: WorkflowStep | undefined;

  protected async pipeline(
    _event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    step: WorkflowStep,
    ci: CiContext
  ): Promise<void> {
    this.nativeStep = step;
    const deps = await ci.runner({
      name: 'install',
      command: 'bun install --frozen-lockfile',
      cache: { inputs: ['package.json', 'bun.lock'] },
      sourceControlCredentials: true,
    });
    this.installResult = deps;
    await deps.runner({
      name: 'build',
      command: 'bun run build',
      cwd: 'apps/example',
      env: { NODE_ENV: 'production' },
      config: {
        retries: { limit: 1, delay: 1_000 },
        timeout: 300_000,
        commandTimeoutMs: 240_000,
        snapshotRetentionSeconds: 7 * 24 * 60 * 60,
      },
    });
  }
}

class UncachedWorkflow extends CIWorkflow<CloudflareArtifacts> {
  static override getProvider() {
    return testProvider;
  }

  firstResult: CiRunnerResult | undefined;

  protected async pipeline(
    _event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    _step: WorkflowStep,
    ci: CiContext
  ): Promise<void> {
    const first = await ci.runner({ name: 'first', command: 'touch first' });
    this.firstResult = first;
    await first.runner({ name: 'second', command: 'test -f first' });
  }
}

class ParallelWorkflow extends CIWorkflow<CloudflareArtifacts> {
  static override getProvider() {
    return testProvider;
  }

  protected async pipeline(
    _event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    _step: WorkflowStep,
    ci: CiContext
  ): Promise<void> {
    await Promise.all([
      ci.runner({ name: 'first', command: 'run first' }),
      ci.runner({ name: 'second', command: 'run second' }),
    ]);
  }
}

class ChainedWhileSettlingWorkflow extends CIWorkflow<CloudflareArtifacts> {
  static override getProvider() {
    return testProvider;
  }

  protected async pipeline(
    _event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    _step: WorkflowStep,
    ci: CiContext
  ): Promise<void> {
    const first = ci.runner({ name: 'first', command: 'run first' });
    const sibling = ci.runner({ name: 'sibling', command: 'run sibling' });
    await Promise.all([
      first.then((result) =>
        result.runner({ name: 'chained', command: 'run chained' })
      ),
      sibling,
    ]);
  }
}

class ConfigurableWorkflow extends CIWorkflow<CloudflareArtifacts> {
  static override getProvider() {
    return testProvider;
  }

  runnerConfig: RunnerConfig = {};

  protected async pipeline(
    _event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    _step: WorkflowStep,
    ci: CiContext
  ): Promise<void> {
    await ci.runner({
      name: 'configured',
      command: 'run configured',
      config: this.runnerConfig,
    });
  }
}

class ArtifactsWorkflow extends CIWorkflow<CloudflareArtifacts> {
  pipeline = vi.fn<
    (
      event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
      step: WorkflowStep,
      ci: CiContext
    ) => Promise<void>
  >(() => Promise.resolve());
}

const event = {
  instanceId: 'instance-1',
  workflowName: 'test-ci',
  timestamp: new Date('2026-07-14T00:00:00.000Z'),
  payload: {
    provider: 'cloudflare-artifacts',
    providerData: { namespace: 'cloudflare' },
    event: { type: 'push' },
    remote: 'cloudflare',
    owner: 'cloudflare',
    repo: 'example',
    sha: '1234567890abcdef1234567890abcdef12345678',
    trigger: 'push',
    ref: 'refs/heads/feature',
    branch: 'feature',
    actor: 'octocat',
  },
} satisfies WorkflowEvent<CiParams<CloudflareArtifacts>>;

describe('CIWorkflow ci.runner', () => {
  beforeEach(() => {
    mocks.runCiStep.mockReset();
  });

  it('runs steps inside the Workflow and chains snapshots', async () => {
    mocks.runCiStep.mockImplementation(
      (_env, _provider, { label }: { label: string }) =>
        Promise.resolve({
          exitCode: 0,
          logs: { stdout: `${label} ok`, stderr: '' },
          snapshot: { id: `snap-${label}`, dir: '/workspace' },
          cachePointer:
            label === 'install'
              ? {
                  key: 'cache-key',
                  createdAt: '2026-07-14T00:00:00.000Z',
                  sizeBytes: 123,
                }
              : undefined,
        })
    );
    const env = fromPartial<Bindings>({});
    const workflow = new TestWorkflow(fromPartial<ExecutionContext>({}), env);
    const step = fromPartial<WorkflowStep>({
      do: vi.fn(
        async (
          _label: string,
          _config: unknown,
          callback: (context: { attempt: number }) => Promise<unknown>
        ) => callback({ attempt: 1 })
      ),
    });

    await expect(workflow.run(event, step)).resolves.toEqual({
      conclusion: 'success',
    });

    expect(mocks.runCiStep).toHaveBeenCalledTimes(2);
    expect(step.do).toHaveBeenNthCalledWith(
      1,
      'install',
      {
        retries: { limit: 2, delay: 30_000, backoff: 'linear' },
        timeout: 720_000,
      },
      expect.any(Function)
    );
    expect(mocks.runCiStep).toHaveBeenNthCalledWith(
      1,
      env,
      TestWorkflow.getProvider(),
      expect.objectContaining({
        label: 'install',
        cachePaths: ['package.json', 'bun.lock'],
        cacheScope: 'refs/heads/feature',
        sourceControlCredentials: true,
      })
    );
    // The second step inherits the first step's snapshot.
    expect(mocks.runCiStep).toHaveBeenNthCalledWith(
      2,
      env,
      TestWorkflow.getProvider(),
      expect.objectContaining({
        label: 'build',
        cwd: 'apps/example',
        env: { NODE_ENV: 'production' },
        snapshot: { id: 'snap-install', dir: '/workspace' },
        commandTimeoutMs: 240_000,
        snapshotTtlSeconds: 604_800,
      })
    );
    expect(step.do).toHaveBeenNthCalledWith(
      2,
      'build',
      {
        retries: { limit: 1, delay: 1_000 },
        timeout: 300_000,
      },
      expect.any(Function)
    );
    expect(step).not.toHaveProperty('runner');
    expect(workflow.nativeStep).toBe(step);
    expect(workflow.installResult).toMatchObject({
      exitCode: 0,
      logs: { stdout: 'install ok', stderr: '' },
      snapshot: { id: 'snap-install', dir: '/workspace' },
      cachePointer: {
        key: 'cache-key',
        sizeBytes: 123,
      },
      runner: expect.any(Function),
    });
  });

  it('keeps uncached results chainable through their workspace snapshot', async () => {
    mocks.runCiStep.mockImplementation(
      (_env, _provider, { label }: { label: string }) =>
        Promise.resolve({
          exitCode: 0,
          logs: { stdout: '', stderr: '' },
          snapshot: { id: `lineage-${label}`, dir: '/workspace' },
        })
    );
    const workflow = new UncachedWorkflow(
      fromPartial<ExecutionContext>({}),
      fromPartial<Bindings>({})
    );
    const step = fromPartial<WorkflowStep>({
      do: vi.fn(
        async (
          _label: string,
          _config: unknown,
          callback: (context: { attempt: number }) => Promise<unknown>
        ) => callback({ attempt: 1 })
      ),
    });

    await workflow.run(event, step);

    expect(workflow.firstResult).toMatchObject({
      snapshot: { id: 'lineage-first', dir: '/workspace' },
    });
    expect(workflow.firstResult).not.toHaveProperty('cachePointer');
    expect(workflow.firstResult).toHaveProperty('runner', expect.any(Function));
    expect(mocks.runCiStep).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      UncachedWorkflow.getProvider(),
      expect.objectContaining({
        label: 'second',
        snapshot: { id: 'lineage-first', dir: '/workspace' },
      })
    );
  });

  it('does not start downstream runners after a failed command', async () => {
    mocks.runCiStep.mockRejectedValue(new Error('install failed'));
    const workflow = new TestWorkflow(
      fromPartial<ExecutionContext>({}),
      fromPartial<Bindings>({})
    );
    const step = fromPartial<WorkflowStep>({
      do: vi.fn(
        async (
          _label: string,
          _config: unknown,
          callback: (context: { attempt: number }) => Promise<unknown>
        ) => callback({ attempt: 1 })
      ),
    });

    const failure = await workflow.run(event, step).catch((error) => error);

    expect(failure).toBeInstanceOf(CiRunnerFailure);
    expect(failure).toMatchObject({
      output: 'install failed',
      runner: {
        name: 'install',
        command: 'bun install --frozen-lockfile',
      },
      snapshot: undefined,
      diagnostics: {
        failures: [
          {
            runner: {
              name: 'install',
              command: 'bun install --frozen-lockfile',
            },
            output: 'install failed',
          },
        ],
        runners: [
          {
            name: 'install',
            command: 'bun install --frozen-lockfile',
          },
        ],
      },
    });
    expect(failure.runner).not.toHaveProperty('sourceControlCredentials');
    expect(mocks.runCiStep).toHaveBeenCalledOnce();
  });

  it('reports parallel failures in declaration order', async () => {
    const first = deferred<never>();
    const second = deferred<never>();
    mocks.runCiStep.mockImplementation(
      (_env, _provider, { label }: { label: string }) =>
        label === 'first' ? first.promise : second.promise
    );
    const workflow = new ParallelWorkflow(
      fromPartial<ExecutionContext>({}),
      fromPartial<Bindings>({})
    );
    const running = workflow.run(event, immediateWorkflowStep());
    await vi.waitFor(() => expect(mocks.runCiStep).toHaveBeenCalledTimes(2));

    second.reject(new Error('second failed first'));
    first.reject(new Error('first failed second'));
    const failure = await running.catch((error) => error);

    expect(failure).toMatchObject({
      runner: { name: 'first', command: 'run first' },
      output: 'first failed second',
      diagnostics: {
        failures: [
          {
            runner: { name: 'first', command: 'run first' },
            output: 'first failed second',
          },
          {
            runner: { name: 'second', command: 'run second' },
            output: 'second failed first',
          },
        ],
        runners: [
          { name: 'first', command: 'run first' },
          { name: 'second', command: 'run second' },
        ],
      },
    });
  });

  it('includes a chained failure started while siblings settle', async () => {
    const first = deferred<ReturnType<typeof successfulStep>>();
    mocks.runCiStep.mockImplementation(
      (_env, _provider, { label }: { label: string }) => {
        if (label === 'first') {
          return first.promise;
        }
        return Promise.reject(new Error(`${label} failed`));
      }
    );
    const workflow = new ChainedWhileSettlingWorkflow(
      fromPartial<ExecutionContext>({}),
      fromPartial<Bindings>({})
    );
    const running = workflow.run(event, immediateWorkflowStep());
    await vi.waitFor(() => expect(mocks.runCiStep).toHaveBeenCalledTimes(2));

    first.resolve(successfulStep('first'));
    const failure = await running.catch((error) => error);

    expect(mocks.runCiStep).toHaveBeenCalledTimes(3);
    expect(failure).toMatchObject({
      runner: { name: 'sibling', command: 'run sibling' },
      diagnostics: {
        failures: [
          {
            runner: { name: 'sibling', command: 'run sibling' },
            output: 'sibling failed',
          },
          {
            runner: { name: 'chained', command: 'run chained' },
            output: 'chained failed',
          },
        ],
        runners: [
          { name: 'first', command: 'run first' },
          { name: 'sibling', command: 'run sibling' },
          { name: 'chained', command: 'run chained' },
        ],
      },
    });
  });

  it.each([
    [
      'command timeout above the Workflow limit',
      { timeout: 30_000, commandTimeoutMs: 20_001 },
      'config.commandTimeoutMs must not exceed 20000ms',
    ],
    [
      'zero snapshot retention',
      { snapshotRetentionSeconds: 0 },
      'config.snapshotRetentionSeconds must be positive',
    ],
    [
      'non-finite command timeout',
      { commandTimeoutMs: Number.POSITIVE_INFINITY },
      'config.commandTimeoutMs must be positive',
    ],
    [
      'zero Workflow timeout',
      { timeout: 0 },
      'config.timeout must be positive',
    ],
    [
      'non-finite Workflow timeout',
      { timeout: Number.POSITIVE_INFINITY },
      'config.timeout must be positive',
    ],
  ] satisfies Array<[string, RunnerConfig, string]>)(
    'rejects %s',
    async (_case, runnerConfig, message) => {
      const workflow = new ConfigurableWorkflow(
        fromPartial<ExecutionContext>({}),
        fromPartial<Bindings>({})
      );
      workflow.runnerConfig = runnerConfig;
      const step = immediateWorkflowStep();

      await expect(workflow.run(event, step)).rejects.toThrow(message);
      expect(step.do).not.toHaveBeenCalled();
    }
  );

  it('rejects direct runs for another repository', async () => {
    const workflow = new TestWorkflow(
      fromPartial<ExecutionContext>({}),
      fromPartial<Bindings>({})
    );
    const otherRepoEvent = {
      ...event,
      payload: { ...event.payload, repo: 'other' },
    } satisfies WorkflowEvent<CiParams<CloudflareArtifacts>>;

    await expect(
      workflow.run(otherRepoEvent, fromPartial<WorkflowStep>({}))
    ).rejects.toThrow(
      'Unsupported CI source: cloudflare-artifacts:cloudflare/other'
    );
    expect(mocks.runCiStep).not.toHaveBeenCalled();
  });

  it('normalizes direct Artifacts trigger payloads before running a pipeline', async () => {
    const workflow = new ArtifactsWorkflow(
      fromPartial<ExecutionContext>({}),
      fromPartial<Bindings>({})
    );
    const directEvent = {
      instanceId: 'instance-1',
      workflowName: 'test-ci',
      timestamp: new Date('2026-07-30T17:27:44.000Z'),
      payload: {
        id: '3d5fae4d-9825-44b9-ae30-7c4eab596465',
        type: 'cf.artifacts.repo.pushed',
        source: { namespace: 'default', repoName: 'test11' },
        payload: {
          ref: 'refs/heads/main',
          before: 'e8e2cf765c0615667bd605029b17b68790654618',
          after: '5b79411a347bed32dc41f3c3d68e148db9d3a676',
          commits: [
            {
              id: '5b79411a347bed32dc41f3c3d68e148db9d3a676',
              message: 'ship it',
              author: { name: 'git-ai', email: 'git-ai@local' },
            },
          ],
        },
      },
    } satisfies WorkflowEvent<
      Parameters<ArtifactsWorkflow['run']>[0]['payload']
    >;

    await expect(
      workflow.run(directEvent, fromPartial<WorkflowStep>({}))
    ).resolves.toEqual({ conclusion: 'success' });
    expect(workflow.pipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          provider: 'cloudflare-artifacts',
          owner: 'default',
          repo: 'test11',
          ref: 'refs/heads/main',
        }),
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it('ignores unsupported direct Artifacts refs', async () => {
    const workflow = new ArtifactsWorkflow(
      fromPartial<ExecutionContext>({}),
      fromPartial<Bindings>({})
    );
    const notesEvent = {
      instanceId: 'instance-1',
      workflowName: 'test-ci',
      timestamp: new Date('2026-07-30T17:27:44.000Z'),
      payload: {
        id: '3d5fae4d-9825-44b9-ae30-7c4eab596465',
        type: 'cf.artifacts.repo.pushed',
        source: { namespace: 'default', repoName: 'test11' },
        payload: {
          ref: 'refs/notes/ai',
          before: 'before',
          after: 'after',
          commits: [],
        },
      },
    } satisfies WorkflowEvent<
      Parameters<ArtifactsWorkflow['run']>[0]['payload']
    >;

    await expect(
      workflow.run(notesEvent, fromPartial<WorkflowStep>({}))
    ).resolves.toEqual({ conclusion: 'success' });
    expect(workflow.pipeline).not.toHaveBeenCalled();
  });
});

function immediateWorkflowStep() {
  return fromPartial<WorkflowStep>({
    do: vi.fn(
      async (
        _label: string,
        _config: unknown,
        callback: (context: { attempt: number }) => Promise<unknown>
      ) => callback({ attempt: 1 })
    ),
  });
}

function successfulStep(label: string) {
  return {
    exitCode: 0,
    logs: { stdout: '', stderr: '' },
    snapshot: { id: `lineage-${label}`, dir: '/workspace' },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
