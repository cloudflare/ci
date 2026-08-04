# Cloudflare Artifacts Example

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/ci/tree/main/examples/cloudflare-artifacts)

A deployable Cloudflare CI Worker using Cloudflare Artifacts as its source
provider. The pipeline is defined in [`cloudflare.ci.ts`](./cloudflare.ci.ts)
and imports its authoring API from `@cloudflare/ci`.

## Prerequisites

This example does not create a source repository for you. Before deploying, you
must already have a **Cloudflare Artifacts repository** set up and populated with
the source you want to build. The pipeline runs in response to pushes to that
repository, so it will never trigger until such a repository exists and receives
a push.

## Configure

Point the example at your Artifacts repository. The placeholders below assume a
namespace of `cloudflare-ci-example` and a repository named `example-repository`
— replace them with your own everywhere they appear.

The repository this pipeline builds is scoped entirely by the trigger filter in
[`wrangler.jsonc`](./wrangler.jsonc):

- `artifacts[].namespace` — your Artifacts namespace.
- `triggers.events[].filter.namespace` — same namespace. This is what hooks the
  trigger to your repository; if it does not match, no pipeline ever starts.
- `triggers.events[].filter.repo_name` — your repository name. Same rule: a
  mismatch here means the trigger silently never fires.

Because the trigger already scopes the source, [`cloudflare.ci.ts`](./cloudflare.ci.ts)
does not pin a repository. If you also want to restrict the pipeline at the
application level, override `getProvider()` there to return
`cloudflareArtifacts({ owner, repo })`.

Also provide both Cloudflare account IDs (`CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_DEPLOY_ACCOUNT_ID`) and keep `BACKUP_BUCKET_NAME` equal to the
configured `BACKUP_BUCKET` name.

The top-level event trigger sends `cf.artifacts.repo.pushed` events directly to
the configured Workflow; no Queue is required.

The deploy flow reads [`.dev.vars.example`](./.dev.vars.example) and prompts for
the secrets used by runners and Sandbox backups. To configure them manually:

```sh
pnpm exec wrangler secret put CF_TOKEN
pnpm exec wrangler secret put R2_ACCESS_KEY_ID
pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY
```

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
