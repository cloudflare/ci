import { CIWorkflow, isCiRunnerFailure } from '@cloudflare/ci';
import type {
  CiContext,
  CiParams,
  CiRunnerResult,
  CloudflareArtifacts,
} from '@cloudflare/ci';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getAgentByName } from 'agents';
import type { Bindings } from './env';
import { CiRunFailedWithFix } from './src/healing/failures';
import { HealingAgent } from './src/healing/healer';

export class Healer extends HealingAgent {
  getModel() {
    return '@cf/moonshotai/kimi-k2.7-code';
  }
}

export class CI extends CIWorkflow<CloudflareArtifacts, Bindings> {
  protected async pipeline(
    event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    step: WorkflowStep,
    ci: CiContext
  ): Promise<void> {
    let deps: CiRunnerResult;
    try {
      deps = await ci.runner({
        name: 'install',
        command: 'bun install --frozen-lockfile',
        cache: { inputs: ['package.json', 'bun.lock'] },
      });

      await Promise.all([
        deps.runner({ name: 'lint', command: 'bun run lint' }),
        deps.runner({ name: 'test', command: 'bun run test' }),
        deps.runner({ name: 'typecheck', command: 'bun run typecheck' }),
        deps.runner({ name: 'build', command: 'bun run build' }),
      ]);
    } catch (failure) {
      if (!isCiRunnerFailure(failure)) {
        throw failure;
      }
      const baseBranch = event.payload.branch;
      if (!baseBranch) {
        throw new Error('Cannot heal a run without a base branch');
      }

      const healed = await step.do(
        'heal',
        { retries: { limit: 0, delay: 0 }, timeout: '5 hours' },
        async () => {
          const healer = await getAgentByName(
            this.env.HEALER,
            event.instanceId
          );
          using result = await healer.heal({
            failure: {
              runId: event.instanceId,
              source: {
                owner: event.payload.owner,
                repo: event.payload.repo,
                sha: event.payload.sha,
                providerData: event.payload.providerData,
              },
              baseBranch,
              failures: failure.diagnostics.failures,
              ...(failure.snapshot === undefined
                ? {}
                : { snapshot: failure.snapshot }),
              verificationCommands: failure.diagnostics.runners.map(
                ({ command, cwd }) => ({
                  command,
                  ...(cwd === undefined ? {} : { cwd }),
                })
              ),
            },
            prompt: 'Fix every observed failure without weakening validation.',
          });
          const { branch, commit, steps } = result;
          return { branch, commit, steps };
        }
      );

      throw new CiRunFailedWithFix(failure, healed);
    }

    await deps.runner({
      name: 'deploy',
      command: 'bun wrangler deploy',
      cloudflareCredentials: {
        accountId: this.env.CLOUDFLARE_DEPLOY_ACCOUNT_ID,
      },
    });
  }
}
