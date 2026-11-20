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
  overrides: [
    ...cloudflare.overrides,
    {
      // These Worker paths emit cache, runner, and notification diagnostics.
      files: [
        'src/ci/cache.ts',
        'src/ci/capabilities.ts',
        'src/ci/runners/sandbox.ts',
        'src/ci/step-notification.ts',
      ],
      rules: { 'no-console': 'off' },
    },
    {
      // Configured secret names can vary per deployment. They are narrowed at each read.
      files: ['src/env.ts'],
      rules: { 'quality/no-unsafe-dictionary-type': 'off' },
    },
  ],
  rules: {
    ...cloudflare.rules,
    'no-await-in-loop': 'warn',
    'vitest/require-mock-type-parameters': 'off',
  },
});
