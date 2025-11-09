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
  readManyFiles,
  createManyFiles,
  listDirectoryStructure,
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

  it('resolveFilePath falls back to glob matches when direct lookup fails', async () => {
    const target = path.join(tempDir, 'fallback-file.txt');
    await fs.writeFile(target, 'data', 'utf-8');
    const actualCwd = process.cwd();
    const cwdSpy = vi.spyOn(process, 'cwd');
    cwdSpy.mockImplementationOnce(() => actualCwd).mockImplementation(() => tempDir);
    const resolved = await resolveFilePath('fallback-file.txt');
    expect(resolved).toBe(target);
    cwdSpy.mockRestore();
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

  it('attemptResolveExistingPath finds directories when requested', async () => {
    await fs.mkdir(path.join(tempDir, 'src', 'nested'), { recursive: true });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    const resolved = await attemptResolveExistingPath('src', { type: 'directory' });
    expect(resolved).toBe(path.join(tempDir, 'src'));
    cwdSpy.mockRestore();
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

  it('listDirectory uses resolved fallback when a similarly named directory exists', async () => {
    const fallbackDir = path.join(tempDir, 'fallback');
    await fs.mkdir(fallbackDir, { recursive: true });
    await fs.writeFile(path.join(fallbackDir, 'a.txt'), 'hi', 'utf-8');
    const originalCwd = process.cwd();
    const cwdSpy = vi.spyOn(process, 'cwd');
    cwdSpy.mockImplementationOnce(() => originalCwd).mockImplementation(() => tempDir);
    const entries = await listDirectory('fallback');
    expect(entries).toContain('a.txt');
    cwdSpy.mockRestore();
  });

  it('resolvePathForOS respects provided system info mocks', () => {
    const resolved = resolvePathForOS('folder/file.txt', { isWindows: true });
    expect(resolved.includes('\\')).toBe(true);
  });

  describe('readManyFiles', () => {
    it('collects files with requested extensions and content', async () => {
      await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'src', 'app.js'), 'console.log("js");', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'notes.md'), '# docs', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'notes.txt'), 'ignore me', 'utf-8');

      const results = await readManyFiles(tempDir, {
        extensions: ['.js', '.md'],
        includeContent: true,
        maxFiles: 10,
      });

      expect(results.success).toBe(true);
      expect(results.filesRead).toBe(2);
      expect(results.files).toHaveLength(2);
      expect(results.files.every((file) => typeof file.content === 'string')).toBe(true);
    });

    it('enforces max file limits and omits content when requested', async () => {
      await fs.writeFile(path.join(tempDir, 'one.txt'), '1', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'two.txt'), '2', 'utf-8');

      const results = await readManyFiles(tempDir, {
        maxFiles: 1,
        includeContent: false,
      });

      expect(results.filesRead).toBe(1);
      expect(results.errors.some((msg) => msg.includes('maximum file limit'))).toBe(true);
      expect(results.files[0].content).toBeUndefined();
    });

    it('records security errors for individual files', async () => {
      await fs.writeFile(path.join(tempDir, 'allowed.txt'), 'ok', 'utf-8');
      const blockedFile = path.join(tempDir, 'secret.txt');
      await fs.writeFile(blockedFile, 'secret', 'utf-8');
      const originalGuard = security.ensureReadAllowed;
      const guardSpy = vi
        .spyOn(security, 'ensureReadAllowed')
        .mockImplementation((candidate) => {
          if (candidate.includes('secret.txt')) {
            throw new Error('blocked');
          }
          return originalGuard(candidate);
        });

      const results = await readManyFiles(tempDir);
      expect(results.filesRead).toBe(1);
      expect(results.filesSkipped).toBeGreaterThan(0);
      expect(results.errors.some((msg) => msg.includes('Security'))).toBe(true);
      guardSpy.mockRestore();
    });

    it('rejects ignored roots early', async () => {
      const ignoredRoot = path.join(tempDir, 'node_modules');
      await fs.mkdir(ignoredRoot, { recursive: true });
      const results = await readManyFiles(ignoredRoot);
      expect(results.success).toBe(false);
      expect(results.errors[0]).toMatch(/ignored path/);
    });

    it('records read errors when file contents cannot be retrieved', async () => {
      const badFile = path.join(tempDir, 'bad.txt');
      await fs.writeFile(badFile, 'bad', 'utf-8');
      const goodFile = path.join(tempDir, 'good.txt');
      await fs.writeFile(goodFile, 'good', 'utf-8');
      const realRead = fs.readFile.bind(fs);
      const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (candidate, encoding) => {
        if (candidate === badFile) {
          throw new Error('cannot read');
        }
        return realRead(candidate, encoding);
      });
      const results = await readManyFiles(tempDir);
      expect(results.errors.some((msg) => msg.includes('Read error'))).toBe(true);
      expect(results.filesSkipped).toBeGreaterThan(0);
      readSpy.mockRestore();
    });

    it('falls back to matching directories when the primary root is missing', async () => {
      await fs.mkdir(path.join(tempDir, 'fallback-root'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'fallback-root', 'data.txt'), 'ok', 'utf-8');
      const actualCwd = process.cwd();
      const cwdSpy = vi.spyOn(process, 'cwd');
      cwdSpy.mockImplementationOnce(() => actualCwd).mockImplementation(() => tempDir);
      const results = await readManyFiles('fallback-root', { includeContent: false });
      expect(results.success).toBe(true);
      expect(results.filesRead).toBeGreaterThan(0);
      cwdSpy.mockRestore();
    });

    it('reports missing roots when no fallback can be resolved', async () => {
      const results = await readManyFiles('totally-missing-root');
      expect(results.success).toBe(false);
      expect(results.errors[0]).toMatch(/Root directory not found/);
    });

    it('records processing errors when stat calls fail mid-iteration', async () => {
      const brokenFile = path.join(tempDir, 'broken.txt');
      const healthyFile = path.join(tempDir, 'healthy.txt');
      await fs.writeFile(brokenFile, 'broken', 'utf-8');
      await fs.writeFile(healthyFile, 'healthy', 'utf-8');
      const realStat = fs.stat.bind(fs);
      const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
        if (candidate === brokenFile) {
          throw new Error('stat fail');
        }
        return realStat(candidate);
      });
      const results = await readManyFiles(tempDir);
      expect(results.errors.some((msg) => msg.includes('Processing error'))).toBe(true);
      expect(results.filesSkipped).toBeGreaterThan(0);
      statSpy.mockRestore();
    });

    it('reports fatal errors when the root read guard rejects access', async () => {
      const originalGuard = security.ensureReadAllowed;
      const guardSpy = vi
        .spyOn(security, 'ensureReadAllowed')
        .mockImplementationOnce(() => {
          throw new Error('root denied');
        })
        .mockImplementation(originalGuard);
      const results = await readManyFiles(tempDir);
      expect(results.success).toBe(false);
      expect(results.errors[0]).toMatch(/root denied/);
      guardSpy.mockRestore();
    });
  });

  describe('createManyFiles', () => {
    it('creates directories, files, and skips ignored entries', async () => {
      const structure = [
        { path: 'src', isDirectory: true },
        { path: 'src/index.js', content: 'export {};' },
        { path: 'README.md', content: '# Title' },
        { path: 'node_modules/skip.js', content: 'ignored' },
        {},
      ];

      const result = await createManyFiles(tempDir, structure);
      expect(result.createdDirs).toBe(1);
      expect(result.createdFiles).toBe(2);
      expect(result.logs.some((msg) => msg.includes('Skipped ignored path'))).toBe(true);
      expect(result.errors.some((msg) => msg.includes('Invalid entry'))).toBe(true);

      const created = await readFile(path.join(tempDir, 'src', 'index.js'));
      expect(created).toContain('export {}');
    });

    it('reports fatal errors when the root path is invalid', async () => {
      const result = await createManyFiles('', [{ path: 'file.txt', content: 'x' }]);
      expect(result.success).toBe(false);
      expect(result.errors[0]).toMatch(/Fatal error/);
    });
  });

  describe('listDirectoryStructure', () => {
    it('returns nested structures for valid roots', async () => {
      await fs.mkdir(path.join(tempDir, 'src', 'nested'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'src', 'nested', 'file.txt'), 'ok', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'ghost.txt'), 'ghost', 'utf-8');

      const realStat = fs.stat.bind(fs);
      const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
        if (candidate.endsWith('ghost.txt')) {
          throw new Error('cannot stat');
        }
        return realStat(candidate);
      });

      const result = await listDirectoryStructure(tempDir);
      expect(result.success).toBe(true);
      const ghostEntry = result.structure.find((entry) => entry.name === 'ghost.txt');
      expect(ghostEntry.error).toMatch(/cannot stat/);
      statSpy.mockRestore();
    });

    it('rejects ignored roots', async () => {
      const ignoredRoot = path.join(tempDir, 'node_modules');
      await fs.mkdir(ignoredRoot, { recursive: true });
      const result = await listDirectoryStructure(ignoredRoot);
      expect(result.success).toBe(false);
      expect(result.errors[0]).toMatch(/ignored path/);
    });

    it('reports errors when reading the root directory fails', async () => {
      const readdirSpy = vi.spyOn(fs, 'readdir').mockRejectedValueOnce(new Error('boom'));
      const result = await listDirectoryStructure(tempDir);
      expect(result.success).toBe(false);
      expect(result.errors[0]).toMatch(/boom/);
      readdirSpy.mockRestore();
    });
  });
});
