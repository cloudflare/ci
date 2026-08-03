// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Sandbox } from '@cloudflare/sandbox';
import type { Bindings } from '../env';

export class CiSandbox extends Sandbox<Bindings> {}
