import { describe, expect, it, vi } from 'vitest';
import type { StepNotificationHandle } from '../source-control';
import {
  withStepNotification,
  type CompletedStepExecution,
  type StepExecution,
} from './step-notification';

describe('withStepNotification', () => {
  it('reports success and returns the runner output', async () => {
    const handle = notificationHandle();
    const execution = successfulExecution({ cacheHit: true });

    await expect(
      withStepNotification(
        notificationInput(handle),
        () => Promise.resolve(execution),
        passthrough
      )
    ).resolves.toEqual({
      exitCode: 0,
      logs: execution.logs,
      snapshot: execution.snapshot,
      cachePointer: undefined,
    });
    expect(handle.succeed).toHaveBeenCalledWith(
      expect.objectContaining({ cacheHit: true, command: 'pnpm test' })
    );
    expect(handle.fail).not.toHaveBeenCalled();
  });

  it('reports a successful execution without a snapshot as a failure', async () => {
    const handle = notificationHandle();

    await expect(
      withStepNotification(
        notificationInput(handle),
        () => Promise.resolve(successfulExecution({ snapshot: undefined })),
        passthrough
      )
    ).rejects.toThrow('test did not produce a workspace snapshot');
    expect(handle.succeed).not.toHaveBeenCalled();
    expect(handle.fail).toHaveBeenCalledOnce();
  });

  it('reports a rejected success notification as a step failure', async () => {
    const handle = notificationHandle();
    vi.mocked(handle.succeed).mockRejectedValue(new Error('completion failed'));

    await expect(
      withStepNotification(
        notificationInput(handle),
        () => Promise.resolve(successfulExecution()),
        passthrough
      )
    ).rejects.toThrow('completion failed');
    expect(handle.fail).toHaveBeenCalledOnce();
  });

  it('redacts diagnostics and cancels streamed logs on failure', async () => {
    const handle = notificationHandle();
    const cancel = vi.fn();
    const stdout = new ReadableStream<Uint8Array>({ cancel });
    const preview = {
      stdout: 'token=super-secret',
      stderr: 'command failed',
    };

    const failure = withStepNotification(
      notificationInput(handle, ['super-secret']),
      () =>
        Promise.resolve({
          exitCode: 1,
          logs: { stdout, stderr: '' },
          preview,
          cacheHit: false,
        }),
      passthrough
    );

    await expect(failure).rejects.toThrow('token=[REDACTED]');
    expect(cancel).toHaveBeenCalledOnce();
    expect(handle.fail).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(handle.fail).mock.calls)).not.toContain(
      'super-secret'
    );
  });

  it('does not replace the step error when log cleanup fails', async () => {
    const handle = notificationHandle();
    const stdout = new ReadableStream<Uint8Array>({
      cancel: () => {
        throw new Error('cleanup failed');
      },
    });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(
      withStepNotification(
        notificationInput(handle),
        () =>
          Promise.resolve({
            exitCode: 1,
            logs: { stdout, stderr: '' },
            preview: { stdout: '', stderr: 'command failed' },
            cacheHit: false,
          }),
        passthrough
      )
    ).rejects.toThrow('test failed with exit code 1');
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to cancel CI log streams',
      expect.anything()
    );
    expect(handle.fail).toHaveBeenCalledOnce();

    consoleError.mockRestore();
  });

  it('does not replace the step error when failure reporting fails', async () => {
    const handle = notificationHandle();
    vi.mocked(handle.fail).mockRejectedValue(new Error('notification failed'));
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(
      withStepNotification(
        notificationInput(handle),
        () => Promise.reject(new Error('runner failed')),
        passthrough
      )
    ).rejects.toThrow('runner failed');
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to report CI step failure',
      expect.anything()
    );

    consoleError.mockRestore();
  });
});

function passthrough(execution: CompletedStepExecution) {
  return Promise.resolve(execution);
}

function notificationHandle(): StepNotificationHandle {
  return {
    succeed: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
  };
}

function notificationInput(
  handle: StepNotificationHandle,
  sensitiveValues: string[] = []
) {
  return {
    handle,
    label: 'test',
    command: 'pnpm test',
    sensitiveValues,
  };
}

function successfulExecution(
  overrides: Partial<StepExecution> = {}
): StepExecution {
  return {
    exitCode: 0,
    logs: { stdout: 'ok', stderr: '' },
    preview: { stdout: 'ok', stderr: '' },
    snapshot: { id: 'backup-1', dir: '/workspace' },
    cacheHit: false,
    ...overrides,
  };
}
