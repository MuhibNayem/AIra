import { describe, it, beforeAll, beforeEach, afterEach, expect, vi } from 'vitest';
import { promises as fs } from 'fs';

const metadataExports = {
  initializeMetadata: vi.fn(),
  readMetadata: vi.fn(),
  writeMetadata: vi.fn(),
  getDefaultIndexConfig: vi.fn(),
  createDefaultMetadata: vi.fn(),
  __internals: {
    resolveIndexRoot: vi.fn(),
    resolveMetadataPath: vi.fn(),
    SCHEMA_VERSION: 1,
  },
};

const telemetryMock = {
  write: vi.fn(),
};

const loggerMock = {
  info: vi.fn(),
  error: vi.fn(),
};

vi.mock('../../src/indexer/metadata.js', () => metadataExports);
vi.mock('../../src/utils/telemetry.js', () => ({
  telemetry: telemetryMock,
}));
vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => loggerMock,
}));
const scannerExports = {
  scanProjectFiles: vi.fn(),
  detectLanguage: vi.fn(),
};
vi.mock('../../src/indexer/scanner.js', () => scannerExports);
const storageExports = {
  ensureSchema: vi.fn(),
  recordFileScan: vi.fn(),
  upsertSymbols: vi.fn(),
};
vi.mock('../../src/indexer/storage/sqlite.js', () => storageExports);
const parserExports = {
  extractSymbols: vi.fn(),
};
vi.mock('../../src/indexer/parsers/index.js', () => parserExports);

