import { Think, type TurnConfig } from '@cloudflare/think';
import { tool, type ToolSet } from 'ai';
import { type DirectoryBackup } from '@cloudflare/ci/worker';
import {
  cloudflareArtifacts,
  type SourceControlAdapter,
} from '@cloudflare/ci/worker/source-control';
import type { Bindings } from '../../env';
import { resolveHealingCwd } from './cwd';
import { inspectHealingChanges, pushFixBranch } from './push';
import {
  checkpointHealingSandbox,
  openHealingSandbox,
  openPushSandbox,
} from './sandbox';
import { sandboxTools, type HealingSandbox } from './tools';
import type { HealInput, HealResult, VerificationCommand } from './types';

const MAX_CHANGED_PATHS = 100;
const PIPELINE_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const VERIFY_OUTPUT_LIMIT = 20_000;
const DEFAULT_PROVIDER = cloudflareArtifacts();

const INSTRUCTIONS = `You are fixing failed CI commands in an isolated repository workspace.
Diagnose every failure, inspect the source, make the smallest correct change, and use the available tools to validate your work.
Never delete, skip, weaken, or comment out tests merely to make the command pass.
Do not edit tests, CI configuration, lockfiles, or package scripts that define the verification command.
The exec, edit_file, and write_file tools automatically run every originally failed CI command after changing the workspace. Prefer edit_file for small changes. Stop only when all verification commands pass.`;

type ActiveSandbox = HealingSandbox & {
  createBackup(options: {
    dir: string;
    name: string;
    multipart: boolean;
    ttl: number;
  }): Promise<DirectoryBackup>;
  destroy(): Promise<unknown>;
};

export class HealingAgent extends Think<Bindings> {
  maxSteps = 25;

  private sandbox: ActiveSandbox | undefined;
  private failedCommands: VerificationCommand[] = [];
  private steps = 0;
  private healing = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  override getSystemPrompt() {
    return INSTRUCTIONS;
  }

  override getTools(): ToolSet {
    if (!this.sandbox || this.failedCommands.length === 0) {
      return {};
    }

    const tools = sandboxTools(this.sandbox);
    return Object.fromEntries(
      Object.entries(tools).map(([name, sandboxTool]) => [
        name,
        tool({
          description: sandboxTool.description,
          inputSchema: sandboxTool.inputSchema,
          execute: async (input) => {
            if (!sandboxTool.mutatesWorkspace) {
              return sandboxTool.execute(input);
            }
            return this.serializeMutation(async () => {
              const result = await sandboxTool.execute(input);
              const verification = await verifyCommands(
                this.sandbox!,
                this.failedCommands
              );
              return {
                result,
                verification,
                allPassed: verification.every((check) => check.exitCode === 0),
              };
            });
          },
        }),
      ])
    );
  }

  override beforeTurn(): TurnConfig {
    return {
      activeTools: [
        'read_file',
        'edit_file',
        'write_file',
        'grep',
        'find_files',
        'exec',
      ],
      maxSteps: this.maxSteps,
    };
  }

  override onStepFinish() {
    this.steps += 1;
  }

