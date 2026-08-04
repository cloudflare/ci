import { describe, expect, it } from 'vitest';
import { checkoutSourceEnv, checkoutSourceScript } from './source-checkout';

describe('checkoutSourceScript', () => {
  it('passes Git credentials through the command environment', () => {
    const source = {
      kind: 'git' as const,
      remote: 'https://account.artifacts.cloudflare.net/git/default/repo.git',
      token: 'secret-token',
      sha: 'abc123',
    };

    const script = checkoutSourceScript(source, '/workspace');

    expect(script).toContain('$SOURCE_CONTROL_TOKEN');
    expect(script).toContain("fetch --depth=1 origin 'abc123'");
    expect(script).toContain('checkout --detach FETCH_HEAD');
    expect(script).not.toContain(source.token);
    expect(checkoutSourceEnv(source)).toEqual({
      SOURCE_CONTROL_TOKEN: source.token,
    });
  });

  it('keeps archive checkouts on the existing tar path', () => {
    const source = { kind: 'archive' as const, url: 'https://ci.test/source' };

    expect(checkoutSourceScript(source, '/workspace')).toContain(
      'tar -xz --strip-components=1'
    );
    expect(checkoutSourceEnv(source)).toBeUndefined();
  });
});
