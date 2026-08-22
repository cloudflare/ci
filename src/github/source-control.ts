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

/**
 * Public, read-only GitHub source provider foundation. Webhook handling and
 * source fingerprinting are added separately; unavailable fingerprints safely
 * bypass the runner cache.
 */
export class GitHubSourceControlProvider extends SourceControlProvider<GitHub> {
  constructor(private readonly repository: SourceControlRepositoryFilter) {
    super();
  }

  async receiveEvent(
    _event: SourceControlEventInput
  ): Promise<SourceControlEvent<GitHub> | null> {
    return null;
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
