import type { CiBindings } from '@cloudflare/ci/worker';

export type Bindings = CiBindings & CloudflareBindings;

export type Env = {
  Bindings: Bindings;
  Variables: Record<string, never>;
};
