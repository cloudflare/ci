// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

type Secrets = {
  [name: string]: unknown;
  CF_TOKEN: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
};

// Provider-neutral runtime contract owned by the CI engine. Source-control
// bindings and the concrete CI_WORKFLOW payload belong to the deployable Worker.
// Applications intersect this with their Wrangler-generated bindings.
export type Bindings = Secrets & {
  BACKUP_BUCKET: R2Bucket;
  BACKUP_BUCKET_NAME: string;
  SANDBOX: DurableObjectNamespace<import('./ci/sandbox').CiSandbox>;
};

export type CloudflareArtifactsBindings = {
  ARTIFACTS: Artifacts;
  CLOUDFLARE_ACCOUNT_ID: string;
};

export type Variables = Record<string, never>;

export type Env = {
  Bindings: Bindings;
  Variables: Variables;
};
