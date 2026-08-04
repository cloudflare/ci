// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  CiParams,
  CiSource,
  SourceControlProviderDefinition,
} from './pipeline';

export type SourceControlEventInput = {
  body: string;
  headers: Headers;
};

export type SourceControlSource = {
  owner: string;
  repo: string;
  sha: string;
  providerData: unknown;
};

export type SourceControlTreeBlob = { path: string; sha: string };

export function matchSourceControlTreeBlobs(
  tree: SourceControlTreeBlob[],
  patterns: string[]
): SourceControlTreeBlob[] {
  const regexps = patterns.map(globToRegExp);
  return tree.filter((entry) => regexps.some((re) => re.test(entry.path)));
}

// `*` matches within a path segment; `**` matches across segments.
function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        pattern += '(?:.*/)?';
        index += 2;
      } else {
        pattern += '.*';
        index++;
      }
    } else if (char === '*') {
      pattern += '[^/]*';
    } else {
      pattern += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
  }
  return new RegExp(`${pattern}$`);
}

export type SourceControlPushCredentials = {
  remote: string;
  token: string;
};

export type CreatePullRequestInput = {
  source: SourceControlSource;
  headBranch: string;
  headCommit: string;
  baseBranch: string;
  title: string;
  body: string;
};

export type CreatePullRequestResult =
  | { status: 'created'; url: string; number?: number }
  | { status: 'skipped' };

// The provider-native reporting payload. This is
// what a provider renders an outcome into; it is not what the engine produces.
export type StepNotificationOutput = {
  title: string;
  summary: string;
  text?: string;
};

// Provider-neutral facts about a finished runner. The engine reports these and
// each provider renders its own presentation (title/summary/text, markdown,
// etc.). Log and error text are already redacted by the engine — providers must
// never receive raw secrets.
export type StepOutcome = {
  cacheHit: boolean;
  command: string;
  durationMs: number;
  logs: { stdout: string; stderr: string };
  // Redacted failure message; present only on fail().
  error?: string;
};

export type StepNotificationInput = {
  source: SourceControlSource;
  instanceId: string;
  label: string;
  command: string;
};

export interface StepNotificationHandle {
  succeed(outcome: StepOutcome): Promise<void>;
  fail(outcome: StepOutcome): Promise<void>;
}

export interface StepNotifier {
  start(
    input: Pick<StepNotificationInput, 'label' | 'command'>
  ): Promise<StepNotificationHandle>;
}

// Providers select a checkout mechanism; the sandbox runner implements it.
export type SourceControlCheckout =
  | { kind: 'archive'; url: string }
  | {
      kind: 'git';
      remote: string;
      token: string;
      sha: string;
    };

export type SourceControlEvent<
  TProvider extends SourceControlProviderDefinition =
    SourceControlProviderDefinition,
> =
  | { type: 'run'; params: CiParams<TProvider> }
  | { type: 'rerun'; source: CiSource<TProvider> };

/**
 * Provider operations used by the pipeline engine.
 * Implementations may read remote source data, issue short-lived credentials,
 * publish runner status, and create review requests.
 */
export abstract class SourceControlProvider<
  TProvider extends SourceControlProviderDefinition =
    SourceControlProviderDefinition,
> {
  /** Parses an incoming webhook or queue event into a provider-neutral run. */
  abstract receiveEvent(
    event: SourceControlEventInput
  ): Promise<SourceControlEvent<TProvider> | null>;

  /** Returns the authenticated source checkout consumed by the Sandbox. */
  abstract getSourceCheckout(
    source: SourceControlSource
  ): Promise<SourceControlCheckout>;

  /**
   * Lists content hashes for source files matching the cache input paths.
   * Returns null when the provider cannot safely fingerprint the source.
   */
  abstract listTreeBlobs(
    source: SourceControlSource,
    paths: string[]
  ): Promise<SourceControlTreeBlob[] | null>;

  /** Returns provider credentials explicitly requested by a runner. */
  abstract getStepCredentialEnv(
    source: SourceControlSource
  ): Promise<Record<string, string>>;

  /** Returns credentials that can push a verified Fix Branch. */
  getPushCredentials(
    _source: SourceControlSource
  ): Promise<SourceControlPushCredentials> {
    return Promise.reject(
      new Error('Source-control provider does not support Fix Branch pushes')
    );
  }

  /** Creates a pull request for a pushed Fix Branch when supported. */
  createPullRequest(
    _input: CreatePullRequestInput
  ): Promise<CreatePullRequestResult> {
    return Promise.resolve({ status: 'skipped' });
  }

  /** Starts provider-native reporting for a runner. */
  startStepNotification(
    _input: StepNotificationInput
  ): Promise<StepNotificationHandle | null> {
    return Promise.resolve(null);
  }
}
