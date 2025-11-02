import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  ensureSchema,
  recordFileScan,
  listFiles,
  listScans,
  upsertSymbols,
  listSymbols,
  __internals,
} from '../../src/indexer/storage/sqlite.js';

const createTempRoot = () => mkdtemp(path.join(os.tmpdir(), 'aira-index-sqlite-'));

describe('sqlite storage', () => {
  let tempRoot;
  let indexRoot;

  beforeEach(async () => {
    tempRoot = await createTempRoot();
    indexRoot = path.join(tempRoot, '.aira', 'index');
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('creates schema and stores scan/file entries', async () => {
    await ensureSchema(indexRoot);
    const startedAt = new Date().toISOString();
    const completedAt = startedAt;
    const files = [
      { path: path.join(tempRoot, 'src', 'app.ts'), language: 'typescript' },
      { path: path.join(tempRoot, 'src', 'main.py'), language: 'python' },
    ];
    const summary = {
      totalFiles: files.length,
      pattern: '**/*.{ts,py}',
      durationMs: 12,
    };

    const { scanId, fileIdMap } = await recordFileScan({
      indexRoot,
      summary,
      files,
      startedAt,
      completedAt,
    });

    expect(scanId).toBeGreaterThan(0);
    expect(Object.keys(fileIdMap)).toHaveLength(files.length);

    const storedFiles = await listFiles(indexRoot);
    expect(storedFiles.length).toBe(2);
    expect(storedFiles.map((row) => row.language).sort()).toEqual(['python', 'typescript']);
    expect(storedFiles.every((row) => row.lastScanId === scanId)).toBe(true);

    const scans = await listScans(indexRoot);
    expect(scans[0]).toMatchObject({
      id: scanId,
      totalFiles: files.length,
      pattern: summary.pattern,
    });

    await upsertSymbols({
      indexRoot,
      scanId,
      symbols: [
        {
          filePath: files[0].path,
          name: 'main',
          kind: 'function',
          line: 1,
          signature: 'function main()',
        },
      ],
      fileIdMap,
    });

    const symbols = await listSymbols(indexRoot);
    expect(symbols.length).toBe(1);
    expect(symbols[0]).toMatchObject({
      filePath: files[0].path,
      name: 'main',
      kind: 'function',
    });

    await upsertSymbols({
      indexRoot,
      scanId,
      symbols: [
        {
          filePath: files[0].path,
          name: 'main',
          kind: 'function',
          line: 2,
          signature: 'function main(args)',
        },
      ],
      fileIdMap,
    });

    const deduped = await listSymbols(indexRoot);
    expect(deduped.length).toBe(1);
    expect(deduped[0]).toMatchObject({
      filePath: files[0].path,
      name: 'main',
      line: 2,
    });
  });

  it('exposes db helper internals', async () => {
    await ensureSchema(indexRoot);
    const dbPath = __internals.getDbPath(indexRoot);
    const result = await __internals.runJsonQuery(dbPath, 'SELECT COUNT(*) AS c FROM files');
    expect(result).toEqual([{ c: 0 }]);
  });
});
