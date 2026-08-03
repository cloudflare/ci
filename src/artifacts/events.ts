// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import type {
  CiParams,
  CloudflareArtifacts,
  CloudflareArtifactsPushEvent,
} from '../pipeline/types';

const commitSchema = z.object({
  id: z.string(),
  message: z.string(),
  author: z.object({ name: z.string(), email: z.string() }),
});

const artifactsPushEventSchema = z.object({
  id: z.string().optional(),
  type: z.literal('cf.artifacts.repo.pushed'),
  source: z.object({
    type: z.literal('artifacts.repo').optional(),
    namespace: z.string(),
    repoName: z.string(),
  }),
  payload: z.object({
    ref: z.string(),
    before: z.string(),
    after: z.string(),
    commits: z.array(commitSchema),
  }),
});

/**
 * Parses an Artifacts repository push event.
 * Returns null for another event type and throws for malformed input.
 */
export function parseArtifactsPushEvent(body: string) {
  const value: unknown = JSON.parse(body);
  if (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type !== 'cf.artifacts.repo.pushed'
  ) {
    return null;
  }
  return artifactsPushEventSchema.parse(value);
}

const ZERO_SHA = '0000000000000000000000000000000000000000';

/** Maps a direct Artifacts trigger payload to the provider-neutral CI shape. */
export function mapArtifactsPushEventToCiParams(
  event: CloudflareArtifactsPushEvent
): CiParams<CloudflareArtifacts> | null {
  const isBranch = event.payload.ref.startsWith('refs/heads/');
  const isTag = event.payload.ref.startsWith('refs/tags/');
  if (!isBranch && !isTag) {
    return null;
  }
  const commit = event.payload.commits.at(-1);
  if (event.payload.after === ZERO_SHA) {
    return null;
  }
  const branch = isBranch
    ? event.payload.ref.slice('refs/heads/'.length)
    : undefined;
  return {
    provider: 'cloudflare-artifacts',
    providerData: { namespace: event.source.namespace },
    event: { type: isTag ? 'tag' : 'push' },
    owner: event.source.namespace,
    repo: event.source.repoName,
    sha: event.payload.after,
    remote: 'cloudflare',
    trigger: isTag ? 'tag' : 'push',
    ref: event.payload.ref,
    branch,
    tag: isTag ? event.payload.ref.slice('refs/tags/'.length) : undefined,
    beforeSha: event.payload.before,
    headCommitMessage: commit?.message,
    actor: commit?.author.name,
  };
}
