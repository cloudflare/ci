// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

export type CheckRunRef = {
  installationId: number;
  owner: string;
  repo: string;
  checkRunId: number;
};

type Secrets = {
  [name: string]: unknown;
  CF_TOKEN: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
};

// Runtime contract owned by the CI package. A deployable Worker can intersect
// this with its Wrangler-generated CloudflareBindings for configuration checks.
export type Bindings = Secrets & {
  ARTIFACTS: Artifacts;
  BACKUP_BUCKET: R2Bucket;
  BACKUP_BUCKET_NAME: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  SANDBOX: DurableObjectNamespace<import('./ci/sandbox').CiSandbox>;
  CI_WORKFLOW: Workflow<
    import('./pipeline/types').CiParams<
      import('./pipeline/types').CloudflareArtifacts
    >
  >;
};

export type Variables = Record<string, never>;

export type Env = {
  Bindings: Bindings;
  Variables: Variables;
};
