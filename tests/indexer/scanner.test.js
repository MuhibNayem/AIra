import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { scanProjectFiles, detectLanguage } from '../../src/indexer/scanner.js';

const createWorkspace = () => mkdtemp(path.join(os.tmpdir(), 'aira-scan-'));

describe('scanProjectFiles', () => {
  let tempRoot;

  beforeEach(async () => {
    tempRoot = await createWorkspace();
    await mkdir(path.join(tempRoot, 'src'), { recursive: true });
    await mkdir(path.join(tempRoot, 'tests'), { recursive: true });
    await writeFile(path.join(tempRoot, 'src', 'app.ts'), 'export const app = {}', 'utf-8');
    await writeFile(path.join(tempRoot, 'src', 'component.tsx'), 'export const C = () => null;', 'utf-8');
    await writeFile(path.join(tempRoot, 'src', 'util.js'), 'module.exports = {};', 'utf-8');
    await writeFile(path.join(tempRoot, 'tests', 'app.test.ts'), 'describe()', 'utf-8');
    await mkdir(path.join(tempRoot, 'node_modules'), { recursive: true });
    await writeFile(
      path.join(tempRoot, 'node_modules', 'ignored.js'),
      'should not be indexed',
      'utf-8',
    );
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('indexes default extensions and ignores ignored directories', async () => {
    const { files, summary } = await scanProjectFiles({ cwd: tempRoot });
    const normalized = files.map((file) => path.relative(tempRoot, file)).sort();
    expect(normalized).toEqual(
      ['src/app.ts', 'src/component.tsx', 'src/util.js', 'tests/app.test.ts'].sort(),
    );
    expect(summary.totalFiles).toBe(4);
    expect(summary.countsByLanguage).toMatchObject({
      javascript: 1,
      typescript: 3,
    });
    expect(summary.pattern.startsWith('**/*')).toBe(true);
  });

  it('supports custom extension filters', async () => {
    const { files, summary } = await scanProjectFiles({
      cwd: tempRoot,
      extensions: ['ts'],
    });
    expect(files.every((file) => file.endsWith('.ts'))).toBe(true);
    expect(summary.totalFiles).toBe(2);
  });
});

describe('detectLanguage', () => {
  it('returns known languages for mapped extensions', () => {
    expect(detectLanguage('/tmp/file.ts')).toBe('typescript');
    expect(detectLanguage('/tmp/file.jsx')).toBe('javascript');
    expect(detectLanguage('/tmp/file.py')).toBe('python');
  });

  it('falls back to unknown for unmapped extensions', () => {
    expect(detectLanguage('/tmp/file.unknown-ext')).toBe('unknown');
  });
});
