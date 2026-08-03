/* Main CI worker: receives source-control events and starts pipelines. */

import { Hono } from 'hono';
import { CiSandbox, startCiRun } from '@cloudflare/ci/worker';
import type { Bindings, Env } from '../env';
import { CI } from '../cloudflare.ci';

export { CiSandbox };
export { CI, Healer } from '../cloudflare.ci';

const app = new Hono<Env>();
const sourceControl = CI.getProvider();

app.get('/health', (c) => c.json({ ok: true }));

async function consumeArtifactsEvents(
  batch: MessageBatch<unknown>,
  env: Bindings
) {
  const provider = sourceControl.create(env);
  await Promise.all(
    batch.messages.map(async (message) => {
      let stage = 'receive-event';
      try {
        const event = await provider.receiveEvent({
          body:
            typeof message.body === 'string'
              ? message.body
              : JSON.stringify(message.body),
          headers: new Headers(),
        });
        if (event?.type === 'run' && sourceControl.accepts(event.params)) {
          stage = 'start-workflow';
          await startCiRun(env, event.params);
        }
        message.ack();
      } catch (error) {
        const details =
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : {
                name: 'UnknownError',
                message: String(error),
                stack: undefined,
              };
        console.error({
          message: 'Artifacts event processing failed',
          messageId: message.id,
          stage,
          eventType: artifactEventType(message.body),
          exceptionName: details.name,
          exceptionMessage: details.message,
          exceptionStack: details.stack,
        });
        message.retry();
      }
    })
  );
}

function artifactEventType(body: unknown) {
  if (typeof body === 'object' && body !== null && 'type' in body) {
    return typeof body.type === 'string' ? body.type : undefined;
  }
  if (typeof body !== 'string') {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      typeof value.type === 'string'
      ? value.type
      : undefined;
  } catch {
    return undefined;
  }
}

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  queue: consumeArtifactsEvents,
} satisfies ExportedHandler<Bindings>;
