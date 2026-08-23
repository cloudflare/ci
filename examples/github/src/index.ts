/*
 * GitHub CI worker: signed repository webhooks are normalized and dispatched
 * to the durable Workflow through the Worker fetch handler.
 */

import { Hono } from 'hono';
import { CiSandbox, restartCiRun, startCiRun } from '@cloudflare/ci/worker';
import { GitHubWebhookSignatureError } from '@cloudflare/ci/worker/source-control';
import type { Bindings, Env } from '../env';
import { sourceControl } from '../cloudflare.ci';

export { CiSandbox };
export { CI } from '../cloudflare.ci';

const app = new Hono<Env>();

app.get('/health', (c) => c.json({ ok: true }));

app.post('/webhooks/github', async (c) => {
  const body = await c.req.text();
  const provider = sourceControl.create(c.env);
  let event;
  try {
    event = await provider.receiveEvent({
      body,
      headers: c.req.raw.headers,
    });
  } catch (error) {
    if (error instanceof GitHubWebhookSignatureError) {
      return c.json({ error: 'Invalid GitHub webhook signature' }, 401);
    }
    return c.json({ error: 'Invalid GitHub webhook payload' }, 400);
  }

  if (!event) {
    return c.body(null, 204);
  }
  if (event.type === 'rerun') {
    const id = await restartCiRun(c.env, event.source);
    return c.json({ id, status: 'restarted' }, 202);
  }
  const id = await startCiRun(c.env, event.params);
  return c.json({ id, status: id ? 'started' : 'duplicate' }, 202);
});

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Bindings>;
