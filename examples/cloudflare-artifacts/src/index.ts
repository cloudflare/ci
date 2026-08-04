/*
 * Artifacts CI worker: pipelines are started by the `cf.artifacts.repo.pushed`
 * trigger wired to the Workflow in wrangler.jsonc, so this Worker only needs to
 * export the durable bindings and answer a health check.
 */

import { Hono } from 'hono';
import { CiSandbox } from '@cloudflare/ci/worker';
import type { Bindings, Env } from '../env';

export { CiSandbox };
export { CI } from '../cloudflare.ci';

const app = new Hono<Env>();

// health check
app.get('/health', (c) => c.json({ ok: true }));

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Bindings>;
