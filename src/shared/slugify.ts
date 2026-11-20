// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 48);
}