describe('indexer CLI command handler', () => {
  let handleIndexCommand;
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeAll(async () => {
    ({ handleIndexCommand } = await import('../../src/indexer/index.js'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('returns missing status when metadata is absent', async () => {
    metadataExports.readMetadata.mockResolvedValueOnce(null);
    const result = await handleIndexCommand({
      command: 'status',
      options: { cwd: '/tmp/workspace' },
    });
    expect(result.status).toBe('missing');
    expect(result.exitCode).toBe(0);
    expect(metadataExports.readMetadata).toHaveBeenCalledWith('/tmp/workspace');
    expect(telemetryMock.write).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'start', type: 'index', command: 'status' }),
    );
  });

  it('returns configuration preview for config command', async () => {
    const fakeConfig = { indexRoot: '/tmp/workspace/.aira/index', features: {} };
    metadataExports.getDefaultIndexConfig.mockReturnValueOnce(fakeConfig);

    const result = await handleIndexCommand({
      command: 'config',
      options: { cwd: '/tmp/workspace' },
    });

    expect(result.status).toBe('ok');
    expect(result.config).toBe(fakeConfig);
    expect(metadataExports.getDefaultIndexConfig).toHaveBeenCalledWith('/tmp/workspace');
  });

  it('status renders metadata details when available', async () => {
    metadataExports.readMetadata.mockReset();
    metadataExports.readMetadata.mockResolvedValueOnce({
      schemaVersion: 1,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
      filesIndexed: 7,
      languages: ['python', 'go'],
      state: 'indexed',
      notes: 'ready',
      lastCommand: {
        type: 'build',
        at: '2024-01-02T00:00:00Z',
        options: { ext: 'ts' },
      },
      lastScan: {
        at: '2024-01-02T00:00:00Z',
        cwd: '/repo',
        totalFiles: 7,
        durationMs: 1200,
        extensions: ['.py', '.go'],
        pattern: '**/*.{py,go}',
        countsByLanguage: { python: 4, go: 3 },
        countsByExtension: { py: 4, go: 3 },
      },
    });

    const result = await handleIndexCommand({
      command: 'status',
      options: { cwd: '/repo' },
    });

    expect(result.status).toBe('ok');
    const loggedLines = consoleLogSpy.mock.calls.flat();
    expect(loggedLines.some((line) => `${line}`.includes('Index Status'))).toBe(true);
  });

  it('prunes index directory successfully', async () => {
    const indexRoot = '/tmp/workspace/.aira/index';
    metadataExports.__internals.resolveIndexRoot.mockReturnValueOnce(indexRoot);
    const rmSpy = vi.spyOn(fs, 'rm').mockResolvedValueOnce();

    const result = await handleIndexCommand({
      command: 'prune',
      options: { cwd: '/tmp/workspace' },
    });

    expect(result.status).toBe('removed');
    expect(result.exitCode).toBe(0);
    expect(rmSpy).toHaveBeenCalledWith(indexRoot, { recursive: true, force: true });
    rmSpy.mockRestore();
  });

  it('reports invalid command for unknown subcommands', async () => {
    const result = await handleIndexCommand({
      command: 'launch',
      options: {},
    });
    expect(result.status).toBe('invalid_command');
    expect(result.exitCode).toBe(1);
  });

  it('surfaces errors thrown during command execution', async () => {
    metadataExports.getDefaultIndexConfig.mockImplementationOnce(() => {
      throw new Error('config failure');
    });

    const result = await handleIndexCommand({
      command: 'config',
      options: {},
    });

    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(1);
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Index command failed.',
      expect.objectContaining({
        command: 'config',
        error: 'config failure',
      }),
    );
    metadataExports.getDefaultIndexConfig.mockReset();
  });

  it('build initializes metadata when index is absent', async () => {
    metadataExports.readMetadata.mockReset();
    metadataExports.initializeMetadata.mockReset();
    metadataExports.writeMetadata.mockReset();
    scannerExports.scanProjectFiles.mockReset();
    scannerExports.detectLanguage.mockReset();
    storageExports.ensureSchema.mockReset();
    storageExports.recordFileScan.mockReset();
    storageExports.upsertSymbols.mockReset();
    parserExports.extractSymbols.mockReset();

    metadataExports.__internals.resolveIndexRoot.mockReturnValue('/repo/.aira/index');
    metadataExports.__internals.resolveMetadataPath.mockReturnValue('/repo/.aira/index/metadata.json');
    metadataExports.readMetadata
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        persistence: { metadata: {}, vectors: {} },
        artifacts: {},
        lastScan: {},
        errors: [],
      });
    metadataExports.initializeMetadata.mockResolvedValueOnce({
      metadata: {
        persistence: { metadata: {}, vectors: {} },
        artifacts: {},
        lastScan: {},
        errors: [],
      },
      metadataPath: '/repo/.aira/index/metadata.json',
    });
    metadataExports.writeMetadata.mockResolvedValueOnce('/repo/.aira/index/metadata.json');

    scannerExports.scanProjectFiles.mockResolvedValueOnce({
      files: ['/repo/src/app.ts'],
      summary: {
        totalFiles: 1,
        countsByLanguage: { typescript: 1 },
        countsByExtension: { ts: 1 },
        pattern: '**/*.ts',
        extensions: ['.ts'],
        languages: ['typescript'],
      },
    });
    scannerExports.detectLanguage.mockReturnValue('typescript');

    storageExports.ensureSchema.mockResolvedValueOnce();
    storageExports.recordFileScan.mockResolvedValueOnce({
      scanId: 10,
      fileIdMap: { '/repo/src/app.ts': 1 },
    });
    storageExports.upsertSymbols.mockResolvedValueOnce({ inserted: 1 });

    parserExports.extractSymbols.mockResolvedValueOnce({
      symbols: [
        {
          id: 'symbol-app',
          name: 'app',
          kind: 'function',
          signature: 'function app()',
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 10 } },
          detail: { parameters: [] },
          properties: {},
        },
      ],
      relations: [],
      diagnostics: [],
    });

    const result = await handleIndexCommand({
      command: 'build',
      options: { cwd: '/repo', extensions: 'ts,tsx' },
    });

    expect(result.status).toBe('initialized');
    expect(storageExports.recordFileScan).toHaveBeenCalledWith(
      expect.objectContaining({
        indexRoot: '/repo/.aira/index',
        files: [{ path: '/repo/src/app.ts', language: 'typescript' }],
      }),
    );
    expect(storageExports.upsertSymbols).toHaveBeenCalled();
    expect(metadataExports.initializeMetadata).toHaveBeenCalled();
  });

  it('build updates existing metadata and records diagnostics', async () => {
    metadataExports.readMetadata.mockReset();
    metadataExports.writeMetadata.mockReset();
    metadataExports.createDefaultMetadata.mockReset();
    scannerExports.scanProjectFiles.mockReset();
    scannerExports.detectLanguage.mockReset();
    storageExports.ensureSchema.mockReset();
    storageExports.recordFileScan.mockReset();
    storageExports.upsertSymbols.mockReset();
    parserExports.extractSymbols.mockReset();

    metadataExports.__internals.resolveIndexRoot.mockReturnValue('/repo/.aira/index');
    metadataExports.__internals.resolveMetadataPath.mockReturnValue('/repo/.aira/index/metadata.json');
    const baseMetadata = {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      persistence: { metadata: {}, vectors: {} },
      artifacts: {},
      lastScan: {},
      errors: [],
    };
    metadataExports.readMetadata
      .mockResolvedValueOnce({ ...baseMetadata })
      .mockResolvedValueOnce({ ...baseMetadata });
    metadataExports.createDefaultMetadata.mockReturnValue({ ...baseMetadata });
    metadataExports.writeMetadata.mockResolvedValueOnce('/repo/.aira/index/metadata.json');

    scannerExports.scanProjectFiles.mockResolvedValueOnce({
      files: ['/repo/app.py'],
      summary: {
        totalFiles: 1,
        countsByLanguage: { python: 1 },
        countsByExtension: { py: 1 },
        pattern: '**/*.py',
        extensions: ['.py'],
        languages: ['python'],
      },
    });
    scannerExports.detectLanguage.mockReturnValue('python');

    storageExports.ensureSchema.mockResolvedValueOnce();
    storageExports.recordFileScan.mockResolvedValueOnce({
      scanId: 20,
      fileIdMap: { '/repo/app.py': 2 },
    });
    storageExports.upsertSymbols.mockResolvedValueOnce({ inserted: 1 });

    parserExports.extractSymbols.mockResolvedValueOnce({
      symbols: [
        {
          id: 'symbol-fetch',
          name: 'fetch',
          kind: 'function',
          signature: 'def fetch()',
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 10 } },
          detail: {},
          properties: {},
        },
      ],
      relations: [],
      diagnostics: [
        {
          severity: 'warning',
          message: 'minor issue',
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
        },
      ],
    });

    const result = await handleIndexCommand({
      command: 'build',
      options: { cwd: '/repo', extensions: ['py', 'go'] },
    });

    expect(result.status).toBe('updated');
    expect(storageExports.upsertSymbols).toHaveBeenCalled();
    expect(metadataExports.writeMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        lastScan: expect.objectContaining({
          symbolCount: 1,
          symbolDiagnostics: expect.any(Array),
        }),
      }),
      '/repo',
    );
  });

  it('build captures errors thrown during symbol extraction', async () => {
    metadataExports.readMetadata.mockReset();
    metadataExports.writeMetadata.mockReset();
    metadataExports.createDefaultMetadata.mockReset();
    scannerExports.scanProjectFiles.mockReset();
    scannerExports.detectLanguage.mockReset();
    storageExports.ensureSchema.mockReset();
    storageExports.recordFileScan.mockReset();
    storageExports.upsertSymbols.mockReset();
    parserExports.extractSymbols.mockReset();

    metadataExports.__internals.resolveIndexRoot.mockReturnValue('/repo/.aira/index');
    metadataExports.__internals.resolveMetadataPath.mockReturnValue('/repo/.aira/index/metadata.json');
    const baseMetadata = {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      persistence: { metadata: {}, vectors: {} },
      artifacts: {},
      lastScan: {},
      errors: [],
    };
    metadataExports.readMetadata
      .mockResolvedValueOnce({ ...baseMetadata })
      .mockResolvedValueOnce({ ...baseMetadata });
    metadataExports.createDefaultMetadata.mockReturnValue({ ...baseMetadata });
    metadataExports.writeMetadata.mockResolvedValueOnce('/repo/.aira/index/metadata.json');

    scannerExports.scanProjectFiles.mockResolvedValueOnce({
      files: ['/repo/app.js'],
      summary: {
        totalFiles: 1,
        countsByLanguage: { javascript: 1 },
        countsByExtension: { js: 1 },
        pattern: '**/*.js',
        extensions: ['.js'],
        languages: ['javascript'],
      },
    });
    scannerExports.detectLanguage.mockReturnValue('javascript');

    storageExports.ensureSchema.mockResolvedValueOnce();
    storageExports.recordFileScan.mockResolvedValueOnce({
      scanId: 30,
      fileIdMap: { '/repo/app.js': 3 },
    });
    storageExports.upsertSymbols.mockResolvedValueOnce({ inserted: 0 });

    parserExports.extractSymbols.mockRejectedValueOnce(new Error('parse fail'));

    const result = await handleIndexCommand({
      command: 'build',
      options: { cwd: '/repo', ext: 'js' },
    });

    expect(result.status).toBe('updated');
    expect(result.metadata.errors?.length).toBeGreaterThan(0);
    expect(storageExports.upsertSymbols).not.toHaveBeenCalled();
  });

  it('build handles empty scan results gracefully', async () => {
    metadataExports.readMetadata.mockReset();
    metadataExports.initializeMetadata.mockReset();
    metadataExports.writeMetadata.mockReset();
    scannerExports.scanProjectFiles.mockReset();
    scannerExports.detectLanguage.mockReset();
    storageExports.ensureSchema.mockReset();
    storageExports.recordFileScan.mockReset();
    storageExports.upsertSymbols.mockReset();
    parserExports.extractSymbols.mockReset();

    metadataExports.__internals.resolveIndexRoot.mockReturnValue('/repo/.aira/index');
    metadataExports.__internals.resolveMetadataPath.mockReturnValue('/repo/.aira/index/metadata.json');
    metadataExports.readMetadata
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        persistence: { metadata: {}, vectors: {} },
        artifacts: {},
        lastScan: {},
        errors: [],
      });
    metadataExports.initializeMetadata.mockResolvedValueOnce({
      metadata: {
        persistence: { metadata: {}, vectors: {} },
        artifacts: {},
        lastScan: {},
        errors: [],
      },
      metadataPath: '/repo/.aira/index/metadata.json',
    });
    metadataExports.writeMetadata.mockResolvedValueOnce('/repo/.aira/index/metadata.json');

    scannerExports.scanProjectFiles.mockResolvedValueOnce({
      files: [],
      summary: {
        totalFiles: 0,
        countsByLanguage: {},
        countsByExtension: {},
        pattern: '**/*',
        extensions: [],
        languages: [],
      },
    });
    storageExports.ensureSchema.mockResolvedValueOnce();
    storageExports.recordFileScan.mockResolvedValueOnce({
      scanId: 0,
      fileIdMap: {},
    });
    storageExports.upsertSymbols.mockResolvedValueOnce({ inserted: 0 });

    const result = await handleIndexCommand({
      command: 'build',
      options: { cwd: '/repo' },
    });

    expect(result.status).toBe('initialized');
    expect(result.summary.totalFiles).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('No files matched pattern'),
    );
  });

  it('build records scan failure when persistence fails', async () => {
    metadataExports.readMetadata.mockReset();
    metadataExports.writeMetadata.mockReset();
    metadataExports.createDefaultMetadata.mockReset();
    scannerExports.scanProjectFiles.mockReset();
    scannerExports.detectLanguage.mockReset();
    storageExports.ensureSchema.mockReset();
    storageExports.recordFileScan.mockReset();
    storageExports.upsertSymbols.mockReset();
    parserExports.extractSymbols.mockReset();

    metadataExports.__internals.resolveIndexRoot.mockReturnValue('/repo/.aira/index');
    metadataExports.__internals.resolveMetadataPath.mockReturnValue('/repo/.aira/index/metadata.json');
    const baseMetadata = {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      persistence: { metadata: {}, vectors: {} },
      artifacts: {},
      lastScan: {},
      errors: [],
    };
    metadataExports.readMetadata
      .mockResolvedValueOnce({ ...baseMetadata })
      .mockResolvedValueOnce({ ...baseMetadata });
    metadataExports.createDefaultMetadata.mockReturnValue({ ...baseMetadata });
    metadataExports.writeMetadata.mockResolvedValueOnce('/repo/.aira/index/metadata.json');

    scannerExports.scanProjectFiles.mockResolvedValueOnce({
      files: ['/repo/app.go'],
      summary: {
        totalFiles: 1,
        countsByLanguage: { go: 1 },
        countsByExtension: { go: 1 },
        pattern: '**/*.go',
        extensions: ['.go'],
        languages: ['go'],
      },
    });
    scannerExports.detectLanguage.mockReturnValue('go');
    storageExports.ensureSchema.mockResolvedValueOnce();
    storageExports.recordFileScan.mockRejectedValueOnce(new Error('sqlite failure'));
    parserExports.extractSymbols.mockResolvedValueOnce({
      symbols: [],
      relations: [],
      diagnostics: [],
    });

    const result = await handleIndexCommand({
      command: 'build',
      options: { cwd: '/repo' },
    });

    expect(result.status).toBe('updated');
    expect(result.metadata.errors?.some((entry) => entry.message.includes('sqlite failure'))).toBe(true);
    expect(storageExports.upsertSymbols).not.toHaveBeenCalled();
  });

  it('build records symbol insertion errors', async () => {
    metadataExports.readMetadata.mockReset();
    metadataExports.writeMetadata.mockReset();
    metadataExports.createDefaultMetadata.mockReset();
    scannerExports.scanProjectFiles.mockReset();
    scannerExports.detectLanguage.mockReset();
    storageExports.ensureSchema.mockReset();
    storageExports.recordFileScan.mockReset();
    storageExports.upsertSymbols.mockReset();
    parserExports.extractSymbols.mockReset();

    metadataExports.__internals.resolveIndexRoot.mockReturnValue('/repo/.aira/index');
    metadataExports.__internals.resolveMetadataPath.mockReturnValue('/repo/.aira/index/metadata.json');
    const baseMetadata = {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      persistence: { metadata: {}, vectors: {} },
      artifacts: {},
      lastScan: {},
      errors: [],
    };
    metadataExports.readMetadata
      .mockResolvedValueOnce({ ...baseMetadata })
      .mockResolvedValueOnce({ ...baseMetadata });
    metadataExports.createDefaultMetadata.mockReturnValue({ ...baseMetadata });
    metadataExports.writeMetadata.mockResolvedValueOnce('/repo/.aira/index/metadata.json');

    scannerExports.scanProjectFiles.mockResolvedValueOnce({
      files: ['/repo/src/app.ts'],
      summary: {
        totalFiles: 1,
        countsByLanguage: { typescript: 1 },
        countsByExtension: { ts: 1 },
        pattern: '**/*.ts',
        extensions: ['.ts'],
        languages: ['typescript'],
      },
    });
    scannerExports.detectLanguage.mockReturnValue('typescript');
    storageExports.ensureSchema.mockResolvedValueOnce();
    storageExports.recordFileScan.mockResolvedValueOnce({
      scanId: 50,
      fileIdMap: { '/repo/src/app.ts': 1 },
    });
    storageExports.upsertSymbols.mockRejectedValueOnce(new Error('insert fail'));
    parserExports.extractSymbols.mockResolvedValueOnce({
      symbols: [
        {
          id: 'symbol-main',
          name: 'main',
          kind: 'function',
          signature: 'function main()',
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 10 } },
          detail: {},
          properties: {},
        },
      ],
      relations: [
        {
          type: 'belongs_to',
          sourceId: 'symbol-main',
          targetId: 'symbol-main',
          properties: { role: 'self' },
        },
      ],
      diagnostics: [],
    });

    const result = await handleIndexCommand({
      command: 'build',
      options: { cwd: '/repo' },
    });

    expect(result.status).toBe('updated');
    expect(result.metadata.errors?.some((entry) => entry.message.includes('symbol-insert'))).toBe(true);
  });

  it('build handles symbol insert errors during initialization', async () => {
    metadataExports.readMetadata.mockReset();
    metadataExports.initializeMetadata.mockReset();
    metadataExports.writeMetadata.mockReset();
    scannerExports.scanProjectFiles.mockReset();
    scannerExports.detectLanguage.mockReset();
    storageExports.ensureSchema.mockReset();
    storageExports.recordFileScan.mockReset();
    storageExports.upsertSymbols.mockReset();
    parserExports.extractSymbols.mockReset();

    metadataExports.__internals.resolveIndexRoot.mockReturnValue('/repo/.aira/index');
    metadataExports.__internals.resolveMetadataPath.mockReturnValue('/repo/.aira/index/metadata.json');
    metadataExports.readMetadata
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        persistence: { metadata: {}, vectors: {} },
        artifacts: {},
        lastScan: {},
        errors: [],
      });
    metadataExports.initializeMetadata.mockResolvedValueOnce({
      metadata: {
        persistence: { metadata: {}, vectors: {} },
        artifacts: {},
        lastScan: {},
        errors: [],
      },
      metadataPath: '/repo/.aira/index/metadata.json',
    });
    metadataExports.writeMetadata.mockResolvedValueOnce('/repo/.aira/index/metadata.json');

    scannerExports.scanProjectFiles.mockResolvedValueOnce({
      files: ['/repo/src/main.java'],
      summary: {
        totalFiles: 1,
        countsByLanguage: { java: 1 },
        countsByExtension: { java: 1 },
        pattern: '**/*.java',
        extensions: ['.java'],
        languages: ['java'],
      },
    });
    scannerExports.detectLanguage.mockReturnValue('java');
    storageExports.ensureSchema.mockResolvedValueOnce();
    storageExports.recordFileScan.mockResolvedValueOnce({
      scanId: 70,
      fileIdMap: { '/repo/src/main.java': 4 },
    });
    storageExports.upsertSymbols.mockRejectedValueOnce(new Error('init insert fail'));
    parserExports.extractSymbols.mockResolvedValueOnce({
      symbols: [
        {
          id: 'symbol-main',
          name: 'main',
          kind: 'function',
          signature: 'public static void main(String[] args)',
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 10 } },
          detail: {},
          properties: {},
        },
      ],
      relations: [
        {
          type: 'belongs_to',
          sourceId: 'symbol-main',
          targetId: 'symbol-main',
          properties: { role: 'static' },
        },
      ],
      diagnostics: [],
    });

    const result = await handleIndexCommand({
      command: 'build',
      options: { cwd: '/repo', extensions: ['java'] },
    });

    expect(result.status).toBe('initialized');
    const writtenMetadata = metadataExports.writeMetadata.mock.calls[0]?.[0];
    expect(
      writtenMetadata?.errors?.some((entry) => entry.message.includes('init insert fail')),
    ).toBe(true);
  });

  it('watch command reports pending status', async () => {
    const result = await handleIndexCommand({
      command: 'watch',
      options: {},
    });
    expect(result.status).toBe('not_implemented');
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Index command "watch" is not yet implemented'),
    );
  });

  it('prune surfaces filesystem errors', async () => {
    metadataExports.__internals.resolveIndexRoot.mockReturnValueOnce('/repo/.aira/index');
    const rmSpy = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('permission denied'));

    const result = await handleIndexCommand({
      command: 'prune',
      options: { cwd: '/repo' },
    });

    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to prune index directory'),
    );
    rmSpy.mockRestore();
  });
});
