// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CloudflareArtifacts } from '../pipeline';
import type { SourceControlRepositoryFilter } from '../source-control-adapter';
import type { Bindings } from '../env';
import {
  matchSourceControlTreeBlobs,
  SourceControlProvider,
  type SourceControlEvent,
  type SourceControlEventInput,
  type SourceControlSource,
} from '../source-control';
import type { SourceControlTreeBlob } from '../source-control';
import {
  mapArtifactsPushEventToCiParams,
  parseArtifactsPushEvent,
} from './events';

const SOURCE_TOKEN_TTL_SECONDS = 60 * 60;

// The shipped @cloudflare/workers-types `ArtifactsRepo` does not yet declare
// the hash-addressed read methods, but the runtime binding exposes them. These
// mirror the git object reader: `readCommit` yields a commit (with its root
// tree hash) and `readTree` yields one level of entries carrying immutable blob
// hashes. Remove once the published types include them.
type ArtifactsTreeEntry = {
  name: string;
  mode: string;
  hash: string;
  type: 'blob' | 'tree' | 'commit';
};
type ArtifactsCommit = { treeHash: string };
type ArtifactsRepoReader = {
  readCommit(hash: string): Promise<ArtifactsCommit | null>;
  readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>;
};

export class CloudflareArtifactsSourceControlProvider extends SourceControlProvider<CloudflareArtifacts> {
  constructor(
    private readonly env: Pick<Bindings, 'ARTIFACTS' | 'CLOUDFLARE_ACCOUNT_ID'>,
    private readonly repository: SourceControlRepositoryFilter
  ) {
    super();
  }

  /**
   * Converts an Artifacts push into a pipeline event.
   * Ignores unmatched repositories and unsupported or deleted refs.
   */
  async receiveEvent({
    body,
  }: SourceControlEventInput): Promise<SourceControlEvent<CloudflareArtifacts> | null> {
    const event = parseArtifactsPushEvent(body);
    if (!event) {
      return null;
    }
    if (
      !this.matchesRepository(event.source.namespace, event.source.repoName)
    ) {
      return null;
    }
    const params = mapArtifactsPushEventToCiParams(event);
    if (!params) {
      return null;
    }
    return {
      type: 'run',
      params,
    };
  }

  /** Returns checkout data with a repository-scoped, one-hour read token. */
  async getSourceCheckout(source: SourceControlSource) {
    const { remote, token } = await this.getRepoAccess(source);
    return { kind: 'git' as const, remote, token, sha: source.sha };
  }

  /**
   * Walks the commit tree and returns matching immutable blob hashes. Returns
   * null when the untyped binding reads are unavailable so the runner can
   * safely bypass its cache.
   */
  async listTreeBlobs(
    source: SourceControlSource,
    paths: string[]
  ): Promise<SourceControlTreeBlob[] | null> {
    const namespace = this.assertNamespace(source);
    const repo = (await this.getRepo(
      namespace,
      source.repo
    )) as unknown as ArtifactsRepoReader;
    try {
      const commit = await repo.readCommit(source.sha);
      if (!commit) {
        throw new Error(`Artifacts commit not found: ${source.sha}`);
      }
      const tree = await this.walkTree(repo, commit.treeHash, '');
      return matchSourceControlTreeBlobs(tree, paths);
    } catch {
      return null;
    }
  }

  // Walk the complete tree before filtering so glob patterns such as
  // `packages/**` can match files at any depth.
  private async walkTree(
    repo: ArtifactsRepoReader,
    treeHash: string,
    prefix: string
  ): Promise<SourceControlTreeBlob[]> {
    const entries = await repo.readTree(treeHash);
    if (!entries) {
      throw new Error(
        `Artifacts tree not found: ${treeHash} at ${prefix || '/'}`
      );
    }
    const blobs: SourceControlTreeBlob[] = [];
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === 'tree') {
        blobs.push(...(await this.walkTree(repo, entry.hash, path)));
      } else if (entry.type === 'blob') {
        blobs.push({ path, sha: entry.hash });
      }
    }
    return blobs;
  }

  /** Issues a one-hour read token as Artifacts command environment variables. */
  async getStepCredentialEnv(source: SourceControlSource) {
    const { remote, token } = await this.getRepoAccess(source);
    return { ARTIFACTS_REMOTE: remote, ARTIFACTS_TOKEN: token };
  }

  /** Returns a repository-scoped, one-hour write token. */
  getPushCredentials(source: SourceControlSource) {
    return this.getRepoAccess(source, 'write');
  }

  private async getRepoAccess(
    source: SourceControlSource,
    scope: 'read' | 'write' = 'read'
  ) {
    const namespace = this.assertNamespace(source);
    const repo = await this.getRepo(namespace, source.repo);
    const token = await repo.createToken(scope, SOURCE_TOKEN_TTL_SECONDS);
    return {
      remote: this.repoRemote(namespace, source.repo),
      token: token.plaintext,
    };
  }

  private assertNamespace(source: SourceControlSource) {
    const namespace = parseProviderData(source.providerData).namespace;
    if (namespace !== source.owner) {
      throw new Error(`Unsupported Artifacts namespace: ${namespace}`);
    }
    this.assertRepository(namespace, source.repo);
    return namespace;
  }

  private async getRepo(namespace: string, repo: string) {
    this.assertRepository(namespace, repo);
    return this.env.ARTIFACTS.get(repo);
  }

  private repoRemote(namespace: string, repo: string) {
    if (!/^[a-f\d]{32}$/i.test(this.env.CLOUDFLARE_ACCOUNT_ID)) {
      throw new Error('Invalid Cloudflare account ID');
    }
    return `https://${this.env.CLOUDFLARE_ACCOUNT_ID}.artifacts.cloudflare.net/git/${namespace}/${repo}.git`;
  }

  private assertRepository(owner: string, repo: string) {
    if (!this.matchesRepository(owner, repo)) {
      throw new Error(`Unsupported Artifacts repository: ${owner}/${repo}`);
    }
  }

  private matchesRepository(owner: string, repo: string) {
    return (
      (this.repository.owner === undefined ||
        owner === this.repository.owner) &&
      (this.repository.repo === undefined || repo === this.repository.repo)
    );
  }
}

function parseProviderData(
  value: unknown
): CloudflareArtifacts['providerData'] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('namespace' in value) ||
    typeof value.namespace !== 'string'
  ) {
    throw new Error('Missing Artifacts namespace');
  }
  return { namespace: value.namespace };
}
