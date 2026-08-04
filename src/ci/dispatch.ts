// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Bindings } from '../env';
import type { CiParams, CiSource } from '../pipeline';
import { runId } from './run-id';

type WorkflowEnv<TParams> = { CI_WORKFLOW: Workflow<TParams> };
type RestartWorkflowEnv = Pick<Bindings, 'CI_WORKFLOW'>;

/**
 * Starts a Workflow with a deterministic source-based ID.
 * Returns null when a Workflow already exists for the same source commit.
 */
export async function startCiRun<TParams extends CiParams>(
  env: WorkflowEnv<TParams>,
  params: TParams
) {
  const id = await runId(params);
  const [instance] = await env.CI_WORKFLOW.createBatch([{ id, params }]);
  return instance?.id ?? null;
}

/** Restarts the Workflow identified by the source commit. */
export async function restartCiRun(env: RestartWorkflowEnv, source: CiSource) {
  const instance = await env.CI_WORKFLOW.get(await runId(source));
  await instance.restart();
  return instance.id;
}
