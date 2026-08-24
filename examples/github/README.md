# GitHub Example

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/ci/tree/github/examples/github)

A deployable Cloudflare CI Worker that starts durable Workflows from signed
GitHub repository webhooks. The pipeline is defined in
[`cloudflare.ci.ts`](./cloudflare.ci.ts). For coding-agent-driven setup and
verification, follow [`AGENTS.md`](./AGENTS.md).

## Current scope

This proof of concept supports branch and tag pushes from public GitHub
repositories. Source archives and cache fingerprints are read without a GitHub
access token. Private repositories, GitHub Checks, pull requests, and
self-healing write access are not included yet.

The example pins `@cloudflare/ci` to the proof-of-concept commit on GitHub so
the example remains isolated when Deploy to Cloudflare extracts this
subdirectory. Before enabling a webhook, tailor the package-manager commands
and cache inputs in `cloudflare.ci.ts` to the target repository.

## Configure Cloudflare

Keep `BACKUP_BUCKET_NAME` in [`wrangler.jsonc`](./wrangler.jsonc) equal to the
configured `BACKUP_BUCKET` bucket name. Create that R2 bucket before deploying
if it does not already exist.

Copy [`.dev.vars.example`](./.dev.vars.example) to `.dev.vars` for local
development. For a deployed Worker, configure the secrets directly:

```sh
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
pnpm exec wrangler secret put CLOUDFLARE_ACCOUNT_ID
pnpm exec wrangler secret put CLOUDFLARE_DEPLOY_ACCOUNT_ID
pnpm exec wrangler secret put CLOUDFLARE_DEPLOY_API_TOKEN
pnpm exec wrangler secret put R2_ACCESS_KEY_ID
pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY
```

Use a new random value for `GITHUB_WEBHOOK_SECRET`; it authenticates webhook
deliveries but does not grant repository access. Set
`CLOUDFLARE_ACCOUNT_ID` to the account where CI and its backup bucket run. Set
`CLOUDFLARE_DEPLOY_ACCOUNT_ID` and `CLOUDFLARE_DEPLOY_API_TOKEN` for the account
where successful pipeline builds should deploy.

## Check Cloudflare Access

The webhook endpoint must be reachable by GitHub. An unsigned `POST` should
reach the Worker and return `401`. If Access intercepts it, follow the
Service Auth instructions in [`AGENTS.md`](./AGENTS.md); do not create a Bypass
or Everyone policy.

## Configure GitHub

After deploying the Worker, add a repository webhook under **Settings →
Webhooks**:

- **Payload URL:** `https://<worker-host>/webhooks/github`
- **Content type:** `application/json`
- **Secret:** the same value configured as `GITHUB_WEBHOOK_SECRET`
- **Events:** push events only

The repository webhook scopes which repository can trigger this example. If the
same secret may be used by more than one repository, additionally restrict the
adapter in [`cloudflare.ci.ts`](./cloudflare.ci.ts):

```ts
export const sourceControl = github({
  owner: 'your-github-owner',
  repo: 'your-github-repository',
});
```

The endpoint returns `202` for a dispatched or duplicate commit, `204` for a
signed event it ignores, `401` for an invalid signature, and `400` for an
invalid push payload.

## Commands

Run these from this directory:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm dev
pnpm run deploy
```

`build` performs a Wrangler dry-run. Changes to `cloudflare.ci.ts` take effect
after the Worker is deployed.
