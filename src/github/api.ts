// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import {
  matchSourceControlTreeBlobs,
  type SourceControlTreeBlob,
} from '../source-control';

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

const commitSchema = z.object({
  tree: z.object({ sha: z.string().min(1) }),
});

const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      sha: z.string().min(1),
      type: z.enum(['blob', 'tree', 'commit']),
    })
  ),
});

/** Lists matching immutable blob hashes from a public GitHub commit tree. */
export async function listGitHubTreeBlobs(
  fetcher: typeof fetch,
  source: { owner: string; repo: string; sha: string },
  paths: string[]
): Promise<SourceControlTreeBlob[] | null> {
  const repository = `${segment(source.owner)}/${segment(source.repo)}`;
  const commit = await request(
    fetcher,
    `${GITHUB_API}/repos/${repository}/git/commits/${segment(source.sha)}`,
    commitSchema
  );
  const tree = await request(
    fetcher,
    `${GITHUB_API}/repos/${repository}/git/trees/${segment(commit.tree.sha)}?recursive=1`,
    treeSchema
  );
  if (tree.truncated) {
    return null;
  }
  return matchSourceControlTreeBlobs(
    tree.tree
      .filter((entry) => entry.type === 'blob')
      .map(({ path, sha }) => ({ path, sha })),
    paths
  );
}

async function request<TSchema extends z.ZodType>(
  fetcher: typeof fetch,
  url: string,
  schema: TSchema
): Promise<z.output<TSchema>> {
  const response = await fetcher(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'cloudflare-ci',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}): ${url}`);
  }
  return schema.parse(await response.json());
}

function segment(value: string) {
  return encodeURIComponent(value);
}
