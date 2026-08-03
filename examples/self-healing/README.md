# Self-Healing Example

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/PLACEHOLDER_ORG/PLACEHOLDER_REPO/tree/main/examples/self-healing)

> TODO: Replace the placeholder repository URL when the public mirror is
> available.

A complete Cloudflare CI Worker that extends the basic Cloudflare Artifacts
pipeline with an application-owned Healing Agent. The agent implementation,
tools, safeguards, AI dependencies, and `CiRunFailedWithFix` error all live in
this example rather than in `@cloudflare/ci`.

The core package reports neutral runner diagnostics. `cloudflare.ci.ts` combines
those diagnostics with the Workflow event to create the local `HealFailure`
passed to the agent.

## Configure

During deployment, select the Artifacts namespace containing the repository to
build and provide both Cloudflare account IDs. If configuring the files
manually, update the namespace in `wrangler.jsonc`. Use resource names that do
not overlap another deployed example, particularly the Artifacts event queue,
Workflow, Worker, and backup bucket.

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
