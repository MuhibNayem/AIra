import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { searchFileContent } from '../src/tools/code_tools.js';

const createTempDir = async () => {
  const prefix = path.join(os.tmpdir(), 'aira-code-tools-');
  return fs.mkdtemp(prefix);
};

describe('code_tools.searchFileContent', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await fs.writeFile(path.join(tempDir, 'file-a.txt'), 'alpha\nbeta\ngamma', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'file-b.js'), 'const value = 42;', 'utf-8');
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('finds occurrences of a regex across files', async () => {
    const result = await searchFileContent('value\\s*=\\s*42', tempDir);
    expect(result).toContain('file-b.js');
  });

  it('returns friendly error for invalid regex', async () => {
    const result = await searchFileContent('(', tempDir);
    expect(result).toMatch(/Invalid regular expression/);
  });

  it('returns message when no matches are found', async () => {
    const result = await searchFileContent('delta', tempDir);
    expect(result).toBe('No matches found.');
  });

  it('returns error when glob fails', async () => {
    vi.resetModules();
    vi.doMock('glob', async () => {
      const actual = await vi.importActual('glob');
      return {
        ...actual,
        glob: async () => {
          throw new Error('glob failure');
        },
      };
    });
    const { searchFileContent: mockedSearch } = await import('../src/tools/code_tools.js');
    const result = await mockedSearch('value', tempDir);
    expect(result).toMatch(/Error searching files: glob failure/);
    vi.unmock('glob');
    vi.resetModules();
  });
});