  protected getProvider(): SourceControlAdapter {
    return DEFAULT_PROVIDER;
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async heal({ failure, prompt }: HealInput): Promise<HealResult> {
    if (this.healing) {
      throw new Error(`Heal Attempt ${failure.runId} is already running`);
    }
    this.healing = true;
    this.steps = 0;

    try {
      return await this.runHeal(failure, prompt);
    } finally {
      this.healing = false;
      this.sandbox = undefined;
      this.failedCommands = [];
    }
  }

  private async runHeal(
    failure: HealInput['failure'],
    prompt: string | undefined
  ): Promise<HealResult> {
    const sourceControl = this.getProvider().create(this.env);
    const checkout = await sourceControl.getSourceCheckout(failure.source);
    const sandbox = (await openHealingSandbox(this.env, {
      id: failure.runId,
      source: checkout,
      snapshot: failure.snapshot,
    })) as ActiveSandbox;
    this.sandbox = sandbox;
    this.failedCommands = uniqueCommands(
      failure.failures.map(({ runner }) => runner)
    );

    let verifiedWorkspace: DirectoryBackup;
    try {
      const turn = await this.saveMessages([
        {
          id: crypto.randomUUID(),
          role: 'user',
          parts: [
            {
              type: 'text',
              text: healingPrompt(failure, prompt),
            },
          ],
        },
      ]);
      if (turn.status !== 'completed') {
        throw new Error(
          `Healing Agent turn ${turn.status}${turn.error ? `: ${turn.error}` : ''}`
        );
      }

      for (const command of uniqueCommands(failure.verificationCommands)) {
        // eslint-disable-next-line no-await-in-loop -- Commands share one workspace and must not overlap.
        const result = await verify(sandbox, command);
        if (result.exitCode !== 0) {
          throw new Error(
            `Heal Attempt failed pipeline verification ${command.command}${verificationOutput(result)}`
          );
        }
      }

      verifiedWorkspace = await checkpointHealingSandbox(sandbox);
    } finally {
      await sandbox.destroy().catch((error) => {
        console.error('Failed to destroy healing sandbox', { error });
      });
      this.sandbox = undefined;
    }

    const freshCheckout = await sourceControl.getSourceCheckout(failure.source);
    const pushSandbox = await openPushSandbox(this.env, {
      id: failure.runId,
      source: freshCheckout,
      snapshot: verifiedWorkspace,
    });
    try {
      const changes = await inspectHealingChanges(pushSandbox);
      if (changes.paths.length > MAX_CHANGED_PATHS) {
        throw new Error(
          `Heal Attempt changed ${changes.paths.length} paths; limit is ${MAX_CHANGED_PATHS}`
        );
      }
      if (changes.protectedPaths.length > 0) {
        throw new Error(
          `Heal Attempt changed protected paths:\n${changes.protectedPaths.join('\n')}`
        );
      }

      const credentials = await sourceControl.getPushCredentials(
        failure.source
      );
      const pushed = await pushFixBranch(pushSandbox, {
        runId: failure.runId,
        baseSha: failure.source.sha,
        credentials,
      });
      if (pushed.status === 'no_changes') {
        throw new Error(
          'Heal Attempt passed verification without source changes'
        );
      }

      const pullRequest = await sourceControl.createPullRequest({
        source: failure.source,
        headBranch: pushed.branch,
        headCommit: pushed.commit,
        baseBranch: failure.baseBranch,
        title: `Fix ${failure.failures.length} CI ${failure.failures.length === 1 ? 'failure' : 'failures'}`,
        body: [
          'This automated fix makes the following CI commands pass:',
          ...failure.failures.map(({ runner }) => `- \`${runner.command}\``),
          '',
          `Source commit: \`${failure.source.sha}\``,
          `Fix commit: \`${pushed.commit}\``,
        ].join('\n'),
      });
      return {
        branch: pushed.branch,
        commit: pushed.commit,
        steps: this.steps,
        pullRequest,
      };
    } finally {
      await pushSandbox.destroy().catch((error) => {
        console.error('Failed to destroy push sandbox', { error });
      });
    }
  }
}

function healingPrompt(failure: HealInput['failure'], prompt?: string) {
  return [
    'The following CI commands failed:',
    ...failure.failures.flatMap(({ runner, output }, index) => [
      '',
      `${index + 1}. \`${runner.command}\`${runner.cwd ? ` in \`${runner.cwd}\`` : ''}`,
      '```log',
      output,
      '```',
    ]),
    ...(prompt
      ? ['Additional guidance from the pipeline author:', prompt]
      : []),
    'Fix the code and validate every failure using the Sandbox tools.',
  ].join('\n');
}

async function verifyCommands(
  sandbox: HealingSandbox,
  commands: VerificationCommand[]
) {
  const results = [];
  for (const command of commands) {
    // eslint-disable-next-line no-await-in-loop -- Commands share one workspace and must not overlap.
    const result = await verify(sandbox, command);
    results.push({ ...command, ...boundedVerification(result) });
  }
  return results;
}

function uniqueCommands(commands: VerificationCommand[]) {
  return commands.filter(
    (command, index) =>
      commands.findIndex(
        (candidate) =>
          candidate.command === command.command && candidate.cwd === command.cwd
      ) === index
  );
}

function verify(sandbox: HealingSandbox, command: VerificationCommand) {
  return sandbox.exec(command.command, {
    cwd: resolveHealingCwd(command.cwd),
    timeout: PIPELINE_VERIFY_TIMEOUT_MS,
  });
}

function verificationOutput(result: { stdout: string; stderr: string }) {
  const output = result.stderr || result.stdout;
  return output ? `\n${output}` : '';
}

function boundedVerification(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}) {
  return {
    exitCode: result.exitCode,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr),
  };
}

function trimOutput(output: string) {
  return output.length <= VERIFY_OUTPUT_LIMIT
    ? output
    : output.slice(-VERIFY_OUTPUT_LIMIT);
}
