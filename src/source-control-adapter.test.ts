import { describe, expect, it } from 'vitest';
import { cloudflareArtifacts } from './source-control-adapter';

describe('source-control adapters', () => {
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
