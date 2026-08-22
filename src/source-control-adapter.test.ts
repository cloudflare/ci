import { describe, expect, it } from 'vitest';
import { cloudflareArtifacts, github } from './source-control-adapter';
import type { Bindings } from './env';

describe('source-control adapters', () => {
  it('configures a case-insensitive GitHub repository', () => {
    const adapter = github({ owner: 'Cloudflare', repo: 'Workers-SDK' });

    expect(
      adapter.accepts({
        provider: 'github',
        owner: 'cloudflare',
        repo: 'workers-sdk',
      })
    ).toBe(true);
    expect(
      adapter.accepts({
        provider: 'cloudflare-artifacts',
        owner: 'cloudflare',
        repo: 'workers-sdk',
      })
    ).toBe(false);
    expect(() => adapter.create({} as Bindings)).toThrow(
      'Missing GITHUB_WEBHOOK_SECRET'
    );
    expect(() =>
      adapter.create({ GITHUB_WEBHOOK_SECRET: 'secret' } as unknown as Bindings)
    ).not.toThrow();
  });

  it('configures a case-sensitive Artifacts repository', () => {
    const adapter = cloudflareArtifacts({ owner: 'Namespace', repo: 'Repo' });

    expect(
      adapter.accepts({
        provider: 'cloudflare-artifacts',
        owner: 'Namespace',
        repo: 'Repo',
      })
    ).toBe(true);
    expect(
      adapter.accepts({
        provider: 'cloudflare-artifacts',
        owner: 'Namespace',
        repo: 'repo',
      })
    ).toBe(false);
  });

  it('requires Artifacts-specific bindings only when creating the provider', () => {
    const adapter = cloudflareArtifacts();

    expect(() => adapter.create({} as Bindings)).toThrow(
      'Missing ARTIFACTS binding'
    );
    expect(() =>
      adapter.create({ ARTIFACTS: {} } as unknown as Bindings)
    ).toThrow('Missing CLOUDFLARE_ACCOUNT_ID binding');
    expect(() =>
      adapter.create({
        ARTIFACTS: {},
        CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      } as unknown as Bindings)
    ).not.toThrow();
  });

  it('accepts Artifacts event repository fields that are not configured', () => {
    const unfiltered = cloudflareArtifacts();
    const ownerFiltered = cloudflareArtifacts({ owner: 'Namespace' });

    expect(
      unfiltered.accepts({
        provider: 'cloudflare-artifacts',
        owner: 'AnyNamespace',
        repo: 'AnyRepo',
      })
    ).toBe(true);
    expect(
      ownerFiltered.accepts({
        provider: 'cloudflare-artifacts',
        owner: 'Namespace',
        repo: 'AnyRepo',
      })
    ).toBe(true);
    expect(
      ownerFiltered.accepts({
        provider: 'cloudflare-artifacts',
        owner: 'OtherNamespace',
        repo: 'AnyRepo',
      })
    ).toBe(false);
  });
});
