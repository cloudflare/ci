// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SourceControlCheckout } from '../source-control';
import { shellQuote } from './shell';

const CLONE_DIR = '/tmp/ci-source';

/**
 * Builds a shell script that copies source into the workspace.
 * The default mode clears the workspace first. Overlay mode overwrites matching
 * paths but leaves other existing files. Git checkouts read credentials from
 * `SOURCE_CONTROL_TOKEN`.
 */
export function checkoutSourceScript(
  source: SourceControlCheckout,
  workspace: string,
  overlay = false
) {
  const prepare = overlay
    ? `mkdir -p ${shellQuote(workspace)}`
    : `rm -rf ${shellQuote(workspace)} && mkdir -p ${shellQuote(workspace)}`;
  if (source.kind === 'archive') {
    return `${prepare} && curl --connect-timeout 10 --max-time 300 --fail --silent --show-error --location ${shellQuote(source.url)} | tar -xz --strip-components=1 -C ${shellQuote(workspace)}`;
  }
  return [
    prepare,
    `rm -rf ${shellQuote(CLONE_DIR)}`,
    `git init -q ${shellQuote(CLONE_DIR)}`,
    `git -C ${shellQuote(CLONE_DIR)} remote add origin ${shellQuote(source.remote)}`,
    `git -c http.extraHeader="Authorization: Bearer $SOURCE_CONTROL_TOKEN" -C ${shellQuote(CLONE_DIR)} fetch --depth=1 origin ${shellQuote(source.sha)}`,
    `git -C ${shellQuote(CLONE_DIR)} checkout --detach FETCH_HEAD`,
    `tar --exclude=.git -C ${shellQuote(CLONE_DIR)} -cf - . | tar -C ${shellQuote(workspace)} -xf -`,
  ].join(' && ');
}

export function checkoutSourceEnv(source: SourceControlCheckout) {
  return source.kind === 'git'
    ? { SOURCE_CONTROL_TOKEN: source.token }
    : undefined;
}
