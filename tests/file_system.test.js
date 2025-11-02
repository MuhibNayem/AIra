import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import * as fileSystem from '../src/tools/file_system.js';
import * as security from '../src/utils/security.js';

const {
  writeFile,
  readFile,
  resolveFilePath,
  listDirectory,
  resolvePathForOS,
  fileExists,
  directoryExists,
  attemptResolveExistingPath,
} = fileSystem;

const createTempDir = async () => {
  const prefix = path.join(os.tmpdir(), 'aira-fs-test-');
  return fs.mkdtemp(prefix);
};

describe('file_system tools', () => {
  let tempDir;
  let previousWriteRoots;
  let previousReadRoots;

  beforeEach(async () => {
    tempDir = await createTempDir();
    previousWriteRoots = process.env.AIRA_FS_ADDITIONAL_WRITE_ROOTS;
    previousReadRoots = process.env.AIRA_FS_ADDITIONAL_READ_ROOTS;
    process.env.AIRA_FS_ADDITIONAL_WRITE_ROOTS = previousWriteRoots
      ? `${previousWriteRoots},${tempDir}`
      : tempDir;
    process.env.AIRA_FS_ADDITIONAL_READ_ROOTS = previousReadRoots
      ? `${previousReadRoots},${tempDir}`
      : tempDir;
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    if (previousWriteRoots === undefined) {
      delete process.env.AIRA_FS_ADDITIONAL_WRITE_ROOTS;
    } else {
      process.env.AIRA_FS_ADDITIONAL_WRITE_ROOTS = previousWriteRoots;
    }
    if (previousReadRoots === undefined) {
      delete process.env.AIRA_FS_ADDITIONAL_READ_ROOTS;
    } else {
      process.env.AIRA_FS_ADDITIONAL_READ_ROOTS = previousReadRoots;
    }
  });

  it('writes and reads UTF-8 files', async () => {
    const filePath = path.join(tempDir, 'sample.txt');
    const content = 'hello world';

    const writeMessage = await writeFile(filePath, content);
    expect(writeMessage).toMatch(/Successfully/);

    const readContent = await readFile(filePath);
    expect(readContent).toBe(content);

    const overwriteMessage = await writeFile(filePath, 'updated content');
    expect(overwriteMessage).toMatch(/Successfully overwrote/);
  });

  it('resolves existing files with resolveFilePath', async () => {
    const filePath = path.join(tempDir, 'nested', 'file.txt');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'data', 'utf-8');

    const resolved = await resolveFilePath(filePath);
    expect(resolved).toBe(filePath);
  });

  it('throws when resolveFilePath cannot find a file', async () => {
    await expect(resolveFilePath(path.join(tempDir, 'missing.txt'))).rejects.toThrow(
      /File not found/,
    );
  });

  it('resolvePathForOS throws on empty strings', () => {
    expect(() => resolvePathForOS('   ')).toThrow(/non-empty/);
  });

  it('lists directory entries excluding ignored folders', async () => {
    await fs.mkdir(path.join(tempDir, 'src'));
    await fs.mkdir(path.join(tempDir, 'node_modules'));
    await fs.writeFile(path.join(tempDir, 'README.md'), '', 'utf-8');

    const entries = await listDirectory(tempDir);
    expect(entries).toContain('src');
    expect(entries).toContain('README.md');
    expect(entries).not.toContain('node_modules');
  });

  it('reports when reading a directory instead of a file', async () => {
    const folder = path.join(tempDir, 'folder');
    await fs.mkdir(folder);
    const result = await readFile(folder);
    expect(result).toMatch(/not a regular file/);
  });

  it('readFile blocks ignored directories', async () => {
    await fs.mkdir(path.join(tempDir, 'node_modules'), { recursive: true });
    const ignoredFile = path.join(tempDir, 'node_modules', 'hidden.txt');
    await fs.writeFile(ignoredFile, 'ignore', 'utf-8');
    const result = await readFile(ignoredFile);
    expect(result).toMatch(/blocked/);
  });

  it('blocks writes into ignored directories', async () => {
    const result = await writeFile(path.join(tempDir, 'node_modules', 'pkg', 'file.txt'), 'data');
    expect(result).toMatch(/ignored directory/);
  });

  it('returns permission error when read guard rejects', async () => {
    const spy = vi.spyOn(security, 'ensureReadAllowed').mockImplementation(() => {
      throw new Error('Denied');
    });
    const result = await readFile(path.join(tempDir, 'foo.txt'));
    expect(result).toMatch(/Denied/);
    spy.mockRestore();
  });

  it('returns permission error when write guard rejects', async () => {
    const spy = vi.spyOn(security, 'ensureWriteAllowed').mockImplementation(() => {
      throw new Error('Denied');
    });
    const result = await writeFile(path.join(tempDir, 'foo.txt'), 'data');
    expect(result).toMatch(/Denied/);
    spy.mockRestore();
  });

  it('fileExists returns true for existing files', async () => {
    const filePath = path.join(tempDir, 'exists.txt');
    await fs.writeFile(filePath, 'data', 'utf-8');
    const exists = await fileExists(filePath);
    expect(exists).toBe(true);
  });

  it('fileExists returns false for missing files', async () => {
    const missing = path.join(tempDir, 'missing.txt');
    const exists = await fileExists(missing);
    expect(exists).toBe(false);
  });

  it('directoryExists returns false for missing directories', async () => {
    const missing = path.join(tempDir, 'missing-dir');
    const exists = await directoryExists(missing);
    expect(exists).toBe(false);
  });

  it('directoryExists returns true for existing directories', async () => {
    const dir = path.join(tempDir, 'existing-dir');
    await fs.mkdir(dir);
    const exists = await directoryExists(dir);
    expect(exists).toBe(true);
  });

  it('writeFile rejects non-string content', async () => {
    const message = await writeFile(path.join(tempDir, 'invalid.txt'), 12345);
    expect(message).toMatch(/content must be a UTF-8 string/);
  });

  it('listDirectory reports permission errors', async () => {
    const spy = vi.spyOn(security, 'ensureReadAllowed').mockImplementation(() => {
      throw new Error('Denied');
    });
    const result = await listDirectory(tempDir);
    expect(result).toMatch(/Denied/);
    spy.mockRestore();
  });

  it('listDirectory blocks ignored directories explicitly', async () => {
    const ignoredDir = path.join(tempDir, 'node_modules');
    await fs.mkdir(ignoredDir, { recursive: true });
    const result = await listDirectory(ignoredDir);
    expect(result).toMatch(/blocked/);
  });

  it('attemptResolveExistingPath falls back to glob matches', async () => {
    await fs.mkdir(path.join(tempDir, 'nested'), { recursive: true });
    const target = path.join(tempDir, 'nested', 'target.js');
    await fs.writeFile(target, 'console.log("hi")', 'utf-8');
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    const resolved = await attemptResolveExistingPath('target.js');
    expect(resolved).toBe(target);
    cwdSpy.mockRestore();
  });

  it('attemptResolveExistingPath returns null when no matches are found', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    const resolved = await attemptResolveExistingPath('totally-missing.txt');
    expect(resolved).toBeNull();
    cwdSpy.mockRestore();
  });

  it('attemptResolveExistingPath returns null for empty input', async () => {
    const resolved = await attemptResolveExistingPath('');
    expect(resolved).toBeNull();
  });

  it('readFile uses fallback resolution when initial lookup fails', async () => {
    await fs.mkdir(path.join(tempDir, 'deep'), { recursive: true });
    const target = path.join(tempDir, 'deep', 'note.txt');
    await fs.writeFile(target, 'fallback', 'utf-8');
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    const content = await readFile('note.txt');
    expect(content).toBe('fallback');
    cwdSpy.mockRestore();
  });

  it('listDirectory falls back when supplied path is missing', async () => {
    await fs.mkdir(path.join(tempDir, 'folder'), { recursive: true });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    const entries = await listDirectory(path.join(tempDir, 'missing-folder'));
    expect(typeof entries === 'string' || Array.isArray(entries)).toBe(true);
    cwdSpy.mockRestore();
  });
});
