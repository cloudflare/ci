import type { SourceControlPushCredentials } from '@cloudflare/ci/worker';
import { shellQuote, slugify } from './utils';
import type { HealingSandbox } from './tools';

const WORKSPACE_DIR = '/workspace';
const PUSH_TIMEOUT_MS = 2 * 60 * 1000;

const PROTECTED_FILES = new Set([
  'bun.lock',
  'cloudflare.ci.ts',
  'Dockerfile',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

export type PushFixBranchInput = {
  runId: string;
  baseSha: string;
  credentials: SourceControlPushCredentials;
};

export type PushFixBranchResult =
  | { status: 'pushed'; branch: string; commit: string }
  | { status: 'no_changes' };

export async function inspectHealingChanges(sandbox: HealingSandbox) {
  const result = await sandbox.exec(
    'git diff --name-only --no-renames -z HEAD && git ls-files --others --exclude-standard -z',
    { cwd: WORKSPACE_DIR }
  );
  assertSuccess(result, 'inspect healing diff');
  const paths = [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
  return {
    paths,
    protectedPaths: paths.filter(isProtectedPath),
  };
}

export async function pushFixBranch(
  sandbox: HealingSandbox,
  { runId, baseSha, credentials }: PushFixBranchInput
): Promise<PushFixBranchResult> {
  const status = await sandbox.exec('git status --porcelain', {
    cwd: WORKSPACE_DIR,
  });
  assertSuccess(status, 'inspect healing changes');
  if (!status.stdout.trim()) {
    return { status: 'no_changes' };
  }

  const base = await sandbox.exec('git rev-parse HEAD', { cwd: WORKSPACE_DIR });
  assertSuccess(base, 'read Fix Branch base revision');
  if (base.stdout.trim() !== baseSha) {
    throw new Error(
      `Refusing to push Fix Branch from unexpected base ${base.stdout.trim()}`
    );
  }

  const id = slugify(runId).slice(0, 80) || 'run';
  const branch = `ci-autofix/${id}`;
  const branchRef = `refs/heads/${branch}`;
  const commitSubject = `fix: heal CI run ${runId} [skip ci]`;
  const command = [
    `git config user.name ${shellQuote('Cloudflare CI Healing Agent')}`,
    `git config user.email ${shellQuote('ci-healing@cloudflare.com')}`,
    `git checkout -B ${shellQuote(branch)}`,
    'git add -A',
    `git -c core.hooksPath=/dev/null commit -m ${shellQuote(commitSubject)}`,
    `REMOTE_COMMIT=$(git -c http.extraHeader="Authorization: Bearer $SOURCE_CONTROL_TOKEN" ls-remote --heads ${shellQuote(credentials.remote)} ${shellQuote(branchRef)} | cut -f1)`,
    `if [ -n "$REMOTE_COMMIT" ]; then git -c http.extraHeader="Authorization: Bearer $SOURCE_CONTROL_TOKEN" fetch --depth=2 ${shellQuote(credentials.remote)} "$REMOTE_COMMIT" && test "$(git rev-parse FETCH_HEAD^)" = ${shellQuote(baseSha)} && test "$(git show -s --format=%ae FETCH_HEAD)" = ${shellQuote('ci-healing@cloudflare.com')} && test "$(git show -s --format=%s FETCH_HEAD)" = ${shellQuote(commitSubject)}; fi`,
    `git -c core.hooksPath=/dev/null -c http.extraHeader="Authorization: Bearer $SOURCE_CONTROL_TOKEN" push --force-with-lease=${shellQuote(`${branchRef}:`)}$REMOTE_COMMIT ${shellQuote(credentials.remote)} HEAD:${shellQuote(branchRef)}`,
  ].join(' && ');
  const pushed = await sandbox.exec(command, {
    cwd: WORKSPACE_DIR,
    timeout: PUSH_TIMEOUT_MS,
    env: { SOURCE_CONTROL_TOKEN: credentials.token },
  });
  assertSuccess(pushed, `push Fix Branch ${branch}`);

  const revision = await sandbox.exec('git rev-parse HEAD HEAD^', {
    cwd: WORKSPACE_DIR,
  });
  assertSuccess(revision, 'read Fix Branch revision');
  const [commit, parent] = revision.stdout.trim().split('\n');
  if (!commit || parent !== baseSha) {
    throw new Error('Fix Branch commit is not based on the source revision');
  }
  return { status: 'pushed', branch, commit };
}

function assertSuccess(
  result: { exitCode: number; stdout: string; stderr: string },
  action: string
) {
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to ${action} (exit ${result.exitCode})\n${result.stderr || result.stdout}`
    );
  }
}

function isProtectedPath(path: string) {
  const segments = path.split('/');
  const file = segments.at(-1)!;
  return (
    PROTECTED_FILES.has(path) ||
    PROTECTED_FILES.has(file) ||
    segments.some((segment) =>
      [
        '.circleci',
        '.github',
        '.gitlab',
        '__tests__',
        'test',
        'tests',
      ].includes(segment)
    ) ||
    /\.(spec|test)\.[^.]+$/.test(file) ||
    /^(jest|vitest)\.config\./.test(file) ||
    /^(tsconfig(?:\..+)?\.json|wrangler\.(?:jsonc?|toml)|bunfig\.toml)$/.test(
      file
    ) ||
    /^(?:\.oxlintrc|oxlint\.config|eslint\.config)(?:\..+)?$/.test(file)
  );
}
