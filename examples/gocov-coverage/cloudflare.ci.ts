import { CIWorkflow } from '@cloudflare/ci';
import type { CiContext, CiParams, CloudflareArtifacts } from '@cloudflare/ci';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Bindings } from './env';

// A Go pipeline that reports test coverage to gocov (https://gocov.dev):
// install dependencies, run the tests with a coverage profile, upload the
// profile with the gocov CLI. The workspace is copied in without `.git` and
// gocov has no auto-detection for Cloudflare CI, so repo, commit and branch
// are passed to the upload explicitly from the pipeline event.
export class CI extends CIWorkflow<CloudflareArtifacts, Bindings> {
  protected async pipeline(
    event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    _step: WorkflowStep,
    ci: CiContext
  ): Promise<void> {
    const { owner, repo, sha, branch } = event.payload;

    // The Dockerfile keeps GOMODCACHE and GOCACHE under /workspace, so the
    // cache-keyed install snapshot carries the module cache into later runs.
    const deps = await ci.runner({
      name: 'install',
      command: 'go mod download',
      cache: { inputs: ['go.mod', 'go.sum'] },
    });

    const tested = await deps.runner({
      name: 'test',
      command: 'go test ./... -covermode=atomic -coverprofile=cover.out',
    });

    // GOCOV_TOKEN is a Worker secret; `secrets` injects it into this step's
    // command env only, so the install and test commands never see it. The
    // remaining values travel through `env` rather than string interpolation
    // so a branch name can never be interpreted by the shell.
    await tested.runner({
      name: 'coverage',
      command:
        'go run github.com/gocov/gocov/cmd/gocov@v0.11.0 upload' +
        ' -repo "$UPLOAD_REPO" -commit "$UPLOAD_COMMIT" -branch "$UPLOAD_BRANCH" cover.out',
      env: {
        UPLOAD_REPO: `${owner}/${repo}`,
        UPLOAD_COMMIT: sha,
        UPLOAD_BRANCH: branch ?? '',
      },
      secrets: ['GOCOV_TOKEN'],
    });
  }
}
