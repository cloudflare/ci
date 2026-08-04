import { posix } from 'node:path';
import { z, type ZodType } from 'zod';

const WORKSPACE_DIR = '/workspace';
const TOOL_OUTPUT_LIMIT = 20_000;
const TOOL_EXEC_TIMEOUT_MS = 2 * 60 * 1000;
const TOOL_EXEC_TIMEOUT_LIMIT_MS = 10 * 60 * 1000;
const TOOL_COMMAND_LIMIT = 10_000;
const TOOL_FILE_CONTENT_LIMIT = 500_000;
const TOOL_READ_LINE_LIMIT = 2_000;
const TOOL_SEARCH_RESULT_LIMIT = 500;

export type HealingSandbox = {
  exec(
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
    }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFile(
    path: string,
    options?: { encoding?: 'utf-8' }
  ): Promise<{ content: string }>;
  writeFile(path: string, content: string): Promise<unknown>;
};

export type HealingTool = {
  description: string;
  inputSchema: ZodType;
  mutatesWorkspace: boolean;
  execute(input: unknown): Promise<unknown>;
};

export type HealingToolSet = Record<string, HealingTool>;

export function sandboxTools(sandbox: HealingSandbox): HealingToolSet {
  return {
    read_file: healingTool({
      description:
        'Read a range of lines from a UTF-8 repository file. Lines are numbered; use offset to continue reading.',
      inputSchema: z.object({
        path: z.string().max(1000),
        offset: z.int().positive().default(1),
        limit: z.int().positive().max(TOOL_READ_LINE_LIMIT).default(500),
      }),
      mutatesWorkspace: false,
      execute: async ({ path, offset, limit }) => {
        const resolved = resolveWorkspacePath(path);
        const file = await sandbox.readFile(resolved, { encoding: 'utf-8' });
        const lines = file.content.split('\n');
        const selected = lines.slice(offset - 1, offset - 1 + limit);
        const rendered: string[] = [];
        let contentLength = 0;
        let clippedLine = false;
        for (const [index, line] of selected.entries()) {
          const numbered = `${offset + index}: ${line}`;
          const separatorLength = rendered.length > 0 ? 1 : 0;
          if (
            contentLength + separatorLength + numbered.length >
            TOOL_OUTPUT_LIMIT
          ) {
            if (rendered.length === 0) {
              const marker = '\n... line truncated ...';
              rendered.push(
                `${numbered.slice(0, TOOL_OUTPUT_LIMIT - marker.length)}${marker}`
              );
              clippedLine = true;
            }
            break;
          }
          rendered.push(numbered);
          contentLength += separatorLength + numbered.length;
        }
        const nextOffset = offset - 1 + rendered.length;
        return {
          path,
          content: rendered.join('\n'),
          totalLines: lines.length,
          nextOffset: nextOffset < lines.length ? nextOffset + 1 : undefined,
          truncated: clippedLine || rendered.length < selected.length,
        };
      },
    }),
    edit_file: healingTool({
      description:
        'Replace one unique, exact text occurrence in a UTF-8 repository file. Prefer this over rewriting an entire file.',
      inputSchema: z.object({
        path: z.string().max(1000),
        oldText: z.string().min(1).max(TOOL_FILE_CONTENT_LIMIT),
        newText: z.string().max(TOOL_FILE_CONTENT_LIMIT),
      }),
      mutatesWorkspace: true,
      execute: async ({ path, oldText, newText }) => {
        const resolved = resolveWorkspacePath(path);
        const file = await sandbox.readFile(resolved, { encoding: 'utf-8' });
        if (file.content.length > TOOL_FILE_CONTENT_LIMIT) {
          throw new Error(
            `file is too large to edit (${file.content.length} characters)`
          );
        }
        const first = file.content.indexOf(oldText);
        if (first === -1) {
          throw new Error('oldText was not found in the file');
        }
        if (file.content.indexOf(oldText, first + oldText.length) !== -1) {
          throw new Error('oldText must match exactly one occurrence');
        }
        const content =
          file.content.slice(0, first) +
          newText +
          file.content.slice(first + oldText.length);
        if (content.length > TOOL_FILE_CONTENT_LIMIT) {
          throw new Error(
            `edited file exceeds ${TOOL_FILE_CONTENT_LIMIT} characters`
          );
        }
        await sandbox.writeFile(resolved, content);
        return { path };
      },
    }),
    write_file: healingTool({
      description: 'Replace a UTF-8 file in the repository workspace.',
      inputSchema: z.object({
        path: z.string().max(1000),
        content: z.string().max(TOOL_FILE_CONTENT_LIMIT),
      }),
      mutatesWorkspace: true,
      execute: async ({ path, content }) => {
        await sandbox.writeFile(resolveWorkspacePath(path), content);
        return { path };
      },
    }),
    exec: healingTool({
      description:
        'Run a shell command in the repository workspace and return bounded output. Commands may edit the workspace, so verification runs afterward.',
      inputSchema: z.object({
        command: z.string().max(TOOL_COMMAND_LIMIT),
        timeoutMs: z
          .int()
          .positive()
          .max(TOOL_EXEC_TIMEOUT_LIMIT_MS)
          .default(TOOL_EXEC_TIMEOUT_MS),
      }),
      mutatesWorkspace: true,
      execute: async ({ command, timeoutMs }) => {
        const result = await sandbox.exec(command, {
          cwd: WORKSPACE_DIR,
          timeout: timeoutMs,
        });
        return {
          exitCode: result.exitCode,
          stdout: trimOutput(result.stdout),
          stderr: trimOutput(result.stderr),
          stdoutTruncated: result.stdout.length > TOOL_OUTPUT_LIMIT,
          stderrTruncated: result.stderr.length > TOOL_OUTPUT_LIMIT,
        };
      },
    }),
    grep: healingTool({
      description:
        'Search repository file contents with a regular expression and return matching lines.',
      inputSchema: z.object({
        pattern: z.string().min(1).max(1000),
        path: z.string().max(1000).default('.'),
        glob: z.string().min(1).max(1000).optional(),
        limit: z.int().positive().max(TOOL_SEARCH_RESULT_LIMIT).default(100),
      }),
      mutatesWorkspace: false,
      execute: async ({ pattern, path, glob, limit }) => {
        const args = [
          'rg',
          '--line-number',
          '--no-heading',
          '--color=never',
          ...(glob ? ['--glob', glob] : []),
          '--',
          pattern,
          resolveWorkspacePath(path),
        ];
        return search(sandbox, args, limit);
      },
    }),
    find_files: healingTool({
      description:
        'Find repository files by glob. Git-ignored files are excluded.',
      inputSchema: z.object({
        glob: z.string().min(1).max(1000),
        path: z.string().max(1000).default('.'),
        limit: z.int().positive().max(TOOL_SEARCH_RESULT_LIMIT).default(100),
      }),
      mutatesWorkspace: false,
      execute: async ({ glob, path, limit }) =>
        search(
          sandbox,
          ['rg', '--files', '--glob', glob, resolveWorkspacePath(path)],
          limit
        ),
    }),
  };
}

