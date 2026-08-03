# Cloudflare Artifacts Example

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tomashobza/ci/tree/main/examples/cloudflare-artifacts)

A deployable Cloudflare CI Worker using Cloudflare Artifacts as its source
provider. The pipeline is defined in [`cloudflare.ci.ts`](./cloudflare.ci.ts)
and imports its authoring API from `@cloudflare/ci`.

## Configure

During deployment, select the Artifacts namespace containing the repository to
build and provide both Cloudflare account IDs. If configuring the files
manually, update the namespace and repository in both
[`wrangler.jsonc`](./wrangler.jsonc) and
[`cloudflare.ci.ts`](./cloudflare.ci.ts). Keep `BACKUP_BUCKET_NAME` equal to the
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
