import { CIWorkflow } from '@cloudflare/ci';
import type { CiContext, CiParams, CloudflareArtifacts } from '@cloudflare/ci';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Bindings } from './env';

// The repository this pipeline builds is scoped by the `triggers.events` filter
// in wrangler.jsonc, so no `getProvider()` override is needed here. To restrict
// the pipeline to a specific source at the application level as well, override
// `getProvider()` to return `cloudflareArtifacts({ owner, repo })`.
export class CI extends CIWorkflow<CloudflareArtifacts, Bindings> {
  protected async pipeline(
    _event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    _step: WorkflowStep,
    ci: CiContext
  ): Promise<void> {
    const deps = await ci.runner({
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

    await deps.runner({
      name: 'deploy',
      command: 'npm exec wrangler deploy',
      cloudflareCredentials: {
        accountId: this.env.CLOUDFLARE_DEPLOY_ACCOUNT_ID,
      },
    });
  }
}
