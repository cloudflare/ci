import type { CiRunnerFailureDiagnostics } from '@cloudflare/ci';

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
