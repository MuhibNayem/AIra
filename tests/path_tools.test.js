import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { resolveProjectPath } from '../src/tools/path_tools.js';

const createTempDir = async () => {
  const prefix = path.join(os.tmpdir(), 'aira-path-tools-');
  return fs.mkdtemp(prefix);
};

describe('path_tools.resolveProjectPath', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', 'index.js'), '', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'README.md'), '', 'utf-8');
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns matches for provided query', async () => {
    const json = await resolveProjectPath({
      query: 'index.js',
      cwd: tempDir,
    });
    const result = JSON.parse(json);
    expect(result.matches.some((match) => match.endsWith('src/index.js'))).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it('provides fallback listing when no matches found', async () => {
    const json = await resolveProjectPath({
      query: 'missing.file',
      cwd: tempDir,
    });
    const result = JSON.parse(json);
    expect(result.matches.length).toBe(0);
    expect(result.fallback).toBeTruthy();
    expect(result.fallback.entries.length).toBeGreaterThan(0);
  });

  it('splits multiple queries by OR', async () => {
    await fs.writeFile(path.join(tempDir, 'another.txt'), '', 'utf-8');
    const json = await resolveProjectPath({
      query: 'missing OR README.md',
      cwd: tempDir,
      limit: 1,
    });
    const result = JSON.parse(json);
    expect(result.queries.length).toBe(2);
    expect(result.matches.length).toBe(1);
  });

  it('reports fallback error when directory listing fails', async () => {
    const readdirSpy = vi.spyOn(fs, 'readdir').mockRejectedValue(new Error('nope'));
    const json = await resolveProjectPath({
      query: 'missing.file',
      cwd: tempDir,
    });
    readdirSpy.mockRestore();
    const result = JSON.parse(json);
    expect(result.fallback.error).toMatch(/nope/);
  });

  it('throws on empty query string', async () => {
    await expect(resolveProjectPath({ query: '   ' })).rejects.toThrow(/non-empty/);
  });

  it('defaults to process.cwd() when cwd is omitted or empty', async () => {
    const expectedCwd = process.cwd();
    const json = await resolveProjectPath({ query: 'README.md', cwd: '' });
    const result = JSON.parse(json);
    expect(result.cwd).toBe(expectedCwd);
    expect(result.matches.some((match) => match.endsWith('README.md'))).toBe(true);
  });

  it('supports glob magic queries', async () => {
    const json = await resolveProjectPath({ query: '**/*.md', cwd: tempDir });
    const result = JSON.parse(json);
    expect(result.matches.some((match) => match.endsWith('README.md'))).toBe(true);
  });

  it('avoids injecting globstars when explicit paths are supplied', async () => {
    const json = await resolveProjectPath({ query: 'src/index.js', cwd: tempDir });
    const result = JSON.parse(json);
    expect(result.matches.some((match) => match.endsWith('src/index.js'))).toBe(true);
  });

  it('filters ignored entries in fallback listings and honors limits', async () => {
    await fs.mkdir(path.join(tempDir, 'node_modules'), { recursive: true });
    const json = await resolveProjectPath({ query: 'missing,still-missing', cwd: tempDir, limit: 1 });
    const result = JSON.parse(json);
    expect(result.fallback.entries).toHaveLength(1);
    expect(result.fallback.truncated).toBe(true);
    expect(result.fallback.entries.some((entry) => entry.name === 'node_modules')).toBe(false);
  });

  it('falls back to default limit when an invalid limit is provided', async () => {
    await fs.writeFile(path.join(tempDir, 'extra.txt'), '', 'utf-8');
    const json = await resolveProjectPath({ query: '*.txt', cwd: tempDir, limit: 0 });
    const result = JSON.parse(json);
    expect(result.matches.length).toBeGreaterThan(0);
  });
});
