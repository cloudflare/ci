// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import type {
  CiContext,
  CiParams,
  CiRunStepInput,
  CiRunnerResult,
  CiWorkflowPayload,
  CloudflareArtifacts,
  DirectoryBackup,
  RunnerOptions,
  SourceControlProviderDefinition,
  StepConfig,
} from './types';
import {
  cloudflareArtifacts,
  type SourceControlAdapter,
} from '../source-control-adapter';
import type { Bindings } from '../env';
import { runCiStep } from '../ci/capabilities';
import { RunnerGroup } from './runner-group';

const DEFAULT_STEP_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_STEP_CONFIG = {
  retries: { limit: 2, delay: 30_000, backoff: 'linear' },
  timeout: DEFAULT_STEP_TIMEOUT_MS,
} satisfies StepConfig;
const COMMAND_TIMEOUT_MARGIN_MS = 10_000;

type ResolvedRunnerConfig = {
  workflow: {
    retries: NonNullable<StepConfig['retries']>;
    timeout: number;
  };
  commandTimeoutMs: number;
  snapshotTtlSeconds?: number;
};

type RunContext = Pick<
  CiRunStepInput,
  'provider' | 'providerData' | 'source' | 'cacheScope' | 'instanceId'
>;

/**
 * Base class for durable CI pipelines.
 * Each runner is a retried Workflow step. Chained runners restore the previous
 * runner's workspace Snapshot unless they hit a cache. Subclasses implement
 * `pipeline` and may override `getProvider`.
 */
export abstract class CIWorkflow<
  TProvider extends SourceControlProviderDefinition = CloudflareArtifacts,
  TBindings extends Bindings = Bindings,
> extends WorkflowEntrypoint<TBindings, CiWorkflowPayload<TProvider>> {
  /**
   * Returns the adapter used for events, checkout, credentials, and reporting.
   * Subclasses may override this to select another source-control provider.
   */
  static getProvider(): SourceControlAdapter {
    return cloudflareArtifacts();
  }

  private provider(): SourceControlAdapter<TProvider> {
    const constructor = this.constructor as typeof CIWorkflow;
    return constructor.getProvider() as SourceControlAdapter<TProvider>;
  }

  /**
   * Validates the event source and runs the configured pipeline.
   * This method is owned by the engine; subclasses should implement `pipeline`.
   */
  async run(
    event: WorkflowEvent<CiWorkflowPayload<TProvider>>,
    step: WorkflowStep
  ): Promise<{ conclusion: 'success' }> {
    const provider = this.provider();
    const payload = await this.normalizePayload(event.payload, provider);
    if (!payload) {
      return { conclusion: 'success' };
    }
    provider.assertSource(payload);
    const pipelineEvent = { ...event, payload } as WorkflowEvent<
      CiParams<TProvider>
    >;
    await this.pipeline(
      pipelineEvent,
      step,
      this.ciContext(pipelineEvent, step, provider)
    );
    return { conclusion: 'success' };
  }

  private async normalizePayload(
    payload: Readonly<CiWorkflowPayload<TProvider>>,
    adapter: SourceControlAdapter<TProvider>
  ): Promise<CiParams<TProvider> | null> {
    if ('provider' in payload) {
      return payload as unknown as CiParams<TProvider>;
    }
    const event = await adapter.create(this.env).receiveEvent({
      body: JSON.stringify(payload),
      headers: new Headers(),
    });
    return event?.type === 'run' ? event.params : null;
  }

  /**
   * Defines the repository pipeline.
   * Use `ci` for Sandbox runners and `step` for other durable Workflow work.
   */
  protected abstract pipeline(
    event: WorkflowEvent<CiParams<TProvider>>,
    step: WorkflowStep,
    ci: CiContext
  ): Promise<void>;

  private ciContext(
    event: WorkflowEvent<CiParams<TProvider>>,
    step: WorkflowStep,
    provider: SourceControlAdapter<TProvider>
  ): CiContext {
    const p = event.payload;
    const runContext: RunContext = {
      provider: p.provider,
      providerData: p.providerData,
      source: { owner: p.owner, repo: p.repo, ref: p.ref, sha: p.sha },
      cacheScope: p.ref,
      instanceId: event.instanceId,
    };
    const runners = new RunnerGroup();

    // Every result creates a workspace snapshot so chained runners remain
    // durable across Workflow replay and hibernation. The per-runner storage
    // cost is accepted to keep the snapshot durable across arbitrarily long
    // Workflow waits.
    const invoke = (
      options: RunnerOptions,
      inherited: DirectoryBackup | undefined
    ): Promise<CiRunnerResult> =>
      runners.run(options, inherited, () => {
        const config = resolveRunnerConfig(options);
        return step
          .do(options.name, config.workflow, (ctx) =>
            runCiStep(this.env, provider, {
              ...runContext,
              label: options.name,
              attempt: ctx.attempt,
              command: options.command,
              cwd: options.cwd,
              commandTimeoutMs: config.commandTimeoutMs,
              snapshot: inherited,
              snapshotTtlSeconds: config.snapshotTtlSeconds,
              cloudflareCredentials: options.cloudflareCredentials,
              sourceControlCredentials: options.sourceControlCredentials,
              cachePaths: options.cache?.inputs,
              env: options.env,
              secrets: options.secrets,
            })
          )
          .then((output) =>
            Object.freeze({
              ...output,
              runner: (nextOptions: RunnerOptions) =>
                invoke(nextOptions, output.snapshot),
            })
          );
      });

    // CI ctx object
    return Object.freeze({
      runner: (options) => invoke(options, undefined),
    });
  }
}

/**
 * Resolves a runner's Workflow step config from RunnerOptions: applies
 * defaults, derives commandTimeoutMs to sit under the step timeout (enforcing
 * the margin), and validates all values are positive.
 */
function resolveRunnerConfig(options: RunnerOptions): ResolvedRunnerConfig {
  const workflow = {
    // Constructing this explicitly keeps runner-only settings out of step.do.
    retries: options.config?.retries ?? DEFAULT_STEP_CONFIG.retries,
    timeout: options.config?.timeout ?? DEFAULT_STEP_CONFIG.timeout,
  };
  assertPositiveFinite(workflow.timeout, options.name, 'timeout');
  const maximum = Math.max(1, workflow.timeout - COMMAND_TIMEOUT_MARGIN_MS);
  const commandTimeoutMs = options.config?.commandTimeoutMs ?? maximum;
  assertPositiveFinite(commandTimeoutMs, options.name, 'commandTimeoutMs');
  if (commandTimeoutMs > maximum) {
    throw new Error(
      `runner(${options.name}): config.commandTimeoutMs must not exceed ${maximum}ms`
    );
  }
  const snapshotTtlSeconds = options.config?.snapshotRetentionSeconds;
  if (snapshotTtlSeconds !== undefined) {
    assertPositiveFinite(
      snapshotTtlSeconds,
      options.name,
      'snapshotRetentionSeconds'
    );
  }
  return { workflow, commandTimeoutMs, snapshotTtlSeconds };
}

function assertPositiveFinite(
  value: number,
  runner: string,
  field: string
): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`runner(${runner}): config.${field} must be positive`);
  }
}
