import type {
  CiParams,
  CiRunnerFailureDiagnostics,
  CloudflareArtifacts,
} from '@cloudflare/ci';
import type { WorkflowEvent } from 'cloudflare:workers';
import type { HealFailure } from './types';

export function enrichFailure({
  failure,
  event,
  baseBranch,
}: {
  failure: {
    diagnostics: CiRunnerFailureDiagnostics;
    snapshot?: HealFailure['snapshot'];
  };
  event: WorkflowEvent<CiParams<CloudflareArtifacts>>;
  baseBranch: string;
}): HealFailure {
  return {
    runId: event.instanceId,
    source: {
      owner: event.payload.owner,
      repo: event.payload.repo,
      sha: event.payload.sha,
      providerData: event.payload.providerData,
    },
    baseBranch,
    failures: failure.diagnostics.failures,
    ...(failure.snapshot === undefined ? {} : { snapshot: failure.snapshot }),
    verificationCommands: failure.diagnostics.runners.map(
      ({ command, cwd }) => ({
        command,
        ...(cwd === undefined ? {} : { cwd }),
      })
    ),
  };
}

export class CiRunFailedWithFix extends Error {
  constructor(
    readonly failure: {
      runner: CiRunnerFailureDiagnostics['failures'][number]['runner'];
    },
    readonly fix: { branch: string; commit: string; steps: number }
  ) {
    super(
      `${failure.runner.name} failed; verified fix pushed to ${fix.branch} at ${fix.commit}`,
      { cause: failure }
    );
    this.name = 'CiRunFailedWithFix';
  }
}
