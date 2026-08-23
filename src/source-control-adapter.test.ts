import { describe, expect, it } from 'vitest';
import { cloudflareArtifacts, createAdapter } from './source-control-adapter';
import { SourceControlProvider } from './source-control';
import type { SourceControlProviderDefinition } from './pipeline/types';

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

  it('creates a non-Artifacts adapter for a custom provider id', () => {
    type CustomProvider = SourceControlProviderDefinition<'custom'>;
    class CustomSourceControl extends SourceControlProvider<CustomProvider> {
      receiveEvent() {
        return Promise.resolve(null);
      }
      getSourceCheckout() {
        return Promise.resolve({
          kind: 'archive' as const,
          url: 'https://example.test/archive',
        });
      }
      listTreeBlobs() {
        return Promise.resolve([]);
      }
      getStepCredentialEnv() {
        return Promise.resolve({});
      }
    }

    const adapter = createAdapter<CustomProvider>(
      'custom',
      { owner: 'acme', repo: 'widgets' },
      () => new CustomSourceControl(),
      true
    );

    expect(adapter.id).toBe('custom');
    expect(
      adapter.accepts({
        provider: 'custom',
        owner: 'acme',
        repo: 'widgets',
      })
    ).toBe(true);
    expect(
      adapter.accepts({
        provider: 'cloudflare-artifacts',
        owner: 'acme',
        repo: 'widgets',
      })
    ).toBe(false);
  });
});
