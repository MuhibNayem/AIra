import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import path from 'path';
import os from 'os';
import { runShellCommand } from '../src/tools/shell_tool.js';
import { writeFile } from '../src/tools/file_system.js';
import { promises as fs } from 'fs';
import { resetSecurityOverrides } from '../src/utils/security.js';

describe('security controls', () => {
  let originalAllowCommands;
  let originalBlockCommands;
  let originalWriteRoots;
  let originalReadRoots;
  let originalReadOnly;

  beforeEach(() => {
    originalAllowCommands = process.env.AIRA_SHELL_ALLOW_COMMANDS;
    originalBlockCommands = process.env.AIRA_SHELL_BLOCK_COMMANDS;
    originalWriteRoots = process.env.AIRA_FS_ADDITIONAL_WRITE_ROOTS;
    originalReadRoots = process.env.AIRA_FS_ADDITIONAL_READ_ROOTS;
    originalReadOnly = process.env.AIRA_FS_READONLY;

    delete process.env.AIRA_SHELL_ALLOW_COMMANDS;
    delete process.env.AIRA_SHELL_BLOCK_COMMANDS;
    delete process.env.AIRA_FS_ADDITIONAL_WRITE_ROOTS;
    delete process.env.AIRA_FS_ADDITIONAL_READ_ROOTS;
    delete process.env.AIRA_FS_READONLY;
    resetSecurityOverrides();
  });

  afterEach(async () => {
    if (originalAllowCommands === undefined) {
      delete process.env.AIRA_SHELL_ALLOW_COMMANDS;
    } else {
      process.env.AIRA_SHELL_ALLOW_COMMANDS = originalAllowCommands;
    }
    if (originalBlockCommands === undefined) {
      delete process.env.AIRA_SHELL_BLOCK_COMMANDS;
    } else {
      process.env.AIRA_SHELL_BLOCK_COMMANDS = originalBlockCommands;
    }
    if (originalWriteRoots === undefined) {
      delete process.env.AIRA_FS_ADDITIONAL_WRITE_ROOTS;
    } else {
      process.env.AIRA_FS_ADDITIONAL_WRITE_ROOTS = originalWriteRoots;
    }
    if (originalReadRoots === undefined) {
      delete process.env.AIRA_FS_ADDITIONAL_READ_ROOTS;
    } else {
      process.env.AIRA_FS_ADDITIONAL_READ_ROOTS = originalReadRoots;
    }
    if (originalReadOnly === undefined) {
      delete process.env.AIRA_FS_READONLY;
    } else {
      process.env.AIRA_FS_READONLY = originalReadOnly;
    }

    const tempFile = path.join(process.cwd(), 'tmp-security.txt');
    await fs.rm(tempFile, { force: true }).catch(() => {});
    resetSecurityOverrides();
  });

  it('blocks destructive shell commands by default', async () => {
    await expect(runShellCommand('rm -rf /')).rejects.toThrow(/blocked/i);
  });

  it('prevents writes outside allowed roots', async () => {
    const outOfBoundsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aira-security-'));
    const result = await writeFile(path.join(outOfBoundsDir, 'file.txt'), 'content');
    expect(result).toMatch(/Write blocked/i);
    await fs.rm(outOfBoundsDir, { recursive: true, force: true });
  });

  it('respects read-only mode', async () => {
    process.env.AIRA_FS_READONLY = '1';
    const target = path.join(process.cwd(), 'tmp-security.txt');
    const result = await writeFile(target, 'data');
    expect(result).toMatch(/read-only/i);
    const exists = await fs
      .access(target)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });
});
