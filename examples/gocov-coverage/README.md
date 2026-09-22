# gocov Coverage Example

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/ci/tree/main/examples/gocov-coverage)

A deployable Cloudflare CI Worker that tests a Go repository and reports its
test coverage to [gocov](https://gocov.dev), using Cloudflare Artifacts as the
source provider. The pipeline is defined in
[`cloudflare.ci.ts`](./cloudflare.ci.ts): install dependencies, `go test` with
a coverage profile, then upload the profile with the gocov CLI. Because runner
steps are plain shell commands, any coverage uploader works the same way — this
example just wires one up end to end.

## Prerequisites

- A **Cloudflare Artifacts repository** populated with the Go source you want
  to build. The pipeline runs in response to pushes to that repository, so it
  never triggers until such a repository exists and receives a push.
- A **gocov upload token** for the repository (from the repo page on your gocov
  instance, or [app.gocov.dev](https://app.gocov.dev) for the hosted service).

## Configure

Point the example at your Artifacts repository, exactly as in the
[`cloudflare-artifacts`](../cloudflare-artifacts) example: set
`artifacts[].namespace`, `triggers.events[].filter.namespace` and
`triggers.events[].filter.repo_name` in [`wrangler.jsonc`](./wrangler.jsonc),
provide `CLOUDFLARE_ACCOUNT_ID`, and keep `BACKUP_BUCKET_NAME` equal to the
configured `BACKUP_BUCKET` name.

The deploy flow reads [`.dev.vars.example`](./.dev.vars.example) and prompts
for the secrets used by runners and Sandbox backups. To configure them
manually:

```sh
pnpm exec wrangler secret put CF_TOKEN
pnpm exec wrangler secret put R2_ACCESS_KEY_ID
pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY
pnpm exec wrangler secret put GOCOV_TOKEN
```

`GOCOV_TOKEN` is resolved by the `secrets` option of the coverage runner, so it
reaches only that step's command env — the install and test commands never see
it. When self-hosting gocov, also set the server URL on the upload command with
`-server https://gocov.example` (the default is the hosted service).

The [`Dockerfile`](./Dockerfile) extends the sandbox base image with a pinned
Go toolchain and keeps Go's module and build caches under `/workspace`, so the
cache-keyed install runner (`cache: { inputs: ['go.mod', 'go.sum'] }`) restores
them on later runs.

## What lands in gocov

Cloudflare Artifacts has no pull-request concept, so this pipeline reports
per-commit coverage only: totals, history and the badge. gocov features that
hang off a PR (PR comments, diff-coverage annotations) do not apply to this
event source. Repo, commit SHA and branch are taken from the
`cf.artifacts.repo.pushed` event and passed to the upload explicitly, since the
sandbox workspace contains no `.git` for the CLI to inspect.

## Commands

Run these from this directory:

```sh
pnpm build
pnpm dev
pnpm typecheck
pnpm cf-typegen
pnpm run deploy
```

`build` performs a Wrangler dry-run. Changes to `cloudflare.ci.ts` take effect
after the Worker is deployed.
