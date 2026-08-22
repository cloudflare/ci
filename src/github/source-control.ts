// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { GitHub } from '../pipeline';
import type { SourceControlRepositoryFilter } from '../source-control-adapter';
import {
  SourceControlProvider,
  type SourceControlEvent,
  type SourceControlEventInput,
  type SourceControlSource,
  type SourceControlTreeBlob,
} from '../source-control';
import {
  mapGitHubPushEventToCiParams,
  parseGitHubPushEvent,
  verifyGitHubWebhookSignature,
} from './events';

/**
 * Public, read-only GitHub source provider. Unavailable source fingerprints
 * safely bypass the runner cache.
 */
export class GitHubSourceControlProvider extends SourceControlProvider<GitHub> {
  constructor(
    private readonly webhookSecret: string,
    private readonly repository: SourceControlRepositoryFilter
  ) {
    super();
  }

  async receiveEvent(
    event: SourceControlEventInput
  ): Promise<SourceControlEvent<GitHub> | null> {
    await verifyGitHubWebhookSignature(event, this.webhookSecret);
    if (event.headers.get('x-github-event') !== 'push') {
      return null;
    }
    const push = parseGitHubPushEvent(event.body);
    if (
      !matches(push.repository.owner.login, this.repository.owner) ||
      !matches(push.repository.name, this.repository.repo)
    ) {
      return null;
    }
    const params = mapGitHubPushEventToCiParams(push);
    return params ? { type: 'run', params } : null;
  }

  async getSourceCheckout(source: SourceControlSource) {
    this.assertRepository(source.owner, source.repo);
    const owner = encodeURIComponent(source.owner);
    const repo = encodeURIComponent(source.repo);
    const sha = encodeURIComponent(source.sha);
    return {
      kind: 'archive' as const,
      url: `https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`,
    };
  }

  async listTreeBlobs(
    source: SourceControlSource,
    _paths: string[]
  ): Promise<SourceControlTreeBlob[] | null> {
    this.assertRepository(source.owner, source.repo);
    return null;
  }

  async getStepCredentialEnv(source: SourceControlSource) {
    this.assertRepository(source.owner, source.repo);
    return {};
  }

  private assertRepository(owner: string, repo: string) {
    if (
      !matches(owner, this.repository.owner) ||
      !matches(repo, this.repository.repo)
    ) {
      throw new Error(`Unsupported GitHub repository: ${owner}/${repo}`);
    }
  }
}

function matches(value: string, configured: string | undefined) {
  return (
    configured === undefined || value.toLowerCase() === configured.toLowerCase()
  );
}
