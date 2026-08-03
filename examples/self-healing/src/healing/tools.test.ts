import { describe, expect, it, vi } from 'vitest';
import { sandboxTools, type HealingSandbox } from './tools';

describe('sandboxTools', () => {
  it('reads numbered line ranges with continuation metadata', async () => {
    const sandbox = fakeSandbox('one\ntwo\nthree\nfour');

    await expect(
      sandboxTools(sandbox).read_file.execute({
        path: 'src/value.ts',
        offset: 2,
        limit: 2,
      })
    ).resolves.toEqual({
      path: 'src/value.ts',
      content: '2: two\n3: three',
      totalLines: 4,
      nextOffset: 4,
      truncated: false,
    });
  });

  it('edits one exact occurrence without rewriting unrelated content', async () => {
    const sandbox = fakeSandbox('const value = 1;\nconst other = 2;');

    await sandboxTools(sandbox).edit_file.execute({
      path: 'src/value.ts',
      oldText: 'value = 1',
      newText: 'value = 3',
    });

    expect(sandbox.writeFile).toHaveBeenCalledWith(
      '/workspace/src/value.ts',
      'const value = 3;\nconst other = 2;'
    );
  });

  it('rejects ambiguous edits', async () => {
    const sandbox = fakeSandbox('same\nsame');

    await expect(
      sandboxTools(sandbox).edit_file.execute({
        path: 'value.txt',
        oldText: 'same',
        newText: 'changed',
      })
    ).rejects.toThrow('oldText must match exactly one occurrence');
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it('quotes repository searches and bounds their results', async () => {
    const sandbox = fakeSandbox('');
    vi.mocked(sandbox.exec).mockResolvedValue({
      exitCode: 0,
      stdout: '/workspace/src/a.ts:1:match\n',
      stderr: '',
    });

    await expect(
      sandboxTools(sandbox).grep.execute({
        pattern: "can't",
        path: 'src',
        glob: '*.ts',
        limit: 25,
      })
    ).resolves.toEqual({
      matches: ['/workspace/src/a.ts:1:match'],
      truncated: false,
    });
    expect(sandbox.exec).toHaveBeenCalledWith(
      `'rg' '--line-number' '--no-heading' '--color=never' '--glob' '*.ts' '--' 'can'"'"'t' '/workspace/src' | head -n 26`,
      { cwd: '/workspace', timeout: 120_000 }
    );
  });

  it('rejects paths outside the workspace', async () => {
    const sandbox = fakeSandbox('');

    await expect(
      sandboxTools(sandbox).read_file.execute({ path: '../secret', limit: 1 })
    ).rejects.toThrow('path must be relative to /workspace');
  });
});

function fakeSandbox(content: string): HealingSandbox {
  return {
    exec: vi.fn(),
    readFile: vi.fn().mockResolvedValue({ content }),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
}
