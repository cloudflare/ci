// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import cloudflare from '@cloudflare/oxlint-config';
import { defineConfig } from 'oxlint';

export default defineConfig({
  ...cloudflare,
  globals: { ...cloudflare.globals, WebSocketPair: 'readonly' },
  ignorePatterns: [
    ...(cloudflare.ignorePatterns ?? []),
    'examples/**',
    '**/dist/**',
    '**/.wrangler/**',
  ],
  rules: {
    ...cloudflare.rules,
    'no-await-in-loop': 'warn',
    'vitest/require-mock-type-parameters': 'off',
    // Temporarily disabled during migration.
    '@nkzw/no-instanceof': 'off',
    'no-console': 'off',
    'quality/no-chained-type-assertions': 'off',
    'quality/no-unknown-returns': 'off',
    'quality/no-unsafe-dictionary-type': 'off',
    'typescript/no-unsafe-return': 'off',
    'typescript/no-unsafe-type-assertion': 'off',
    'typescript/use-unknown-in-catch-callback-variable': 'off',
  },
});
