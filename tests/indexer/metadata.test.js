import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  createDefaultMetadata,
  initializeMetadata,
  readMetadata,
  writeMetadata,
  getDefaultIndexConfig,
  __internals,
} from '../../src/indexer/metadata.js';
import { __internals as scannerInternals } from '../../src/indexer/scanner.js';
import { IGNORED_GLOB_PATTERNS } from '../../src/utils/ignore.js';

const createTempRoot = () => mkdtemp(path.join(os.tmpdir(), 'aira-index-'));

describe('indexer metadata helpers', () => {
  let tempRoot;

  beforeEach(async () => {
    tempRoot = await createTempRoot();
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('creates default metadata with expected shape', () => {
    const metadata = createDefaultMetadata({}, tempRoot);
    expect(metadata).toMatchObject({
      schemaVersion: __internals.SCHEMA_VERSION,
      filesIndexed: 0,
      languages: [],
      state: 'initialized',
      resources: {
        maxWorkers: expect.any(Number),
        maxMemoryMb: expect.any(Number),
        diskBudgetMb: expect.any(Number),
      },
      persistence: {
        metadata: expect.objectContaining({ driver: 'sqlite', status: 'pending' }),
        vectors: expect.objectContaining({ driver: 'chroma', status: 'pending' }),
      },
      acl: expect.objectContaining({
        enforced: true,
        readRoots: expect.any(Array),
        writeRoots: expect.any(Array),
      }),
      parsers: expect.any(Object),
    });
    expect(typeof metadata.createdAt).toBe('string');
    expect(typeof metadata.updatedAt).toBe('string');
    expect(metadata.resources.maxWorkers).toBeGreaterThanOrEqual(1);
    expect(metadata.acl.readRoots.length).toBeGreaterThan(0);
  });

  it('initializes metadata on disk', async () => {
    const { metadataPath, metadata } = await initializeMetadata({}, tempRoot);
    expect(metadataPath).toBeDefined();
    const stored = await readMetadata(tempRoot);
    expect(stored).not.toBeNull();
    expect(stored.schemaVersion).toBe(__internals.SCHEMA_VERSION);
    expect(stored.createdAt).toBe(metadata.createdAt);
  });

  it('updates metadata while preserving createdAt', async () => {
    const { metadata } = await initializeMetadata({}, tempRoot);
    const updated = { ...metadata, filesIndexed: 42, languages: ['javascript'] };
    await writeMetadata(updated, tempRoot);
    const stored = await readMetadata(tempRoot);
    expect(stored.filesIndexed).toBe(42);
    expect(stored.languages).toEqual(['javascript']);
    expect(stored.createdAt).toBe(metadata.createdAt);
    expect(stored.schemaVersion).toBe(__internals.SCHEMA_VERSION);
  });

  it('returns null metadata when index is absent', async () => {
    const otherRoot = await createTempRoot();
    try {
      const stored = await readMetadata(otherRoot);
      expect(stored).toBeNull();
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('exposes default configuration aligned with project root', () => {
    const config = getDefaultIndexConfig(tempRoot);
    expect(config.indexRoot.startsWith(path.resolve(tempRoot))).toBe(true);
    expect(config.metadataPath.endsWith('metadata.json')).toBe(true);
    expect(config.schemaVersion).toBe(__internals.SCHEMA_VERSION);
    expect(config.defaultExtensions).toEqual(scannerInternals.DEFAULT_EXTENSIONS);
    expect(config.ignoreGlobs).toEqual(IGNORED_GLOB_PATTERNS);
  });
});
