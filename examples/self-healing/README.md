# Self-Healing Example

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/ci/tree/main/examples/self-healing)

A complete Cloudflare CI Worker that extends the basic Cloudflare Artifacts
pipeline with an application-owned Healing Agent. The agent implementation,
tools, safeguards, AI dependencies, and `CiRunFailedWithFix` error all live in
this example rather than in `@cloudflare/ci`.

The core package reports neutral runner diagnostics. `cloudflare.ci.ts` combines
those diagnostics with the Workflow event to create the local `HealFailure`
passed to the agent.

## Prerequisites

This example does not create a source repository for you. Before deploying, you
must already have a **Cloudflare Artifacts repository** set up and populated with
the source you want to build. The pipeline runs in response to pushes to that
repository, so it will never trigger until such a repository exists and receives
a push.

## Configure

Like the cloudflare-artifacts example, the repository this pipeline builds is
scoped by the trigger filter in [`wrangler.jsonc`](./wrangler.jsonc):

- `artifacts[].namespace` — your Artifacts namespace.
- `triggers.events[].filter.namespace` — same namespace. This is what hooks the
  trigger to your repository; if it does not match, no pipeline ever starts.
- `triggers.events[].filter.repo_name` — your repository name. Same rule: a
  mismatch here means the trigger silently never fires.

Also provide both Cloudflare account IDs (`CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_DEPLOY_ACCOUNT_ID`), and use resource names that do not overlap
another deployed example, particularly the Workflow, Worker, and backup bucket.

The deploy flow reads [`.dev.vars.example`](./.dev.vars.example) and prompts for
the runner and Sandbox backup secrets. To configure them manually:

```sh
pnpm exec wrangler secret put CF_TOKEN
pnpm exec wrangler secret put R2_ACCESS_KEY_ID
pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY
```

The `AI` binding and `HEALER` Durable Object are already declared in
`wrangler.jsonc`. Change `Healer.getModel()` in `cloudflare.ci.ts` to configure
the model used for Heal Attempts.

## Commands

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm dev
pnpm cf-typegen
pnpm deploy
```

A verified fix is pushed to a `ci-autofix/<run-id>` Fix Branch. The source run
still fails because its original revision remains broken.
