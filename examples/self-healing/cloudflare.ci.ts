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
import { CiRunFailedWithFix, enrichFailure } from './src/healing/failures';
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
        command: 'npm ci',
        cache: { inputs: ['package.json', 'package-lock.json'] },
      });

      await Promise.all([
        deps.runner({ name: 'lint', command: 'npm run lint' }),
        deps.runner({ name: 'test', command: 'npm run test' }),
        deps.runner({ name: 'typecheck', command: 'npm run typecheck' }),
        deps.runner({ name: 'build', command: 'npm run build' }),
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
            failure: enrichFailure({ failure, event, baseBranch }),
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
      command: 'npm exec wrangler deploy',
      cloudflareCredentials: {
        accountId: this.env.CLOUDFLARE_DEPLOY_ACCOUNT_ID,
      },
    });
  }
}
