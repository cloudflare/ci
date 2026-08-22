// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import type { CiParams, GitHub } from '../pipeline';
import type { SourceControlEventInput } from '../source-control';

const signaturePattern = /^sha256=([a-f\d]{64})$/i;
const ZERO_SHA = '0000000000000000000000000000000000000000';

const githubPushEventSchema = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  deleted: z.boolean().optional(),
  repository: z.object({
    name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
  head_commit: z
    .object({
      message: z.string(),
    })
    .nullable()
    .optional(),
  sender: z.object({ login: z.string() }),
  installation: z.object({ id: z.number().int().positive() }).optional(),
});

export type GitHubPushEvent = z.infer<typeof githubPushEventSchema>;

export class GitHubWebhookSignatureError extends Error {
  constructor() {
    super('Invalid GitHub webhook signature');
    this.name = 'GitHubWebhookSignatureError';
  }
}

/** Verifies the signature GitHub computed over the exact webhook body. */
export async function verifyGitHubWebhookSignature(
  { body, headers }: SourceControlEventInput,
  secret: string
): Promise<void> {
  const header = headers.get('x-hub-signature-256');
  const match = header?.match(signaturePattern);
  if (!match) {
    throw new GitHubWebhookSignatureError();
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    hexBytes(match[1]!),
    new TextEncoder().encode(body)
  );
  if (!valid) {
    throw new GitHubWebhookSignatureError();
  }
}

export function parseGitHubPushEvent(body: string): GitHubPushEvent {
  return githubPushEventSchema.parse(JSON.parse(body));
}

/** Maps a GitHub push webhook to the provider-neutral CI shape. */
export function mapGitHubPushEventToCiParams(
  event: GitHubPushEvent
): CiParams<GitHub> | null {
  const isBranch = event.ref.startsWith('refs/heads/');
  const isTag = event.ref.startsWith('refs/tags/');
  if (
    (!isBranch && !isTag) ||
    event.deleted === true ||
    event.after === ZERO_SHA
  ) {
    return null;
  }
  return {
    provider: 'github',
    providerData: event.installation
      ? { installationId: event.installation.id }
      : {},
    event: { type: isTag ? 'tag' : 'push' },
    owner: event.repository.owner.login,
    repo: event.repository.name,
    sha: event.after,
    remote: 'github',
    trigger: isTag ? 'tag' : 'push',
    ref: event.ref,
    branch: isBranch ? event.ref.slice('refs/heads/'.length) : undefined,
    tag: isTag ? event.ref.slice('refs/tags/'.length) : undefined,
    beforeSha: event.before,
    headCommitMessage: event.head_commit?.message,
    actor: event.sender.login,
  };
}

function hexBytes(value: string): ArrayBuffer {
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes.buffer;
}
