// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import { runId } from './run-id';

type RunSource = {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
};
type WorkflowEnv<TParams> = { CI_WORKFLOW: Workflow<TParams> };
type RestartWorkflowEnv = {
  CI_WORKFLOW: Pick<Workflow<unknown>, 'get'>;
};

/**
 * Starts a Workflow with a deterministic source-based ID.
 * Returns null when a Workflow already exists for the same source commit.
 */
export async function startCiRun<TParams extends RunSource>(
  env: WorkflowEnv<TParams>,
  params: TParams
) {
  const id = await runId(params);
  const [instance] = await env.CI_WORKFLOW.createBatch([{ id, params }]);
  return instance?.id ?? null;
}

/** Restarts the Workflow identified by the source commit. */
export async function restartCiRun(env: RestartWorkflowEnv, source: RunSource) {
  const instance = await env.CI_WORKFLOW.get(await runId(source));
  await instance.restart();
  return instance.id;
}
