import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import { EventEmitter } from 'events';
import cliCursor from 'cli-cursor';

const responseQueue = [];
const closeMock = vi.fn();

vi.mock('readline', () => ({
  default: {
    createInterface: () => ({
      question: (prompt, cb) => {
        const answer = responseQueue.length ? responseQueue.shift() : '';
        cb(answer);
      },
      close: closeMock,
    }),
  },
}));

const security = await import('../src/utils/security.js');
const {
  ensureReadAllowed,
  ensureWriteAllowed,
  ensureShellCommandAllowed,
  resetSecurityOverrides,
  __setSecurityIO,
} = security;

describe('security utils', () => {
  let originalReadonly;
  let originalWriteRoots;
  let originalReadRoots;

  beforeEach(() => {
    originalReadonly = process.env.AIRA_FS_READONLY;
    originalWriteRoots = process.env.AIRA_FS_WRITE_ROOTS;
    originalReadRoots = process.env.AIRA_FS_READ_ROOTS;
    delete process.env.AIRA_FS_READONLY;
    delete process.env.AIRA_FS_WRITE_ROOTS;
    delete process.env.AIRA_FS_READ_ROOTS;
    resetSecurityOverrides();
    responseQueue.length = 0;
    closeMock.mockClear();
  });

  afterEach(() => {
    if (originalReadonly === undefined) {
      delete process.env.AIRA_FS_READONLY;
    } else {
      process.env.AIRA_FS_READONLY = originalReadonly;
    }
    if (originalWriteRoots === undefined) {
      delete process.env.AIRA_FS_WRITE_ROOTS;
    } else {
      process.env.AIRA_FS_WRITE_ROOTS = originalWriteRoots;
    }
    if (originalReadRoots === undefined) {
      delete process.env.AIRA_FS_READ_ROOTS;
    } else {
      process.env.AIRA_FS_READ_ROOTS = originalReadRoots;
    }
    resetSecurityOverrides();
    __setSecurityIO(null);
  });

  it('allows reads within the project root', () => {
    expect(() => ensureReadAllowed(path.join(process.cwd(), 'file.txt'))).not.toThrow();
  });

  it('blocks reads outside the root', () => {
    const outside = path.resolve(process.cwd(), '..', 'other', 'file.txt');
    expect(() => ensureReadAllowed(outside)).toThrow(/outside allowed paths/);
  });

  it('blocks writes when read-only mode is active', () => {
    process.env.AIRA_FS_READONLY = '1';
    expect(() => ensureWriteAllowed(path.join(process.cwd(), 'file.txt'))).toThrow(/read-only/);
  });

  it('blocks writes outside configured roots', () => {
    process.env.AIRA_FS_WRITE_ROOTS = path.resolve(process.cwd(), 'allowed');
    expect(() => ensureWriteAllowed(path.join(process.cwd(), 'elsewhere.txt'))).toThrow(
      /outside allowed roots/,
    );
  });

  it('allows non-destructive shell commands', async () => {
    await expect(ensureShellCommandAllowed('echo hello', { interactive: false })).resolves.toBe(
      undefined,
    );
  });

  it('blocks destructive shell commands when non-interactive', async () => {
    await expect(ensureShellCommandAllowed('rm -rf /', { interactive: false })).rejects.toThrow(
      /blocked by policy/,
    );
  });

  it('blocks destructive commands invoked via absolute paths', async () => {
    await expect(ensureShellCommandAllowed('/bin/rm -rf /tmp', { interactive: false })).rejects.toThrow(
      /blocked by policy/,
    );
  });

  it('blocks destructive commands invoked via relative Windows-style paths', async () => {
    await expect(
      ensureShellCommandAllowed('.\\RM.EXE /S', { interactive: false }),
    ).rejects.toThrow(/blocked by policy/);
  });

  it('prompts and records single-use override', async () => {
    responseQueue.push('1');
    await expect(ensureShellCommandAllowed('rm /tmp', { interactive: true })).resolves.toBe(
      undefined,
    );
    await expect(ensureShellCommandAllowed('rm /tmp', { interactive: false })).resolves.toBe(
      undefined,
    );
    await expect(ensureShellCommandAllowed('rm /tmp', { interactive: false })).rejects.toThrow(
      /blocked by policy/,
    );
    expect(closeMock).toHaveBeenCalled();
  });

  it('supports session-wide overrides', async () => {
    responseQueue.push('22');
    await expect(ensureShellCommandAllowed('rm -f log', { interactive: true })).resolves.toBe(
      undefined,
    );
    await expect(ensureShellCommandAllowed('rm -f log', { interactive: false })).resolves.toBe(
      undefined,
    );
    await expect(ensureShellCommandAllowed('rm -f log', { interactive: false })).resolves.toBe(
      undefined,
    );
    expect(closeMock).toHaveBeenCalled();
  });

  const createRawIO = () => {
    const stdin = new EventEmitter();
    stdin.isTTY = true;
    stdin.setRawMode = vi.fn();
    stdin.resume = vi.fn();
    stdin.on = stdin.addListener.bind(stdin);
    stdin.off = stdin.removeListener.bind(stdin);
    const stdout = { isTTY: true, write: vi.fn() };
    return { stdin, stdout };
  };

  it('uses raw-mode input when available', async () => {
    const { stdin, stdout } = createRawIO();
    const showSpy = vi.spyOn(cliCursor, 'show').mockImplementation(() => {});
    const hideSpy = vi.spyOn(cliCursor, 'hide').mockImplementation(() => {});

    __setSecurityIO(() => ({ stdin, stdout }));

    const promise = ensureShellCommandAllowed('rm raw', { interactive: true });
    stdin.emit('data', Buffer.from('2'));
    await expect(promise).resolves.toBeUndefined();

    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(showSpy).toHaveBeenCalled();
    expect(hideSpy).toHaveBeenCalled();

    showSpy.mockRestore();
    hideSpy.mockRestore();
    __setSecurityIO(null);
  });

  it('defaults to deny for invalid raw-mode input', async () => {
    const { stdin, stdout } = createRawIO();
    const showSpy = vi.spyOn(cliCursor, 'show').mockImplementation(() => {});
    const hideSpy = vi.spyOn(cliCursor, 'hide').mockImplementation(() => {});
    __setSecurityIO(() => ({ stdin, stdout }));

    const promise = ensureShellCommandAllowed('rm bad', { interactive: true });
    stdin.emit('data', Buffer.from('x'));
    stdin.emit('data', Buffer.from('\r'));
    await expect(promise).rejects.toThrow(/denied/);
    expect(stdout.write).toHaveBeenCalledWith('\nPlease enter 1, 2, or press Enter for 3: ');

    showSpy.mockRestore();
    hideSpy.mockRestore();
    __setSecurityIO(null);
  });
});
