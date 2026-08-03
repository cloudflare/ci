// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Bindings } from './env';
import type {
  CloudflareArtifacts,
  SourceControlProviderDefinition,
} from './pipeline/types';
import { CloudflareArtifactsSourceControlProvider } from './artifacts/source-control';
import type { SourceControlProvider } from './source-control';

type SourceIdentity = {
  provider: string;
  owner: string;
  repo: string;
};

export type SourceControlRepository = {
  owner: string;
  repo: string;
};

export type SourceControlRepositoryFilter = Partial<SourceControlRepository>;

export type SourceControlAdapter<
  TProvider extends SourceControlProviderDefinition = CloudflareArtifacts,
> = {
  readonly id: TProvider['id'];
  readonly repository: SourceControlRepositoryFilter;
  create(env: Bindings): SourceControlProvider<TProvider>;
  accepts(source: SourceIdentity): boolean;
  assertSource(source: SourceIdentity): void;
};

/**
 * Creates an Artifacts adapter with case-sensitive repository matching.
 * Omitted owner or repository fields match any value.
 */
export function cloudflareArtifacts(
  repository: SourceControlRepositoryFilter = {}
): SourceControlAdapter<CloudflareArtifacts> {
  return createAdapter(
    'cloudflare-artifacts',
    repository,
    (env) => new CloudflareArtifactsSourceControlProvider(env, repository),
    true
  );
}

function createAdapter<TProvider extends SourceControlProviderDefinition>(
  id: TProvider['id'],
  repository: SourceControlRepositoryFilter,
  create: (env: Bindings) => SourceControlProvider<TProvider>,
  caseSensitive: boolean
): SourceControlAdapter<TProvider> {
  const configuredRepository = { ...repository };
  const accepts = (source: SourceIdentity) =>
    source.provider === id &&
    matches(source.owner, configuredRepository.owner, caseSensitive) &&
    matches(source.repo, configuredRepository.repo, caseSensitive);

  return {
    id,
    repository: configuredRepository,
    create,
    accepts,
    assertSource(source) {
      if (!accepts(source)) {
        throw new Error(
          `Unsupported CI source: ${source.provider}:${source.owner}/${source.repo}`
        );
      }
    },
  };
}

function matches(
  value: string,
  configured: string | undefined,
  caseSensitive: boolean
) {
  return configured === undefined || equal(value, configured, caseSensitive);
}

function equal(left: string, right: string, caseSensitive: boolean) {
  return caseSensitive
    ? left === right
    : left.toLowerCase() === right.toLowerCase();
}
