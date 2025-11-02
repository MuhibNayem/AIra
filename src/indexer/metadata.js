import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { IGNORED_GLOB_PATTERNS } from '../utils/ignore.js';
import { __internals as scannerInternals } from './scanner.js';

const INDEX_DIRECTORY = path.join('.aira', 'index');
const METADATA_FILENAME = 'metadata.json';
const SCHEMA_VERSION = 1;

const resolveIndexRoot = (cwd = process.cwd()) => path.resolve(cwd, INDEX_DIRECTORY);
const resolveMetadataPath = (cwd = process.cwd()) =>
  path.join(resolveIndexRoot(cwd), METADATA_FILENAME);

const ensureDirectory = async (targetPath) => {
  await fs.mkdir(targetPath, { recursive: true });
};

const parseEnvList = (value) =>
  value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];

export const createDefaultMetadata = (overrides = {}, cwd = process.cwd()) => {
  const timestamp = new Date().toISOString();
  const config = getDefaultIndexConfig(cwd);
  const metadataPath = resolveMetadataPath(cwd);
  const readRoots =
    parseEnvList(process.env.AIRA_FS_READ_ROOTS || '').map((entry) => path.resolve(entry));
  const writeRoots =
    parseEnvList(process.env.AIRA_FS_WRITE_ROOTS || '').map((entry) => path.resolve(entry));
  if (!readRoots.length) {
    readRoots.push(path.resolve(cwd));
  }
  if (!writeRoots.length) {
    writeRoots.push(path.resolve(cwd));
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    filesIndexed: 0,
    languages: [],
    state: 'initialized',
    notes: 'Index scaffold created. Run indexing pipelines to populate symbol and embedding data.',
    resources: {
      maxWorkers: config.resources.maxWorkers,
      maxMemoryMb: config.resources.maxMemoryMb,
      diskBudgetMb: 2048,
    },
    persistence: {
      metadata: {
        driver: 'sqlite',
        path: path.join(config.indexRoot, 'index.db'),
        status: 'pending',
      },
      vectors: {
        driver: 'chroma',
        path: path.join(config.indexRoot, 'chroma'),
        status: 'pending',
      },
    },
    acl: {
      enforced: true,
      readRoots,
      writeRoots,
    },
    parsers: {
      python: { strategy: 'tree-sitter', status: 'pending' },
      java: { strategy: 'jdt+lsp', status: 'pending' },
      javascript: { strategy: 'tree-sitter', status: 'pending' },
      typescript: { strategy: 'tree-sitter', status: 'pending' },
      go: { strategy: 'tree-sitter', status: 'pending' },
    },
    artifacts: {
      metadataPath,
      indexRoot: config.indexRoot,
    },
    errors: [],
    ...overrides,
  };
};

export const readMetadata = async (cwd = process.cwd()) => {
  const metadataPath = resolveMetadataPath(cwd);
  try {
    const raw = await fs.readFile(metadataPath, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to read index metadata: ${error.message}`);
  }
};

export const writeMetadata = async (metadata, cwd = process.cwd()) => {
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('writeMetadata expects a metadata object.');
  }
  const indexRoot = resolveIndexRoot(cwd);
  await ensureDirectory(indexRoot);
  const metadataPath = resolveMetadataPath(cwd);
  const payload = JSON.stringify(
    {
      ...metadata,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  );
  await fs.writeFile(metadataPath, `${payload}\n`, 'utf-8');
  return metadataPath;
};

export const initializeMetadata = async (overrides = {}, cwd = process.cwd()) => {
  const metadata = createDefaultMetadata(overrides, cwd);
  const metadataPath = await writeMetadata(metadata, cwd);
  const stored = (await readMetadata(cwd)) ?? metadata;
  return { metadata: stored, metadataPath };
};

export const getDefaultIndexConfig = (cwd = process.cwd()) => {
  const indexRoot = resolveIndexRoot(cwd);
  return {
    indexRoot,
    metadataPath: resolveMetadataPath(cwd),
    schemaVersion: SCHEMA_VERSION,
    supportedLanguages: [],
    defaultExtensions: scannerInternals.DEFAULT_EXTENSIONS,
    ignoreGlobs: IGNORED_GLOB_PATTERNS,
    features: {
      symbolIndex: false,
      embeddings: false,
      ownership: false,
    },
    watch: {
      enabled: false,
      debounceMs: 1500,
    },
    resources: {
      maxWorkers: Math.max(1, os.cpus()?.length ?? 1),
      maxMemoryMb: 1024,
    },
  };
};

export const __internals = {
  resolveIndexRoot,
  resolveMetadataPath,
  SCHEMA_VERSION,
};
