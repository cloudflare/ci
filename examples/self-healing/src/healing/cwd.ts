import { posix } from 'node:path';

export function resolveHealingCwd(cwd: string | undefined) {
  if (!cwd || cwd === '.' || cwd === './') {
    return '/workspace';
  }
  const normalized = posix.normalize(cwd);
  if (
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`cwd must be inside /workspace: ${cwd}`);
  }
  return `/workspace/${normalized}`;
}
