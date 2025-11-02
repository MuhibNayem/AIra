import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

const childProcess = await import('child_process');
const security = await import('../src/utils/security.js');
const shellTool = await import('../src/tools/shell_tool.js');

const { runShellCommand, createShellTool } = shellTool;

beforeEach(() => {
  vi.resetAllMocks();
  childProcess.exec.mockImplementation((cmd, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    cb(null, { stdout: '', stderr: '' });
    return { on: vi.fn() };
  });
  vi.spyOn(security, 'ensureShellCommandAllowed').mockResolvedValue();
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('runShellCommand', () => {
  it('returns trimmed stdout when execution succeeds', async () => {
    childProcess.exec.mockImplementation((cmd, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      cb(null, { stdout: 'hello\n', stderr: '' });
      return { on: vi.fn() };
    });
    const output = await runShellCommand('echo hello');
    expect(output).toBe('hello');
    expect(childProcess.exec).toHaveBeenCalled();
  });

  it('returns stderr when stdout is empty', async () => {
    childProcess.exec.mockImplementation((cmd, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      cb(null, { stdout: '', stderr: 'warning' });
      return { on: vi.fn() };
    });
    const output = await runShellCommand('echo warn');
    expect(output).toBe('stderr:\nwarning');
  });

  it('returns combined stdout and stderr when both exist', async () => {
    childProcess.exec.mockImplementation((cmd, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      cb(null, { stdout: 'out', stderr: 'err' });
      return { on: vi.fn() };
    });
    const output = await runShellCommand('echo warn');
    expect(output).toBe('stdout:\nout\n\nstderr:\nerr');
  });

  it('normalizes Windows aliases prior to execution', async () => {
    childProcess.exec.mockImplementation((cmd, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      cb(null, { stdout: 'listing', stderr: '' });
      return { on: vi.fn() };
    });
    const ensureSpy = vi.spyOn(security, 'ensureShellCommandAllowed').mockResolvedValue();
    const output = await runShellCommand('ls -a', {}, { isWindows: true });
    expect(output).toBe('listing');
    expect(ensureSpy).toHaveBeenCalledWith('dir /a');
    expect(childProcess.exec).toHaveBeenCalledWith(
      'dir /a',
      expect.objectContaining({ maxBuffer: expect.any(Number), timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it('aggregates stderr/stdout when exec rejects', async () => {
    childProcess.exec.mockImplementation((cmd, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      const error = new Error('boom');
      error.stdout = 'partial';
      error.stderr = 'failure';
      cb(error, { stdout: 'partial', stderr: 'failure' });
      return { on: vi.fn() };
    });
    await expect(runShellCommand('echo boom')).rejects.toThrow(/stdout:\npartial/);
  });

  it('rejects empty string commands', async () => {
    await expect(runShellCommand('   ')).rejects.toThrow(/non-empty command/);
  });

  it('rejects invalid command objects', async () => {
    await expect(runShellCommand({ command: '   ' })).rejects.toThrow(/non-empty command/);
  });

  it('rejects non-object options', async () => {
    await expect(runShellCommand('echo hi', 'bad')).rejects.toThrow(/Options must be an object/);
  });

  it('accepts object command inputs', async () => {
    childProcess.exec.mockImplementation((cmd, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      cb(null, { stdout: 'object', stderr: '' });
      return { on: vi.fn() };
    });
    const output = await runShellCommand({ command: 'echo object' });
    expect(output).toBe('object');
  });

  it('rejects command objects without usable fields', async () => {
    await expect(runShellCommand({})).rejects.toThrow(/expects a string command/);
  });

  it('rejects non-string command values', async () => {
    await expect(runShellCommand(42)).rejects.toThrow(/expects a string command/);
  });

  it('rejects null command values', async () => {
    await expect(runShellCommand(null)).rejects.toThrow(/expects a string command/);
  });

  it('propagates security guard failures before execution', async () => {
    const guardSpy = vi
      .spyOn(security, 'ensureShellCommandAllowed')
      .mockRejectedValue(new Error('blocked'));
    await expect(runShellCommand('echo')).rejects.toThrow(/blocked/);
    guardSpy.mockRestore();
  });

  it('leaves non-aliased Windows commands unchanged', async () => {
    childProcess.exec.mockImplementation((cmd, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      cb(null, { stdout: 'ok', stderr: '' });
      return { on: vi.fn() };
    });
    const ensureSpy = vi.spyOn(security, 'ensureShellCommandAllowed').mockResolvedValue();
    const output = await runShellCommand('echo test', {}, { isWindows: true });
    expect(output).toBe('ok');
    expect(childProcess.exec).toHaveBeenCalledWith(
      'echo test',
      expect.any(Object),
      expect.any(Function),
    );
    ensureSpy.mockRestore();
  });
});

describe('createShellTool', () => {
  it('passes shell options to the executor', async () => {
    childProcess.exec.mockImplementation((cmd, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      cb(null, { stdout: 'value', stderr: '' });
      return { on: vi.fn() };
    });
    const systemInfo = { isWindows: false, shell: '/bin/zsh' };
    const tool = createShellTool(systemInfo);
    const response = await tool('echo test');
    expect(response).toBe('value');
    const [command, execOptions] = childProcess.exec.mock.calls[0];
    expect(command).toBe('echo test');
    const expectedShell = process.env.SHELL || '/bin/bash';
    expect(execOptions.shell).toBe(expectedShell);
  });

  it('uses COMSPEC on Windows systems', async () => {
    const originalComspec = process.env.COMSPEC;
    process.env.COMSPEC = 'C:\\dummy\\cmd.exe';
    childProcess.exec.mockImplementation((cmd, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      cb(null, { stdout: 'value', stderr: '' });
      return { on: vi.fn() };
    });
    const tool = createShellTool({ isWindows: true });
    const response = await tool('echo test');
    expect(response).toBe('value');
    const [, execOptions] = childProcess.exec.mock.calls[0];
    expect(execOptions.shell).toBe('C:\\dummy\\cmd.exe');
    if (originalComspec === undefined) {
      delete process.env.COMSPEC;
    } else {
      process.env.COMSPEC = originalComspec;
    }
  });
});
