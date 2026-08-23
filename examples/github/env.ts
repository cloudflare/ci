import type { CiBindings } from '@cloudflare/ci/worker';

type Secrets = {
  CLOUDFLARE_DEPLOY_ACCOUNT_ID: string;
};

export type Bindings = CiBindings & CloudflareBindings & Secrets;

export type Env = {
  Bindings: Bindings;
  Variables: Record<string, never>;
};
