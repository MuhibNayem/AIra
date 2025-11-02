import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';

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
});
