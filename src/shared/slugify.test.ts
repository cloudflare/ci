import { describe, expect, it } from 'vitest';
import { slugify } from './slugify';

describe('workspace snapshot helpers', () => {
  it('slugifies values for storage keys and names', () => {
    expect(slugify('Feature/CI CD Worker PoC')).toBe(
      'feature-ci-cd-worker-poc'
    );
  });
});