function healingTool<TSchema extends ZodType>({
  description,
  inputSchema,
  mutatesWorkspace,
  execute,
}: {
  description: string;
  inputSchema: TSchema;
  mutatesWorkspace: boolean;
  execute(input: z.infer<TSchema>): Promise<unknown>;
}): HealingTool {
  return {
    description,
    inputSchema,
    mutatesWorkspace,
    execute: async (input) => execute(inputSchema.parse(input)),
  };
}

function resolveWorkspacePath(path: string) {
  const normalized = posix.normalize(path);
  if (
    posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`path must be relative to ${WORKSPACE_DIR}: ${path}`);
  }
  return posix.join(WORKSPACE_DIR, normalized);
}

function trimOutput(output: string) {
  if (output.length <= TOOL_OUTPUT_LIMIT) {
    return output;
  }
  const half = Math.floor(TOOL_OUTPUT_LIMIT / 2);
  return `${output.slice(0, half)}\n... ${output.length - TOOL_OUTPUT_LIMIT} characters omitted ...\n${output.slice(-half)}`;
}

async function search(sandbox: HealingSandbox, args: string[], limit: number) {
  const result = await sandbox.exec(
    `${args.map(shellQuote).join(' ')} | head -n ${limit + 1}`,
    { cwd: WORKSPACE_DIR, timeout: TOOL_EXEC_TIMEOUT_MS }
  );
  if (result.stderr) {
    throw new Error(result.stderr);
  }
  const found = result.stdout.replace(/\n$/, '').split('\n').filter(Boolean);
  const matches: string[] = [];
  let outputLength = 0;
  for (const match of found.slice(0, limit)) {
    const separatorLength = matches.length > 0 ? 1 : 0;
    if (outputLength + separatorLength + match.length > TOOL_OUTPUT_LIMIT) {
      break;
    }
    matches.push(match);
    outputLength += separatorLength + match.length;
  }
  return {
    matches,
    truncated: found.length > matches.length,
  };
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
